import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { User } from '@prisma/client';

/** Class-based DTO for @Body() — interfaces don't emit decorator metadata */
class UpdateProfileBody {
  contextNote?: string | null;
  bio?: string | null;
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * PATCH /users/me/profile
   * Allows the user to update their editable profile fields after onboarding.
   *
   * Fields:
   * - bio: editable self-description
   * - contextNote: user-authored note visible on public profile near their score
   *   → Purely transparency — does NOT adjust the score in any way.
   *   → Rendered as "[Name]'s note: ..." on the public profile.
   *   → This is the correct outlet for "my score doesn't fully reflect my ability"
   *     claims — visible to future teammates, not a mechanism that changes matching.
   */
  @Patch('me/profile')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Req() req: Request,
    @Body() body: UpdateProfileBody,
  ) {
    const user = req.user as User;
    return this.usersService.updateProfile(user.id, body);
  }

  /**
   * GET /users/:id/profile
   * Public profile view showing:
   * - Bio (from GitHub + interview bio_summary)
   * - Commitment score with full breakdown
   * - GitHub confidence tier (shown plainly, e.g. "New developer — limited GitHub history")
   * - Context note (if set)
   * - Aggregate peer rating (placeholder — null until Rating module exists)
   */
  @Get(':id/profile')
  async getPublicProfile(@Param('id') id: string) {
    const profile = await this.usersService.getPublicProfile(id);
    if (!profile) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return profile;
  }
}
