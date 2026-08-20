import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MatchingService } from './matching.service';
import { User } from '@prisma/client';

class SendInviteDto {
  toUserId: string;
  charterJson?: any;
}

class RespondInviteDto {
  action: 'accept' | 'decline';
}

@Controller()
@UseGuards(JwtAuthGuard)
export class MatchingController {
  constructor(private readonly matchingService: MatchingService) {}

  /**
   * POST /hackathons/:id/find-teammates
   * Single AI call per request ranking candidate pool and generating AI Team Charters.
   */
  @Post('hackathons/:id/find-teammates')
  @HttpCode(HttpStatus.OK)
  async findTeammates(@Req() req: Request, @Param('id') hackathonId: string) {
    const user = req.user as User;
    return this.matchingService.findTeammates(hackathonId, user.id);
  }

  /**
   * POST /hackathons/:id/invite
   * Sends a team invite to a candidate with an attached Team Charter.
   */
  @Post('hackathons/:id/invite')
  @HttpCode(HttpStatus.OK)
  async sendInvite(
    @Req() req: Request,
    @Param('id') hackathonId: string,
    @Body() body: SendInviteDto,
  ) {
    const user = req.user as User;
    return this.matchingService.sendInvite(
      hackathonId,
      user.id,
      body.toUserId,
      body.charterJson,
    );
  }

  /**
   * PATCH /hackathons/:id/invites/:inviteId
   * Accepts or declines an invite. On decline, returns 1 replacement candidate match.
   */
  @Patch('hackathons/:id/invites/:inviteId')
  @HttpCode(HttpStatus.OK)
  async respondToInvite(
    @Req() req: Request,
    @Param('inviteId') inviteId: string,
    @Body() body: RespondInviteDto,
  ) {
    const user = req.user as User;
    return this.matchingService.respondToInvite(
      inviteId,
      user.id,
      body.action,
    );
  }

  /**
   * GET /users/me/invites
   * Returns incoming pending invites and outgoing invites for current user.
   */
  @Get('users/me/invites')
  async getUserInvites(@Req() req: Request) {
    const user = req.user as User;
    return this.matchingService.getUserInvites(user.id);
  }

  /**
   * GET /hackathons/:id/my-invite
   * Returns current user's incoming pending invite for a specific hackathon.
   */
  @Get('hackathons/:id/my-invite')
  async getMyPendingInvite(@Req() req: Request, @Param('id') hackathonId: string) {
    const user = req.user as User;
    return this.matchingService.getMyPendingInvite(hackathonId, user.id);
  }

  /**
   * POST /teams/:teamId/complete
   * Marks team status as complete and fires rating notifications to all members immediately.
   */
  @Post('teams/:teamId/complete')
  @HttpCode(HttpStatus.OK)
  async completeTeam(@Req() req: Request, @Param('teamId') teamId: string) {
    const user = req.user as User;
    return this.matchingService.completeTeam(teamId, user.id);
  }
}
