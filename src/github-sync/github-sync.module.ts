import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { GithubSyncService, REDIS_CLIENT } from './github-sync.service';
import { GithubSyncProcessor } from './github-sync.processor';
import { GithubSyncGateway } from './github-sync.gateway';
import { GithubSyncController } from './github-sync.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    UsersModule,
    BullModule.registerQueue({
      name: 'github-sync',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5s → 10s → 20s
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [GithubSyncController],
  providers: [
    // Custom Redis provider — injected into GithubSyncService via REDIS_CLIENT token
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService) => {
        const url =
          configService.get<string>('REDIS_URL') || 'redis://localhost:6379';
        return new Redis(url);
      },
      inject: [ConfigService],
    },
    GithubSyncService,
    GithubSyncProcessor,
    GithubSyncGateway,
  ],
  exports: [GithubSyncService],
})
export class GithubSyncModule {}

