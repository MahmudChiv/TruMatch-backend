import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface GithubProfileData {
  githubId: string;
  username: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  bio?: string;
}

/** Shape for PATCH /users/me/profile */
export interface UpdateProfileDto {
  contextNote?: string | null;    // User-authored note, does NOT affect score
  bio?: string | null;            // GitHub bio (editable)
}

/** Shape for GET /users/:id/profile (public view) */
export interface PublicProfile {
  username: string;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  bioSummary: string | null;         // From interview — separate from GitHub bio
  contextNote: string | null;
  commitmentScore: {
    score: number;
    githubScore: number;
    interviewScore: number;
    appliedGithubWeight: number;
    appliedInterviewWeight: number;
    scoreExplanationSummary: string | null;
  } | null;
  githubConfidence: string;           // 'high' | 'low' | 'insufficient'
  githubConfidenceLabel: string;      // Human-readable label
  peerRating: null;                   // Placeholder for future Rating module
}

/**
 * Maps a GitHub confidence tier to a human-readable label for the public profile.
 * Shown plainly — not hidden.
 */
function getConfidenceLabel(confidence: string): string {
  switch (confidence) {
    case 'high':
      return 'Strong GitHub history';
    case 'low':
      return 'New developer — limited GitHub history';
    case 'insufficient':
      return 'Not enough GitHub history yet to compute this signal';
    default:
      return 'GitHub history not available';
  }
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreateFromGithub(profile: GithubProfileData) {
    return this.prisma.user.upsert({
      where: { githubId: profile.githubId },
      update: {
        username: profile.username,
        email: profile.email ?? undefined,
        name: profile.name ?? undefined,
        avatarUrl: profile.avatarUrl ?? undefined,
        bio: profile.bio ?? undefined,
      },
      create: {
        githubId: profile.githubId,
        username: profile.username,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        bio: profile.bio,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async findByGithubId(githubId: string) {
    return this.prisma.user.findUnique({
      where: { githubId },
    });
  }

  async updateGithubToken(userId: string, encryptedToken: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { githubAccessToken: encryptedToken },
    });
  }

  /**
   * Update the user's editable profile fields.
   * contextNote: user-authored note shown on public profile — does NOT affect score.
   * bio: the user's GitHub-style bio (editable after onboarding).
   */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const data: Record<string, unknown> = {};
    if (dto.contextNote !== undefined) data.contextNote = dto.contextNote;
    if (dto.bio !== undefined) data.bio = dto.bio;

    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        username: true,
        name: true,
        avatarUrl: true,
        bio: true,
        contextNote: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Fetch the public profile for a user by ID.
   * Shows: bio, commitment score with breakdown, GitHub confidence tier,
   * context note, and (later) aggregate peer rating.
   */
  async getPublicProfile(userId: string): Promise<PublicProfile | null> {
    const [user, commitmentScore, githubMetrics, interviewSession] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          username: true,
          name: true,
          avatarUrl: true,
          bio: true,
          contextNote: true,
        },
      }),
      this.prisma.commitmentScore.findUnique({
        where: { userId },
        select: {
          commitmentScore: true,
          githubScore: true,
          interviewScore: true,
          appliedGithubWeight: true,
          appliedInterviewWeight: true,
          scoreExplanationSummary: true,
        },
      }),
      this.prisma.githubMetrics.findUnique({
        where: { userId },
        select: {
          githubConfidence: true,
        },
      }),
      this.prisma.interviewSession.findUnique({
        where: { userId },
        select: {
          bioSummary: true,
        },
      }),
    ]);

    if (!user) return null;

    const confidence = githubMetrics?.githubConfidence ?? 'insufficient';

    return {
      username: user.username,
      name: user.name,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      bioSummary: interviewSession?.bioSummary ?? null,
      contextNote: user.contextNote,
      commitmentScore: commitmentScore
        ? {
            score: commitmentScore.commitmentScore,
            githubScore: commitmentScore.githubScore,
            interviewScore: commitmentScore.interviewScore,
            appliedGithubWeight: commitmentScore.appliedGithubWeight,
            appliedInterviewWeight: commitmentScore.appliedInterviewWeight,
            scoreExplanationSummary: commitmentScore.scoreExplanationSummary,
          }
        : null,
      githubConfidence: confidence,
      githubConfidenceLabel: getConfidenceLabel(confidence),
      peerRating: null, // Placeholder — will be populated when Rating module exists
    };
  }

  /**
   * Aggregates all dashboard data for a user in a single DB round-trip.
   * Each section is returned independently so the frontend can handle
   * partial availability (e.g. interview not yet done).
   */
  async getDashboardData(userId: string) {
    const [user, commitmentScore, githubMetrics, interviewSession] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            githubId: true,
            username: true,
            email: true,
            name: true,
            avatarUrl: true,
            bio: true,
            contextNote: true,
            commitmentScore: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        this.prisma.commitmentScore.findUnique({
          where: { userId },
        }),
        this.prisma.githubMetrics.findUnique({
          where: { userId },
        }),
        this.prisma.interviewSession.findUnique({
          where: { userId },
          select: {
            id: true,
            status: true,
            structuredOutput: true,
            bioSummary: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ]);

    return {
      user,
      commitmentScore,
      githubMetrics,
      interviewSession,
    };
  }
}
