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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HackathonsService } from './hackathons.service';
import { ScrapeHackathonDto } from './dto/scrape-hackathon.dto';
import { CreateHackathonDto } from './dto/create-hackathon.dto';
import { ReportHackathonDto } from './dto/report-hackathon.dto';
import { User } from '@prisma/client';

/**
 * REST controller for hackathon event discovery, AI-assisted submission,
 * vouching, reporting, and matching pool joins.
 *
 * Three submission paths are supported via distinct endpoints:
 *  - POST /hackathons/scrape        — Path A: URL → OG + Gemini text extraction
 *  - POST /hackathons/extract-image — Path B: image or pasted text → Gemini extraction
 *  - POST /hackathons               — Final submission (all paths converge here)
 *
 * All endpoints are secured by JwtAuthGuard.
 */
@Controller('hackathons')
@UseGuards(JwtAuthGuard)
export class HackathonsController {
  constructor(private readonly hackathonsService: HackathonsService) {}

  /**
   * POST /hackathons/scrape
   * Path A (URL): Fetches page, scrapes OG tags, extracts visible text,
   * sends to Gemini for structured field extraction, and checks for duplicate listings.
   * Returns OG metadata + AI-extracted fields + rawSourceText (to be passed back on submit).
   */
  @Post('scrape')
  @HttpCode(HttpStatus.OK)
  async scrapeOgData(@Body() body: ScrapeHackathonDto) {
    return this.hackathonsService.extractFromUrl(body.url);
  }

  /**
   * POST /hackathons/extract-image
   * Path B (Image or pasted text): Accepts either a multipart image file
   * or a JSON body with pastedText. Calls Gemini to extract structured event data.
   * For image submissions, also uploads the flyer to Supabase Storage.
   *
   * Accepts multipart/form-data with optional file field 'image' and optional text field 'pastedText'.
   * Falls back gracefully to an empty extraction result if Gemini fails.
   */
  @Post('extract-image')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('image', {
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max per image
      },
      fileFilter: (_req, file, cb) => {
        // Accept only common image MIME types
        if (file.mimetype.startsWith('image/')) {
          cb(null, true);
        } else {
          cb(new Error('Only image files are allowed'), false);
        }
      },
    }),
  )
  async extractFromImage(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { pastedText?: string },
  ) {
    return this.hackathonsService.extractFromImageOrText(
      file?.buffer,
      file?.mimetype,
      body.pastedText,
    );
  }

  /**
   * POST /hackathons
   * Final submission endpoint — all three paths (URL, image, manual) converge here.
   * Accepts the reviewed form data from the frontend after user edits.
   * Also accepts rawSourceText and imageUrl fields (passed back from extraction responses)
   * which are stored as admin-only fields, never returned in public responses.
   *
   * User must have completed the AI interview before submitting (enforced in service).
   * Auto-promotes to 'verified' if submitter qualifies as a trusted submitter.
   */
  @Post()
  async create(@Req() req: Request, @Body() body: CreateHackathonDto) {
    const user = req.user as User;
    return this.hackathonsService.create(body, user.id);
  }

  /**
   * GET /hackathons
   * Lists all non-flagged hackathons sorted and grouped into proximity tiers relative to the user's location.
   * Includes new AI-extracted fields (fullDescription, eligibility, teamSize, prize, applicationDeadline).
   * Admin-only fields are excluded.
   */
  @Get()
  async findAll(@Req() req: Request) {
    const user = req.user as User;
    return this.hackathonsService.findAll(user.id);
  }

  /**
   * GET /hackathons/:id
   * Retrieves full details for a single hackathon, including participant roster and user state.
   * Admin-only fields are excluded from the response.
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
