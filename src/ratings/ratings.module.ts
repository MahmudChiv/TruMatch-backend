import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { RatingsService } from './ratings.service';
import { RatingsController } from './ratings.controller';
import { RatingReminderProcessor } from './rating-reminder.processor';
import { RatingsGateway } from './ratings.gateway';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: 'rating-reminders',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [RatingsController],
  providers: [
    RatingsService,
    RatingReminderProcessor,
    RatingsGateway,
  ],
  exports: [RatingsService, RatingsGateway],
})
export class RatingsModule implements OnModuleInit {
  private readonly logger = new Logger(RatingsModule.name);

  constructor(
    @InjectQueue('rating-reminders') private readonly reminderQueue: Queue,
  ) {}

  async onModuleInit() {
    try {
      // Register daily repeatable job for rating notifications
      await this.reminderQueue.add(
        'check-pending-ratings',
        { action: 'check-pending-ratings' },
        {
          repeat: { pattern: '0 9 * * *' }, // Daily at 09:00 UTC
          jobId: 'repeatable-check-pending-ratings',
        },
      );

      // Register daily repeatable job for unlocking 7-day expired ratings
      await this.reminderQueue.add(
        'unlock-expired-ratings',
        { action: 'unlock-expired-ratings' },
        {
          repeat: { pattern: '0 0 * * *' }, // Daily at 00:00 UTC
          jobId: 'repeatable-unlock-expired-ratings',
        },
      );

      this.logger.log('Registered BullMQ repeatable jobs for rating reminders & expired rating unlocks');
    } catch (err) {
      this.logger.warn(`Could not register repeatable jobs: ${(err as Error).message}`);
    }
  }
}
