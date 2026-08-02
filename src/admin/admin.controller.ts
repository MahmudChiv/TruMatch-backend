import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { PrismaService } from '../prisma/prisma.service';

/** DTO for updating a hackathon's moderation status */
class UpdateHackathonStatusDto {
  status: 'verified' | 'flagged' | 'pending';
}

/**
 * Controller handling admin verification check, moderation queue listing, and status overrides.
 * Stacked guards: JwtAuthGuard (authenticates token) -> AdminGuard (verifies allowlist email).
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /admin/check
   * Verifies if the authenticated user is an allowlisted admin.
   * Frontend calls this on page load to redirect non-admins before rendering UI.
   */
  @Get('check')
  checkAdmin() {
    return { admin: true };
  }

  /**
   * GET /admin/hackathons
   * Retrieves the moderation queue containing flagged and pending hackathons.
   * Custom sort places 'flagged' items first for immediate priority review, followed by 'pending'.
   */
  @Get('hackathons')
  async getQueue() {
    const hackathons = await this.prisma.hackathon.findMany({
      where: {
        status: { in: ['flagged', 'pending'] },
      },
      include: {
        submitter: {
          select: { id: true, username: true, email: true, avatarUrl: true },
        },
        reports: {
          include: {
            user: { select: { username: true } },
          },
        },
        _count: {
          select: { vouches: true, reports: true, joins: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
    });

    // Sort queue: 'flagged' items first, then 'pending' items by newest first
    return hackathons.sort((a, b) => {
      if (a.status === 'flagged' && b.status !== 'flagged') return -1;
      if (a.status !== 'flagged' && b.status === 'flagged') return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  /**
   * PATCH /admin/hackathons/:id
   * Allows an admin to manually approve ('verified') or reject ('flagged') a listing.
   */
  @Patch('hackathons/:id')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: UpdateHackathonStatusDto,
  ) {
    const hackathon = await this.prisma.hackathon.findUnique({
      where: { id },
    });
    if (!hackathon) {
      throw new NotFoundException('Hackathon not found');
    }

    return this.prisma.hackathon.update({
      where: { id },
      data: { status: body.status },
    });
  }
}
