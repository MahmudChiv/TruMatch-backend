import {
  Injectable,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { decryptToken } from './crypto.util';

const REDIS_METRICS_TTL = 60 * 60;   // 1 hour in seconds
const MAX_REPOS = 10;                  // cap: 10 most-recently-active qualifying repos
const MIN_REPO_SIZE_KB = 50;
const MIN_COMMITS = 3;
const PER_REPO_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 10_000;    // 10 s per HTTP call

export const REDIS_CLIENT = 'REDIS_CLIENT';

// ─── GraphQL query ─────────────────────────────────────────────────────────
// ONE network round-trip per repo: commits + PRs + issues fetched simultaneously.
// In GitHub GraphQL, `issues` and `pullRequests` are separate connections, so
// no need to filter out PRs from issues (unlike the REST /issues endpoint).
const REPO_SIGNALS_QUERY = `
  query RepoSignals($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 100) {
              nodes {
                committedDate
              }
            }
          }
        }
      }
      pullRequests(first: 100, states: [OPEN, CLOSED, MERGED]) {
        nodes {
          state
          mergedAt
        }
      }
      issues(first: 100, states: [OPEN, CLOSED]) {
        nodes {
          state
        }
      }
    }
  }
`;

// ─── GraphQL response types ─────────────────────────────────────────────────
interface RepoGraphQLData {
  repository: {
    defaultBranchRef: {
      target: {
        history: {
          nodes: Array<{ committedDate: string }>;
        };
      };
    } | null;
    pullRequests: {
      nodes: Array<{ state: string; mergedAt: string | null }>;
    };
    issues: {
      nodes: Array<{ state: string }>;
    };
  } | null;
}

// Typed graphql client created per-request with the user's token
type GraphqlClient = (query: string, variables?: Record<string, unknown>) => Promise<RepoGraphQLData>;

// ─── Public types ───────────────────────────────────────────────────────────
export interface RepoSignals {
  name: string;
  fullName: string;
  commitGapConsistency: number; // 0-1, higher = more consistent cadence
  prMergeRatio: number;         // 0-1
  issueCloseRatio: number;      // 0-1
  completionSignal: number;     // 0-1, higher = completed vs abandoned
  repoScore: number;            // weighted composite 0-100
}

export interface GithubSyncResult {
  githubConsistencyScore: number;
  repoBreakdown: RepoSignals[];
}

// ─── Service ────────────────────────────────────────────────────────────────
@Injectable()
export class GithubSyncService {
  private readonly logger = new Logger(GithubSyncService.name);

  constructor(
    @InjectQueue('github-sync') private readonly syncQueue: Queue,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) { }

  /**
   * Enqueue a GitHub sync job for the given user.
   * Returns immediately with { status: 'queued' }.
   */
  async enqueueSync(userId: string): Promise<{ status: 'queued' }> {
    await this.prisma.githubMetrics.upsert({
      where: { userId },
      create: { userId, status: 'pending' },
      update: { status: 'pending', errorReason: null },
    });

    await this.syncQueue.add(
      'sync-user',
      { userId },
      {
        jobId: `github-sync-${userId}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    this.logger.log(`Queued github-sync job for user ${userId}`);
    return { status: 'queued' };
  }

  /**
   * Full GitHub data-fetch + scoring pipeline.
   * Called by the BullMQ processor — runs in the background worker.
   */
  async processSyncJob(userId: string): Promise<GithubSyncResult> {
    console.log('🔥 [SERVICE] processSyncJob() called for user:', userId);
    this.logger.log(`Processing github-sync job for user ${userId}`);

    await this.prisma.githubMetrics.upsert({
      where: { userId },
      create: { userId, status: 'processing' },
      update: { status: 'processing' },
    });

    // ── Fetch + decrypt token ───────────────────────────────────────────────
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.githubAccessToken) {
      throw new Error('No GitHub access token found for user');
    }

    let plainToken: string;
    try {
      plainToken = decryptToken(user.githubAccessToken);
    } catch {
      throw new Error('Failed to decrypt GitHub access token');
    }

    // REST client (used only for repo listing — one paginate call)
    const octokit = new Octokit({
      auth: plainToken,
      request: { timeout: REQUEST_TIMEOUT_MS },
    });

    // GraphQL client — one instance shared across all per-repo queries
    const graphqlWithAuth = graphql.defaults({
      headers: { authorization: `token ${plainToken}` },
      request: { timeout: REQUEST_TIMEOUT_MS },
    }) as unknown as GraphqlClient;

    // ── 1. Fetch repo list via REST (single paginate — repos are lightweight) ─
    const allRepos = await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
      affiliation: 'owner',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });

    this.logger.log(`Fetched ${allRepos.length} total repos for user ${userId}`);

    // ── 2. Filter forks + tiny scaffolds, cap to 10 ─────────────────────────
    const repos = allRepos
      .filter((r) => !r.fork && (r.size ?? 0) >= MIN_REPO_SIZE_KB)
      .slice(0, MAX_REPOS);

    this.logger.log(`${repos.length} repos after filtering for user ${userId}`);

    // ── 3. Per-repo GraphQL fetch — p-limit(5) concurrency ──────────────────
    // Each GraphQL call fetches commits + PRs + issues in ONE round trip.
    // This replaces 3 sequential REST paginate() calls per repo.
    const { default: pLimit } = await import('p-limit');
    const limit = pLimit(PER_REPO_CONCURRENCY);

    const repoSignalsRaw = await Promise.all(
      repos.map((repo) =>
        limit(() => this.fetchRepoSignalsViaGraphQL(graphqlWithAuth, repo)),
      ),
    );

    const repoSignals = repoSignalsRaw.filter(
      (s): s is RepoSignals => s !== null,
    );

    if (repoSignals.length === 0) {
      throw new Error('No qualifying repositories found after filtering');
    }

    // ── 4. Aggregate ─────────────────────────────────────────────────────────
    const githubConsistencyScore = this.aggregateScore(repoSignals);
    const result: GithubSyncResult = { githubConsistencyScore, repoBreakdown: repoSignals };

    // ── 5. Persist ───────────────────────────────────────────────────────────
    await this.prisma.githubMetrics.upsert({
      where: { userId },
      create: { userId, status: 'complete', githubConsistencyScore, repoBreakdown: repoSignals as any },
      update: { status: 'complete', githubConsistencyScore, repoBreakdown: repoSignals as any, errorReason: null },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { commitmentScore: githubConsistencyScore },
    });

    // ── 6. Cache in Redis ─────────────────────────────────────────────────────
    await this.redis.setex(`github_metrics:${userId}`, REDIS_METRICS_TTL, JSON.stringify(result));

    this.logger.log(
      `GitHub sync complete for user ${userId} — score: ${githubConsistencyScore.toFixed(2)}`,
    );

    return result;
  }

  /**
   * Mark a sync as failed and persist the error reason.
   */
  async markFailed(userId: string, reason: string): Promise<void> {
    this.logger.error(`GitHub sync failed for user ${userId}: ${reason}`);
    await this.prisma.githubMetrics.upsert({
      where: { userId },
      create: { userId, status: 'failed', errorReason: reason },
      update: { status: 'failed', errorReason: reason },
    });
  }

  /**
   * Retrieve the current status of a user's GitHub sync job.
   */
  async getSyncStatus(userId: string) {
    return this.prisma.githubMetrics.findUnique({
      where: { userId },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — per-repo GraphQL fetch
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * ONE GraphQL request per repo fetches commits, PRs, and issues simultaneously.
   * Replaces 3 sequential paginate() calls — order-of-magnitude faster per repo.
   */
  private async fetchRepoSignalsViaGraphQL(
    graphqlWithAuth: GraphqlClient,
    repo: { name: string; full_name: string; owner: { login: string } },
  ): Promise<RepoSignals | null> {
    const owner = repo.owner.login;
    const repoName = repo.name;

    try {
      const data = await graphqlWithAuth(REPO_SIGNALS_QUERY, { owner, repo: repoName });

      if (!data.repository) return null;

      const { defaultBranchRef, pullRequests, issues } = data.repository;

      // Commits from the default branch (most recent 100)
      const commits = defaultBranchRef?.target?.history?.nodes ?? [];
      if (commits.length < MIN_COMMITS) return null;

      // Compute signals
      // Note: GraphQL states are UPPERCASE (OPEN/CLOSED/MERGED) unlike REST (lowercase)
      const commitGapConsistency = this.computeCommitGapConsistency(commits);
      const prMergeRatio = this.computePrMergeRatio(pullRequests.nodes);
      const issueCloseRatio = this.computeIssueCloseRatio(issues.nodes);
      const completionSignal = this.computeCompletionSignal(commits);

      const repoScore =
        (commitGapConsistency * 0.35 +
          prMergeRatio * 0.25 +
          issueCloseRatio * 0.2 +
          completionSignal * 0.2) * 100;

      return {
        name: repoName,
        fullName: repo.full_name,
        commitGapConsistency,
        prMergeRatio,
        issueCloseRatio,
        completionSignal,
        repoScore: Math.round(repoScore * 100) / 100,
      };
    } catch (err) {
      this.logger.warn(`Skipping repo ${repo.full_name}: ${(err as Error).message}`);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private — scoring helpers (updated for GraphQL response shapes)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Commit gap consistency: 1 - (coefficient of variation of inter-commit gaps).
   * GraphQL returns committedDate directly — no nested commit.author.date.
   */
  private computeCommitGapConsistency(
    commits: Array<{ committedDate: string }>,
  ): number {
    if (commits.length < 2) return 0;

    const dates = commits
      .map((c) => new Date(c.committedDate).getTime())
      .sort((a, b) => a - b);

    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(dates[i] - dates[i - 1]);
    }

    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean === 0) return 0;

    const variance = gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gaps.length;
    const stdDev = Math.sqrt(variance);
    const cov = stdDev / mean;

    return Math.max(0, 1 - Math.min(cov, 2) / 2);
  }

  /**
   * PR merge ratio.
   * GraphQL state is 'MERGED' (not merged_at presence check).
   */
  private computePrMergeRatio(
    prs: Array<{ state: string; mergedAt?: string | null }>,
  ): number {
    if (prs.length === 0) return 0.5;
    const merged = prs.filter((p) => p.state === 'MERGED').length;
    return merged / prs.length;
  }

  /**
   * Issue close ratio.
   * GraphQL state is 'CLOSED' (uppercase) — no pull_request field needed since
   * GitHub GraphQL issues and pullRequests are separate connections.
   */
  private computeIssueCloseRatio(issues: Array<{ state: string }>): number {
    if (issues.length === 0) return 0.5;
    const closed = issues.filter((i) => i.state === 'CLOSED').length;
    return closed / issues.length;
  }

  /**
   * Completion signal heuristic (unchanged logic, updated input type).
   * - Repo active < 6 months ago → 1.0 (still going / recently wrapped)
   * - Final 10% of lifespan has ≥ 20% of commits → 0.8 (wound down gracefully)
   * - Otherwise → 0.3 (looks abandoned mid-project)
   */
  private computeCompletionSignal(
    commits: Array<{ committedDate: string }>,
  ): number {
    if (commits.length < 2) return 0.5;

    const dates = commits
      .map((c) => new Date(c.committedDate).getTime())
      .sort((a, b) => a - b);

    const first = dates[0];
    const last = dates[dates.length - 1];
    const lifespan = last - first;

    const sixMonthsAgo = Date.now() - 180 * 24 * 60 * 60 * 1000;
    if (last >= sixMonthsAgo) return 1.0;

    if (lifespan === 0) return 0.5;

    const windowStart = first + lifespan * 0.9;
    const commitsInWindow = dates.filter((d) => d >= windowStart).length;
    return commitsInWindow / commits.length >= 0.2 ? 0.8 : 0.3;
  }

  /**
   * Simple mean of per-repo scores → final 0–100 commitment score.
   */
  private aggregateScore(signals: RepoSignals[]): number {
    if (signals.length === 0) return 0;
    const total = signals.reduce((sum, s) => sum + s.repoScore, 0);
    return Math.round((total / signals.length) * 100) / 100;
  }
}
