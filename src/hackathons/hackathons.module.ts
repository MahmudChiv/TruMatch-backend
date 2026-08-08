import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PrismaModule } from '../prisma/prisma.module';
import { HackathonsService } from './hackathons.service';
import { HackathonsController } from './hackathons.controller';

/**
 * HackathonsModule — discovery, AI-assisted submission, and team-matching pool for hackathon events.
 *
 * MulterModule is configured with in-memory storage so that uploaded flyer images
 * are available as Buffer objects in the controller, without writing temporary files to disk.
 * The service then uploads them to Supabase Storage.
 */
@Module({
  imports: [
    PrismaModule,
    MulterModule.register({
      storage: memoryStorage(), // Keep uploaded files in memory as Buffer
    }),
  ],
  controllers: [HackathonsController],
  providers: [HackathonsService],
  exports: [HackathonsService],
})
export class HackathonsModule {}
