import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RatingsService } from './ratings.service';
import { CreateRatingDto } from './dto/create-rating.dto';
import type { User } from '@prisma/client';

@Controller('ratings')
export class RatingsController {
  constructor(private readonly ratingsService: RatingsService) {}

  /**
   * POST /ratings
   * Submit a peer rating for a teammate.
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async submitRating(@Req() req: Request, @Body() body: CreateRatingDto) {
    const user = req.user as User;
    return this.ratingsService.submitRating(user.id, body);
  }

  /**
   * GET /ratings/team/:teamId
   * Fetch ratings for a team.
   * Ratings authored by requester are shown in full; comments from others are anonymized per Section 4.
   */
  @Get('team/:teamId')
  @UseGuards(JwtAuthGuard)
  async getTeamRatings(
    @Req() req: Request,
    @Param('teamId') teamId: string,
  ) {
    const user = req.user as User;
    return this.ratingsService.getRatingsForTeam(teamId, user.id);
  }

  /**
   * GET /ratings/pending
   * Fetch teammates current user needs to rate for completed teams/hackathons.
   */
  @Get('pending')
  @UseGuards(JwtAuthGuard)
  async getPendingRatings(@Req() req: Request) {
    const user = req.user as User;
    return this.ratingsService.getPendingRatingsForUser(user.id);
  }

  /**
   * GET /ratings/user/:userId
   * Public endpoint to view a user's peer rating score, distinct teams count, and anonymized comments.
   */
  @Get('user/:userId')
  async getUserRatings(@Param('userId') userId: string) {
    return this.ratingsService.getPublicPeerRatingSummary(userId);
  }
}
