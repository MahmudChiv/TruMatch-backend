import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { GithubSyncService } from './github-sync.service';
import { GithubSyncGateway } from './github-sync.gateway';

@Processor('github-sync', {
  concurrency: 20,     // global cap — max 20 users processed simultaneously
  lockDuration: 60_000, // 1 minute — prevents BullMQ silently abandoning long-running jobs
})
export class GithubSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(GithubSyncProcessor.name);

  constructor(
    private readonly githubSyncService: GithubSyncService,
    private readonly gateway: GithubSyncGateway,
  ) {
    super();
  }

  async process(job: Job<{ userId: string }>): Promise<void> {
    console.log('🔥 [PROCESSOR] process() called — job:', job.id, 'userId:', job.data.userId);
    const { userId } = job.data;
    this.logger.log(
      `Processing job ${job.id} for user ${userId} (attempt ${job.attemptsMade + 1})`,
    );

    try {
      const result = await this.githubSyncService.processSyncJob(userId);

      // Notify the frontend via WebSocket
      // Now includes githubConfidence and accountCreatedAt
      this.gateway.emitSyncComplete(userId, {
        status: result.githubConsistencyScore !== null ? 'complete' : 'insufficient_data',
        score: result.githubConsistencyScore ?? undefined,
        githubConfidence: result.githubConfidence,
        accountCreatedAt: result.accountCreatedAt ?? undefined,
      });
    } catch (err) {
      const reason = (err as Error).message ?? 'Unknown error';
      this.logger.error(
        `Job ${job.id} failed for user ${userId}: ${reason}`,
        (err as Error).stack,
      );

      // If this is the last attempt, persist failure and notify the frontend
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 3)) {
        await this.githubSyncService.markFailed(userId, reason);
        this.gateway.emitSyncComplete(userId, {
          status: 'failed',
          error: reason,
        });
      }

      // Re-throw so BullMQ can schedule the retry / mark failed
      throw err;
    }
  }
}
