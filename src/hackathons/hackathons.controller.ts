import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HackathonsService } from './hackathons.service';
import { ScrapeHackathonDto } from './dto/scrape-hackathon.dto';
import { CreateHackathonDto } from './dto/create-hackathon.dto';
import { ReportHackathonDto } from './dto/report-hackathon.dto';
import { User } from '@prisma/client';

/**
 * REST controller for hackathon event discovery, submission, vouching, reporting, and matching pool joins.
 * All endpoints are secured by JwtAuthGuard.
 */
@Controller('hackathons')
@UseGuards(JwtAuthGuard)
export class HackathonsController {
  constructor(private readonly hackathonsService: HackathonsService) {}

  /**
   * POST /hackathons/scrape
   * Scrapes Open Graph metadata from an event URL and checks for potential duplicate listings.
   */
  @Post('scrape')
  @HttpCode(HttpStatus.OK)
  async scrapeOgData(@Body() body: ScrapeHackathonDto) {
    return this.hackathonsService.scrapeOgData(body.url);
  }

  /**
   * POST /hackathons
   * Submits a new hackathon entry. User must have completed the AI interview.
   * Auto-promotes to 'verified' status if submitter qualifies as a trusted submitter.
   */
  @Post()
  async create(@Req() req: Request, @Body() body: CreateHackathonDto) {
    const user = req.user as User;
    return this.hackathonsService.create(body, user.id);
  }

  /**
   * GET /hackathons
   * Lists all non-flagged hackathons sorted and grouped into proximity tiers relative to the user's location.
   */
  @Get()
  async findAll(@Req() req: Request) {
    const user = req.user as User;
    return this.hackathonsService.findAll(user.id);
  }

  /**
   * GET /hackathons/:id
   * Retrieves full details for a single hackathon, including participant roster and user state.
   */
  @Get(':id')
  async findOne(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as User;
    return this.hackathonsService.findOne(id, user.id);
  }

  /**
   * POST /hackathons/:id/join
   * Adds the authenticated user to the event's team-matching pool.
   */
  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  async join(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as User;
    return this.hackathonsService.join(id, user.id);
  }

  /**
   * DELETE /hackathons/:id/join
   * Removes the authenticated user from the event's team-matching pool.
   */
  @Delete(':id/join')
  @HttpCode(HttpStatus.OK)
  async leave(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as User;
    return this.hackathonsService.leave(id, user.id);
  }

  /**
   * POST /hackathons/:id/vouch
   * Records a community vouch for a pending hackathon. Auto-verifies upon reaching VOUCH_THRESHOLD.
   */
  @Post(':id/vouch')
  @HttpCode(HttpStatus.OK)
  async vouch(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as User;
    return this.hackathonsService.vouch(id, user.id);
  }

  /**
   * POST /hackathons/:id/report
   * Submits a community report with a reason. Auto-flags listing upon reaching REPORT_THRESHOLD.
   */
  @Post(':id/report')
  @HttpCode(HttpStatus.OK)
  async report(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: ReportHackathonDto,
  ) {
    const user = req.user as User;
    return this.hackathonsService.report(id, user.id, body.reason);
  }
}
