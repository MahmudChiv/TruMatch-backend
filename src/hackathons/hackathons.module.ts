import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HackathonsService } from './hackathons.service';
import { HackathonsController } from './hackathons.controller';

@Module({
  imports: [PrismaModule],
  controllers: [HackathonsController],
  providers: [HackathonsService],
  exports: [HackathonsService],
})
export class HackathonsModule {}
