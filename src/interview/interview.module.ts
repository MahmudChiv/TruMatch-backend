import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { InterviewService } from './interview.service';
import { InterviewGateway } from './interview.gateway';

@Module({
  imports: [PrismaModule, ConfigModule],
  providers: [InterviewService, InterviewGateway],
  exports: [InterviewService],
})
export class InterviewModule {}
