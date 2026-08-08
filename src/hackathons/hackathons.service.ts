import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CreateHackathonDto } from './dto/create-hackathon.dto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  SchemaType,
} from '@google/generative-ai';
import * as cheerio from 'cheerio';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Gemini model — matches the model used across all other modules in this app. */
const GEMINI_MODEL = 'gemini-3.6-flash';

/** Supabase Storage bucket where flyer images are stored (admin-only access). */
const FLYER_BUCKET = 'hackathon-flyers';

/** Safety settings — neutral for professional context, matching interview.service.ts. */
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

/**
 * Critical system instruction prepended to every extraction prompt.
 * Prevents Gemini from hallucinating or inferring data not present in the source.
 */
const EXTRACTION_SYSTEM_INSTRUCTION =
  'You are an event information extraction assistant. ' +
  'Extract only information explicitly stated in the provided source. ' +
  'Do NOT infer, estimate, or generate plausible-sounding values for any field not clearly present — leave that field null instead. ' +
  'Do not calculate or invent a prize breakdown if only a total is given. ' +
  'Do not guess a deadline if only an event date is stated, or vice versa. ' +
  'For dates, return ISO 8601 date strings (YYYY-MM-DD). ' +
  'For externalUrl, extract any registration or event page link you can find in the source. ' +
  'If you are uncertain about a field you did extract, include it in low_confidence_fields.';

/**
 * Gemini structured-output JSON schema for event extraction.
 * Shared by both URL text extraction (Path A) and image/text extraction (Path B).
 * All fields are optional — the model must leave them null if not found.
 */
const EXTRACTION_SCHEMA: import('@google/generative-ai').ObjectSchema = {
  type: SchemaType.OBJECT as const,
  properties: {
    title:               { type: SchemaType.STRING,  description: 'Event title, null if not found' },
    shortDescription:    { type: SchemaType.STRING,  description: 'Concise 1-2 sentence blurb of the event, null if not found' },
    fullDescription:     { type: SchemaType.STRING,  description: 'Full event description/about text, null if not found' },
    eligibility:         { type: SchemaType.STRING,  description: 'Who can participate, e.g. "Open to university students worldwide", null if not found' },
    teamSize:            { type: SchemaType.STRING,  description: 'Team size as written, e.g. "2–4 members", null if not found' },
    startDate:           { type: SchemaType.STRING,  description: 'Event start date in YYYY-MM-DD format, null if not found' },
    endDate:             { type: SchemaType.STRING,  description: 'Event end date in YYYY-MM-DD format, null if not found' },
    applicationDeadline: { type: SchemaType.STRING,  description: 'Application/registration deadline in YYYY-MM-DD format, null if not found' },
    submissionDeadline:  { type: SchemaType.STRING,  description: 'Project/hack submission deadline in YYYY-MM-DD format, null if not found (distinct from applicationDeadline)' },
    locationLabel:       { type: SchemaType.STRING,  description: 'City-level location label, e.g. "Lagos, Nigeria" or "San Francisco, CA" — never a specific address. null if not found.' },
    venueType: {
      type: SchemaType.STRING,
      description: 'One of: physical, virtual, hybrid. Null if cannot be determined.',
      format: 'enum',
      enum: ['physical', 'virtual', 'hybrid'],
    },
    prizePoolTotal:  { type: SchemaType.STRING,  description: 'Total prize pool as-written in source, e.g. "₦1,000,000" or "$50,000". Never compute or normalize. null if not found.' },
    prizeBreakdown:  {
      type: SchemaType.ARRAY,
      description: 'Array of prize tiers — only populate if source explicitly categorizes prizes by place/category. Leave as empty array if only a total is given.',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          place: { type: SchemaType.STRING, description: 'e.g. "1st Place", "Best AI Project"' },
          prize: { type: SchemaType.STRING, description: 'e.g. "$10,000", "MacBook Pro"' },
        },
        required: ['place', 'prize'],
      },
    },
    tags:        { type: SchemaType.ARRAY,   description: 'Relevant topic tags as lowercase strings, e.g. ["ai", "climate", "web3"]. Empty array if none.', items: { type: SchemaType.STRING } },
    externalUrl: { type: SchemaType.STRING,  description: 'Registration or event page URL — extract any link explicitly present in the source. null if no URL is found.' },
    low_confidence_fields: {
      type: SchemaType.ARRAY,
      description: 'List of field names the model extracted but with low certainty (e.g. ambiguous date format, partial text). Include the field name as a string, e.g. ["startDate", "prizePoolTotal"].',
      items: { type: SchemaType.STRING },
    },
  },
  required: ['low_confidence_fields'],
};

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

/**
 * Extracts visible readable text from raw HTML by stripping non-content tags.
 * Used to produce a clean text snapshot for Gemini extraction and for rawSourceText storage.
 *
 * @param html Raw HTML string from the fetched page
 * @returns Plain text with whitespace normalized
 */
function extractVisibleText(html: string): string {
  const $ = cheerio.load(html.slice(0, 1000000)); // Cap at 1MB before parsing

  // Remove all non-content elements that don't carry event information
  $('script, style, nav, header, footer, noscript, iframe, svg, [aria-hidden="true"]').remove();

  // Extract remaining text and normalize whitespace
  const rawText = $('body').text();
  return rawText.replace(/\s+/g, ' ').trim().slice(0, 50000); // Cap at 50k chars for Gemini
}

// ─── Service Implementation ───────────────────────────────────────────────────

/**
 * Service managing hackathon event discovery, AI-assisted server-side extraction,
 * duplicate detection, submission fast-tracking, vouching/reporting moderation thresholds,
 * and proximity-based listing aggregation.
 *
 * Three submission paths are supported:
 * - Path A (URL):   OG scrape + Gemini structured text extraction
 * - Path B (Image): Gemini multimodal OCR extraction from uploaded flyer image
 * - Path B (Text):  Gemini text extraction from pasted unstructured text
 * - Path C (Manual): No extraction — user fills all fields manually
 */
@Injectable()
export class HackathonsService {
  private readonly logger = new Logger(HackathonsService.name);
  private readonly vouchThreshold: number;
  private readonly reportThreshold: number;
  private readonly trustedSubmitterThreshold: number;
  private readonly genAI: GoogleGenerativeAI;
  private readonly supabase: SupabaseClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    // ── Configurable verification & moderation thresholds from environment variables
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

    // ── Gemini client — same pattern as interview.service.ts
    const geminiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!geminiKey) throw new Error('GEMINI_API_KEY is not set in environment');
    this.genAI = new GoogleGenerativeAI(geminiKey);

    // ── Supabase client — used for flyer image storage (Path B image uploads)
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      this.logger.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — image upload will be disabled');
    }
    this.supabase = createClient(supabaseUrl || '', supabaseKey || '');
  }

  // ── Private: Gemini Extraction ─────────────────────────────────────────────

  /**
   * Calls Gemini with a structured-output schema to extract event data from plain text.
   * Used by both Path A (fetched page text) and Path B (pasted text).
   *
   * @param text Visible text content to extract from
   * @returns Parsed extraction result, or null if Gemini call fails
   */
  private async runGeminiTextExtraction(
    text: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const model = this.genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: EXTRACTION_SYSTEM_INSTRUCTION,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: EXTRACTION_SCHEMA,
        },
        safetySettings: SAFETY_SETTINGS,
      });

      const prompt = `Extract event/hackathon information from the following text:\n\n${text}`;
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      return JSON.parse(responseText) as Record<string, unknown>;
    } catch (err) {
      // Graceful fallback: extraction failure must never block submission
      this.logger.warn(`Gemini text extraction failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Calls Gemini's multimodal endpoint to extract event data from an image buffer (flyer OCR).
   * Uses the same EXTRACTION_SCHEMA as the text path for a consistent response shape.
   *
   * @param imageBuffer Raw image bytes
   * @param mimeType    MIME type of the image (e.g. 'image/png', 'image/jpeg')
   * @returns Parsed extraction result, or null if Gemini call fails
   */
  private async runGeminiImageExtraction(
    imageBuffer: Buffer,
    mimeType: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const model = this.genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: EXTRACTION_SYSTEM_INSTRUCTION,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: EXTRACTION_SCHEMA,
        },
        safetySettings: SAFETY_SETTINGS,
      });

      const imagePart = {
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType,
        },
      };

      const textPart = {
        text: 'Extract event/hackathon information from this image (flyer, poster, or screenshot):',
      };

      const result = await model.generateContent([textPart, imagePart]);
      const responseText = result.response.text();
      return JSON.parse(responseText) as Record<string, unknown>;
    } catch (err) {
      // Graceful fallback: image extraction failure must never block submission
      this.logger.warn(`Gemini image extraction failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Uploads a flyer image buffer to Supabase Storage.
   * Stored under a unique timestamped path in the 'hackathon-flyers' bucket.
   * Returns the public storage path, or null if upload fails.
   *
   * @param buffer    Image buffer to upload
   * @param mimeType  Image MIME type for Content-Type header
   * @returns Storage path string (not a public URL) or null on failure
   */
  private async uploadFlyerImage(
    buffer: Buffer,
    mimeType: string,
  ): Promise<string | null> {
    try {
      const ext = mimeType.split('/')[1] || 'jpg';
      const path = `flyers/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      const { error } = await this.supabase.storage
        .from(FLYER_BUCKET)
        .upload(path, buffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (error) {
        this.logger.warn(`Supabase image upload failed: ${error.message}`);
        return null;
      }

      return path;
    } catch (err) {
      this.logger.warn(`Image upload exception: ${String(err)}`);
      return null;
    }
  }

  // ── Public: Extraction Endpoints ──────────────────────────────────────────

  /**
   * Path A — URL extraction.
   * Server-side fetches the page, scrapes OG tags, extracts visible text,
   * and passes text to Gemini for structured field extraction.
   * Also runs duplicate detection against the URL.
   *
   * Includes SSRF mitigations (HTTPS only, 10s timeout, non-private IP check, 1MB size limit).
   *
   * @param rawUrl Target event URL to fetch and extract from
   * @returns OG metadata + Gemini-extracted fields + rawSourceText + duplicate match
   */
  async extractFromUrl(rawUrl: string) {
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
    let rawSourceText: string | null = null;
    let extracted: Record<string, unknown> | null = null;

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

        // ── Open Graph & fallback meta tag extraction (legacy path, still used for logo + OG title)
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

        // ── Extract visible page text for Gemini and for rawSourceText storage
        rawSourceText = extractVisibleText(html);

        // ── Run Gemini structured extraction on the page text
        if (rawSourceText) {
          extracted = await this.runGeminiTextExtraction(rawSourceText);
        }
      }
    } catch {
      // Graceful fallback: If scraping fails/times out, proceed with user manual entry
      this.logger.warn(`URL fetch failed for ${rawUrl} — falling back to empty form`);
    }

    // Check if URL or title matches an existing non-flagged hackathon (duplicate guard)
    const duplicate = await this.checkDuplicate(rawUrl, title);

    return {
      // OG data (for logo primarily)
      title: extracted?.title ?? title,
      description: extracted?.shortDescription ?? description,
      logoUrl,
      siteName,
      // AI-extracted rich fields
      extracted,
      // Admin-stored source snapshot (not sent to public API — included here for the frontend to pass back)
      rawSourceText,
      // Duplicate match if found
      duplicate,
    };
  }

  /**
   * Path B — Image or pasted-text extraction.
   * For images: runs Gemini multimodal OCR + uploads flyer to Supabase Storage.
   * For pasted text: runs Gemini text extraction directly.
   *
   * @param imageBuffer  Optional raw image bytes (if user uploaded a flyer)
   * @param mimeType     MIME type of the image (required if imageBuffer is provided)
   * @param pastedText   Optional raw text pasted by the user (WhatsApp post, etc.)
   * @returns Extraction result + rawSourceText + imageStoragePath + lowConfidenceFields
   */
  async extractFromImageOrText(
    imageBuffer?: Buffer,
    mimeType?: string,
    pastedText?: string,
  ) {
    if (!imageBuffer && !pastedText) {
      throw new BadRequestException('Either an image file or pasted text must be provided');
    }

    let extracted: Record<string, unknown> | null = null;
    let rawSourceText: string | null = null;
    let storedImagePath: string | null = null;

    if (imageBuffer && mimeType) {
      // ── Image path: Gemini multimodal OCR
      extracted = await this.runGeminiImageExtraction(imageBuffer, mimeType);
      // rawSourceText for image submissions = the OCR transcript from Gemini (if available)
      rawSourceText = extracted ? JSON.stringify(extracted) : null;

      // Upload flyer to Supabase Storage for admin review
      storedImagePath = await this.uploadFlyerImage(imageBuffer, mimeType);
    } else if (pastedText) {
      // ── Pasted text path: Gemini text extraction
      rawSourceText = pastedText.slice(0, 50000); // Cap at 50k chars
      extracted = await this.runGeminiTextExtraction(rawSourceText);
    }

    return {
      extracted,
      rawSourceText,
      imageStoragePath: storedImagePath,
      lowConfidenceFields: (extracted?.low_confidence_fields as string[]) ?? [],
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
      // Check 1: Canonical normalized URL equality (skip null externalUrls)
      if (h.externalUrl && normalizeUrl(h.externalUrl) === normalized) {
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
   * rawSourceText and imageUrl are stored but NEVER returned in the public response.
   *
   * @param dto Create payload with all event details (from frontend review form)
   * @param userId Authenticated submitter user ID
   * @returns Created Hackathon record (without admin-only fields)
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

    const hackathon = await this.prisma.hackathon.create({
      data: {
        title: dto.title,
        externalUrl: dto.externalUrl || null,
        logoUrl: dto.logoUrl || null,
        description: dto.description || null,
        // AI-extracted rich fields
        shortDescription: dto.shortDescription || null,
        fullDescription: dto.fullDescription || null,
        eligibility: dto.eligibility || null,
        teamSize: dto.teamSize || null,
        prizePoolTotal: dto.prizePoolTotal || null,
        prizeBreakdown: dto.prizeBreakdown ? dto.prizeBreakdown : undefined,
        applicationDeadline: dto.applicationDeadline
          ? new Date(dto.applicationDeadline)
          : null,
        extractionSource: dto.extractionSource || 'manual',
        // Admin-only fields — stored but stripped from public response below
        rawSourceText: dto.rawSourceText || null,
        imageUrl: dto.imageUrl || null,
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

    // Return the hackathon without admin-only fields
    const { rawSourceText: _rawSourceText, imageUrl: _imageUrl, ...publicHackathon } = hackathon;
    return publicHackathon;
  }

  /**
   * Fetches all non-flagged hackathons and groups them into proximity tiers relative to the user.
   * Tiers:
   * - same_city: distance <= 50 km
   * - same_country: distance <= 500 km
   * - elsewhere: distance > 500 km or virtual/unspecified location
   *
   * Admin-only fields (rawSourceText, imageUrl) are excluded from all public responses.
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

      // ── Return public fields only; rawSourceText, imageUrl, extractionSource are excluded
      return {
        id: h.id,
        title: h.title,
        logoUrl: h.logoUrl,
        // Descriptions: prefer AI-extracted shortDescription, fallback to legacy description
        description: h.shortDescription || h.description,
        shortDescription: h.shortDescription,
        fullDescription: h.fullDescription,
        eligibility: h.eligibility,
        teamSize: h.teamSize,
        prizePoolTotal: h.prizePoolTotal,
        prizeBreakdown: h.prizeBreakdown,
        applicationDeadline: h.applicationDeadline,
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
   * Admin-only fields (rawSourceText, imageUrl, extractionSource) are excluded.
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

    // Destructure to exclude admin-only fields from the public response
    const {
      rawSourceText: _raw,
      imageUrl: _img,
      extractionSource: _src,
      ...publicFields
    } = hackathon;

    return {
      ...publicFields,
      joinCount: hackathon._count.joins,
      vouchCount: hackathon._count.vouches,
      hasJoined,
      hasVouched,
      participants: hackathon.joins.map((j) => j.user),
    };
  }

  /**
   * Admin-only: Returns the raw source text and image URL for a hackathon listing.
   * Used by the admin panel to review pending/flagged submissions against their original source.
   * Throws NotFoundException if the hackathon doesn't exist.
   *
   * @param id Hackathon ID
   * @returns rawSourceText, imageUrl, extractionSource, and externalUrl (live reference)
   */
  async getAdminSource(id: string) {
    const hackathon = await this.prisma.hackathon.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        rawSourceText: true,
        imageUrl: true,
        extractionSource: true,
        externalUrl: true,
        status: true,
      },
    });

    if (!hackathon) {
      throw new NotFoundException('Hackathon not found');
    }

    return hackathon;
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
