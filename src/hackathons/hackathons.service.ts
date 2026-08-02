import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CreateHackathonDto } from './dto/create-hackathon.dto';
import * as cheerio from 'cheerio';

// ─── Helpers & Math Utilities ──────────────────────────────────────────────────

/**
 * Computes the great-circle distance between two geographic coordinates using the Haversine formula.
 *
 * @param lat1 Latitude of point 1 (degrees)
 * @param lon1 Longitude of point 1 (degrees)
 * @param lat2 Latitude of point 2 (degrees)
 * @param lon2 Longitude of point 2 (degrees)
 * @returns Distance in kilometers
 */
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // Earth's mean radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Normalizes an event URL for canonical duplicate comparisons.
 * Strips protocol, trailing slashes, leading 'www.', and lowercases hostname + path.
 *
 * @param rawUrl Raw URL string provided by user input
 * @returns Normalized domain + path string
 */
function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${host}${pathname}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

// ─── Service Implementation ───────────────────────────────────────────────────

/**
 * Service managing hackathon event discovery, server-side Open Graph scraping,
 * duplicate detection, submission fast-tracking, vouching/reporting moderation thresholds,
 * and proximity-based listing aggregation.
 */
@Injectable()
export class HackathonsService {
  private readonly vouchThreshold: number;
  private readonly reportThreshold: number;
  private readonly trustedSubmitterThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    // Configurable verification & moderation thresholds loaded from environment variables
    this.vouchThreshold = parseInt(
      this.configService.get<string>('VOUCH_THRESHOLD') || '3',
      10,
    );
    this.reportThreshold = parseInt(
      this.configService.get<string>('REPORT_THRESHOLD') || '2',
      10,
    );
    this.trustedSubmitterThreshold = parseInt(
      this.configService.get<string>('TRUSTED_SUBMITTER_THRESHOLD') || '3',
      10,
    );
  }

  /**
   * Server-side Open Graph scraper for event URLs.
   * Extracts og:title, og:description, og:image, and site_name to auto-populate submission forms.
   * Includes SSRF mitigations (HTTPS only, 10s timeout, non-private IP check, 1MB size limit)
   * and runs duplicate detection before returning scraped metadata.
   *
   * @param rawUrl Target event URL to scrape
   * @returns Scraped metadata fields + duplicate match (if found)
   */
  async scrapeOgData(rawUrl: string) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new BadRequestException('Invalid URL format');
    }

    // SSRF Mitigation 1: Enforce HTTPS scheme only
    if (parsedUrl.protocol !== 'https:') {
      throw new BadRequestException('Only HTTPS URLs are allowed');
    }

    // SSRF Mitigation 2: Block local and private IP ranges
    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.')
    ) {
      throw new BadRequestException('Invalid target URL');
    }

    let title: string | null = null;
    let description: string | null = null;
    let logoUrl: string | null = null;
    let siteName: string | null = null;

    try {
      // AbortController for 10-second request timeout limit
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(parsedUrl.toString(), {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; TruMatchBot/1.0; +https://trumatch.dev)',
        },
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const html = await res.text();

        // SSRF Mitigation 3: Truncate response to 1MB max before parsing DOM
        const $ = cheerio.load(html.slice(0, 1000000));

        // Open Graph & fallback meta tag extraction
        title =
          $('meta[property="og:title"]').attr('content') ||
          $('meta[name="twitter:title"]').attr('content') ||
          $('title').text().trim() ||
          null;

        description =
          $('meta[property="og:description"]').attr('content') ||
          $('meta[name="twitter:description"]').attr('content') ||
          $('meta[name="description"]').attr('content') ||
          null;

        logoUrl =
          $('meta[property="og:image"]').attr('content') ||
          $('meta[name="twitter:image"]').attr('content') ||
          null;

        siteName =
          $('meta[property="og:site_name"]').attr('content') || null;
      }
    } catch {
      // Graceful fallback: If scraping fails/times out, proceed with user manual entry
    }

    // Check if URL or title matches an existing non-flagged hackathon
    const duplicate = await this.checkDuplicate(rawUrl, title);

    return {
      title,
      description,
      logoUrl,
      siteName,
      duplicate,
    };
  }

  /**
   * Compares normalized URL and exact title against existing database rows to prevent duplicate entries.
   *
   * @param rawUrl Raw URL to compare
   * @param title Scraped or user-entered title to compare
   * @returns Matching Hackathon row if duplicate exists, null otherwise
   */
  async checkDuplicate(rawUrl: string, title?: string | null) {
    const normalized = normalizeUrl(rawUrl);

    const allHackathons = await this.prisma.hackathon.findMany({
      where: { status: { not: 'flagged' } },
      select: {
        id: true,
        title: true,
        externalUrl: true,
        logoUrl: true,
        description: true,
        venueType: true,
        locationLabel: true,
        status: true,
      },
    });

    for (const h of allHackathons) {
      // Check 1: Canonical normalized URL equality
      if (normalizeUrl(h.externalUrl) === normalized) {
        return h;
      }
      // Check 2: Case-insensitive trimmed title equality
      if (
        title &&
        h.title.toLowerCase().trim() === title.toLowerCase().trim()
      ) {
        return h;
      }
    }

    return null;
  }

  /**
   * Checks if a user qualifies as a Trusted Submitter based on their prior record.
   * A user is trusted if they have submitted >= TRUSTED_SUBMITTER_THRESHOLD hackathons
   * that achieved 'verified' status without receiving any user reports.
   *
   * @param userId Authenticated user ID
   * @returns Boolean indicating trusted submitter status
   */
  async isTrustedSubmitter(userId: string): Promise<boolean> {
    const count = await this.prisma.hackathon.count({
      where: {
        submittedBy: userId,
        status: 'verified',
        reports: { none: {} },
      },
    });
    return count >= this.trustedSubmitterThreshold;
  }

  /**
   * Submits a new hackathon entry.
   * Enforces auth gating (must have completed AI interview).
   * Determines initial status via Trusted Submitter fast-track logic.
   *
   * @param dto Create payload with event details
   * @param userId Authenticated submitter user ID
   * @returns Created Hackathon record
   */
  async create(dto: CreateHackathonDto, userId: string) {
    // Enforce auth gating: User must have completed the AI interview
    const interview = await this.prisma.interviewSession.findUnique({
      where: { userId },
    });
    if (!interview || interview.status !== 'complete') {
      throw new ForbiddenException(
        'You must complete the AI interview before submitting hackathons.',
      );
    }

    // Fast-track check: Trusted submitters publish directly as 'verified'
    const trusted = await this.isTrustedSubmitter(userId);
    const initialStatus = trusted ? 'verified' : 'pending';

    return this.prisma.hackathon.create({
      data: {
        title: dto.title,
        externalUrl: dto.externalUrl,
        logoUrl: dto.logoUrl || null,
        description: dto.description || null,
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        submissionDeadline: dto.submissionDeadline
          ? new Date(dto.submissionDeadline)
          : null,
        venueType: dto.venueType || 'virtual',
        locationLabel: dto.locationLabel || null,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        prizeInfo: dto.prizeInfo || null,
        tags: dto.tags || [],
        status: initialStatus,
        submittedBy: userId,
      },
    });
  }

  /**
   * Fetches all non-flagged hackathons and groups them into proximity tiers relative to the user.
   * Tiers:
   * - same_city: distance <= 50 km
   * - same_country: distance <= 500 km
   * - elsewhere: distance > 500 km or virtual/unspecified location
   *
   * @param userId Authenticated user ID (to read user coordinates & user join/vouch states)
   * @returns Array of hackathon summaries with distance, distanceTier, joinCount, and vouchCount
   */
  async findAll(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { latitude: true, longitude: true },
    });

    const hackathons = await this.prisma.hackathon.findMany({
      where: { status: { not: 'flagged' } },
      include: {
        _count: {
          select: { joins: true, vouches: true },
        },
        joins: {
          where: { userId },
          select: { userId: true },
        },
        vouches: {
          where: { userId },
          select: { userId: true },
        },
        submitter: {
          select: { username: true, avatarUrl: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const formatted = hackathons.map((h) => {
      let distance: number | null = null;
      let distanceTier: 'same_city' | 'same_country' | 'elsewhere' =
        'elsewhere';

      // Compute proximity distance if both user and hackathon have coordinates
      if (
        user?.latitude != null &&
        user?.longitude != null &&
        h.latitude != null &&
        h.longitude != null
      ) {
        distance = haversineDistance(
          user.latitude,
          user.longitude,
          h.latitude,
          h.longitude,
        );

        if (distance <= 50) {
          distanceTier = 'same_city';
        } else if (distance <= 500) {
          distanceTier = 'same_country';
        }
      }

      return {
        id: h.id,
        title: h.title,
        logoUrl: h.logoUrl,
        description: h.description,
        startDate: h.startDate,
        endDate: h.endDate,
        submissionDeadline: h.submissionDeadline,
        venueType: h.venueType,
        locationLabel: h.locationLabel,
        externalUrl: h.externalUrl,
        prizeInfo: h.prizeInfo,
        tags: h.tags,
        status: h.status,
        submittedBy: h.submitter,
        joinCount: h._count.joins,
        vouchCount: h._count.vouches,
        hasJoined: h.joins.length > 0,
        hasVouched: h.vouches.length > 0,
        distance: distance ? Math.round(distance) : null,
        distanceTier,
        createdAt: h.createdAt,
      };
    });

    return formatted;
  }

  /**
   * Fetches detailed information for a single hackathon including participant roster.
   *
   * @param id Hackathon ID
   * @param userId Authenticated user ID
   * @returns Detailed hackathon object with participants list
   */
  async findOne(id: string, userId: string) {
    const hackathon = await this.prisma.hackathon.findUnique({
      where: { id },
      include: {
        _count: {
          select: { joins: true, vouches: true },
        },
        joins: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                name: true,
                avatarUrl: true,
                commitmentScore: true,
              },
            },
          },
        },
        vouches: {
          where: { userId },
          select: { userId: true },
        },
        submitter: {
          select: { id: true, username: true, avatarUrl: true },
        },
      },
    });

    if (!hackathon || hackathon.status === 'flagged') {
      throw new NotFoundException('Hackathon not found');
    }

    const hasJoined = hackathon.joins.some((j) => j.userId === userId);
    const hasVouched = hackathon.vouches.length > 0;

    return {
      ...hackathon,
      joinCount: hackathon._count.joins,
      vouchCount: hackathon._count.vouches,
      hasJoined,
      hasVouched,
      participants: hackathon.joins.map((j) => j.user),
    };
  }

  /**
   * Adds the authenticated user to the matching pool for an event.
   *
   * @param hackathonId Target hackathon ID
   * @param userId Authenticated user ID
   * @returns Object indicating joined state
   */
  async join(hackathonId: string, userId: string) {
    const hackathon = await this.prisma.hackathon.findUnique({
      where: { id: hackathonId },
    });
    if (!hackathon || hackathon.status === 'flagged') {
      throw new NotFoundException('Hackathon not found');
    }

    await this.prisma.hackathonJoin.upsert({
      where: {
        hackathonId_userId: { hackathonId, userId },
      },
      create: { hackathonId, userId },
      update: {},
    });

    return { joined: true };
  }

  /**
   * Removes the authenticated user from the matching pool for an event.
   *
   * @param hackathonId Target hackathon ID
   * @param userId Authenticated user ID
   * @returns Object indicating joined state
   */
  async leave(hackathonId: string, userId: string) {
    try {
      await this.prisma.hackathonJoin.delete({
        where: {
          hackathonId_userId: { hackathonId, userId },
        },
      });
    } catch {
      // Ignore exception if user was not currently in pool
    }
    return { joined: false };
  }

  /**
   * Records a community vouch for a pending hackathon listing.
   * If total distinct vouches reach VOUCH_THRESHOLD (default 3),
   * automatically transitions status to 'verified'.
   *
   * @param hackathonId Target hackathon ID
   * @param userId Authenticated user ID
   * @returns Updated vouch status and vouch count
   */
  async vouch(hackathonId: string, userId: string) {
    const hackathon = await this.prisma.hackathon.findUnique({
      where: { id: hackathonId },
    });

    if (!hackathon || hackathon.status === 'flagged') {
      throw new NotFoundException('Hackathon not found');
    }

    if (hackathon.status === 'verified') {
      throw new BadRequestException('Listing is already verified');
    }

    try {
      await this.prisma.hackathonVouch.create({
        data: { hackathonId, userId },
      });
    } catch {
      throw new ConflictException('You have already vouched for this hackathon');
    }

    const vouchCount = await this.prisma.hackathonVouch.count({
      where: { hackathonId },
    });

    // Auto-transition to 'verified' if threshold is reached
    if (vouchCount >= this.vouchThreshold) {
      await this.prisma.hackathon.update({
        where: { id: hackathonId },
        data: { status: 'verified' },
      });
      return { vouched: true, status: 'verified', vouchCount };
    }

    return { vouched: true, status: hackathon.status, vouchCount };
  }

  /**
   * Records a user report for a hackathon listing with a reason.
   * If total reports reach REPORT_THRESHOLD (default 2),
   * automatically transitions status to 'flagged' (removing it from public results).
   *
   * @param hackathonId Target hackathon ID
   * @param userId Authenticated user ID
   * @param reason Detailed explanation for the report
   * @returns Updated report status and report count
   */
  async report(hackathonId: string, userId: string, reason: string) {
    const hackathon = await this.prisma.hackathon.findUnique({
      where: { id: hackathonId },
    });

    if (!hackathon) {
      throw new NotFoundException('Hackathon not found');
    }

    try {
      await this.prisma.hackathonReport.create({
        data: { hackathonId, userId, reason },
      });
    } catch {
      throw new ConflictException('You have already reported this hackathon');
    }

    const reportCount = await this.prisma.hackathonReport.count({
      where: { hackathonId },
    });

    // Auto-transition to 'flagged' if threshold is reached
    if (reportCount >= this.reportThreshold) {
      await this.prisma.hackathon.update({
        where: { id: hackathonId },
        data: { status: 'flagged' },
      });
      return { reported: true, status: 'flagged', reportCount };
    }

    return { reported: true, status: hackathon.status, reportCount };
  }
}
