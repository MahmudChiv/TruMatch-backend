import { Controller, Post, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { GithubSyncService } from './github-sync.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '@prisma/client';

@Controller('users/me')
export class GithubSyncController {
  constructor(private readonly githubSyncService: GithubSyncService) {}

  /**
   * POST /users/me/github-sync
   * Enqueues a background job to fetch + score the authenticated user's GitHub data.
   * Returns immediately with { status: 'queued' } — does NOT wait for processing.
   */
  @Post('github-sync')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerSync(@Req() req: Request) {
    const user = req.user as User;
    return this.githubSyncService.enqueueSync(user.id);
  }
}
