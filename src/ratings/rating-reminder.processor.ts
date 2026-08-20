import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RatingsService } from './ratings.service';
import { PrismaService } from '../prisma/prisma.service';

@Processor('rating-reminders', {
  concurrency: 5,
  lockDuration: 60_000,
})
export class RatingReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(RatingReminderProcessor.name);

  constructor(
    private readonly ratingsService: RatingsService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<{ action?: string }>): Promise<void> {
    this.logger.log(`Processing rating-reminder job: ${job.name} (id: ${job.id})`);

    if (job.name === 'unlock-expired-ratings' || job.data?.action === 'unlock-expired-ratings') {
      await this.ratingsService.checkAndUnlockExpiredRatings();
      return;
    }

    // Default action: 'check-pending-ratings'
    await this.processPendingRatingNotifications();
  }

  /**
   * Finds teams where hackathons.endDate has passed (or is null), status = 'complete',
   * and not all member-pairs have rated each other yet.
   * Fires an in-app "rate your teammates" notification to each unrated member.
   */
  private async processPendingRatingNotifications(): Promise<void> {
    const now = new Date();

    // Query relevant teams
    const candidateTeams = await this.prisma.team.findMany({
      where: {
        OR: [
          { status: 'complete' },
          { hackathon: { endDate: { lte: now } } },
          { hackathon: { endDate: null } },
        ],
      },
      include: {
        hackathon: { select: { id: true, title: true, endDate: true } },
        members: { select: { userId: true } },
        ratings: { select: { raterId: true, rateeId: true } },
      },
    });

    let notificationsSent = 0;

    for (const team of candidateTeams) {
      const memberIds = team.members.map((m) => m.userId);
      if (memberIds.length < 2) continue; // single member or empty

      // Check which members have unrated teammates
      for (const raterId of memberIds) {
        const otherMemberIds = memberIds.filter((id) => id !== raterId);
        const givenRatings = team.ratings.filter((r) => r.raterId === raterId);
        const ratedSet = new Set(givenRatings.map((r) => r.rateeId));

        const unratedCount = otherMemberIds.filter((id) => !ratedSet.has(id)).length;

        if (unratedCount > 0) {
          // Check if notification sent in the last 24h to avoid duplicate spam
          const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const recentNotif = await this.prisma.notification.findFirst({
            where: {
              userId: raterId,
              type: 'rate_teammates',
              createdAt: { gte: oneDayAgo },
              payload: {
                path: ['teamId'],
                equals: team.id,
              },
            },
          });

          if (!recentNotif) {
            await this.ratingsService.createNotification(raterId, 'rate_teammates', {
              teamId: team.id,
              hackathonId: team.hackathon.id,
              hackathonTitle: team.hackathon.title,
              unratedCount,
              message: `Reminder: You have ${unratedCount} teammate(s) to rate for ${team.hackathon.title}`,
            });
            notificationsSent++;
          }
        }
      }
    }

    this.logger.log(`Rating prompt notifications process finished — sent ${notificationsSent} notifications.`);
  }
}
