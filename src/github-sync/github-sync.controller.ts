import { Controller, Post, Get, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { GithubSyncService } from './github-sync.service';
import { UsersService } from '../users/users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '@prisma/client';

@Controller('users/me')
export class GithubSyncController {
  constructor(
    private readonly githubSyncService: GithubSyncService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * GET /users/me/dashboard
   * Returns all dashboard data in a single aggregated response.
   */
  @Get('dashboard')
  @UseGuards(JwtAuthGuard)
  async getDashboard(@Req() req: Request) {
    const user = req.user as User;
    return this.usersService.getDashboardData(user.id);
  }

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

  /**
   * GET /users/me/github-sync
   * Checks the status of the GitHub sync job.
   */
  @Get('github-sync')
  @UseGuards(JwtAuthGuard)
  async getSyncStatus(@Req() req: Request) {
    const user = req.user as User;
    const metrics = await this.githubSyncService.getSyncStatus(user.id);
    return {
      status: metrics?.status ?? 'none',
      error: metrics?.errorReason ?? null,
      score: metrics?.githubConsistencyScore ?? null,
    };
  }
}

