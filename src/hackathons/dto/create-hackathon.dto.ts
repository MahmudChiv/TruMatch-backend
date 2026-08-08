/**
 * DTO for creating a new hackathon/event listing.
 * Covers all three submission paths: URL (AI-assisted), Image (OCR-assisted), and Manual.
 * All fields beyond title are optional — the frontend only sends what it has.
 */
export class CreateHackathonDto {
  // ── Required ────────────────────────────────────────────────────────────────
  title: string;

  // ── Source tracking ─────────────────────────────────────────────────────────
  /** Which input path produced this submission: 'url' | 'image' | 'manual' */
  extractionSource?: 'url' | 'image' | 'manual';

  // ── Event identity ──────────────────────────────────────────────────────────
  /** Required for URL/manual paths; Gemini should attempt to extract from images.
   *  Nullable when submitting via image and no URL is available. */
  externalUrl?: string;
  logoUrl?: string;

  // ── Descriptions (OG + AI-extracted) ────────────────────────────────────────
  /** Legacy OG description; kept for backwards compat. */
  description?: string;
  /** Concise blurb AI extracted from page/image. */
  shortDescription?: string;
  /** Full event body text AI extracted. */
  fullDescription?: string;

  // ── Event details (AI-extracted) ─────────────────────────────────────────────
  /** Who can participate, e.g. "Open to all university students". */
  eligibility?: string;
  /** Team size, stored as text e.g. "2–4 members". */
  teamSize?: string;

  // ── Prize (AI-extracted) ─────────────────────────────────────────────────────
  /** Total prize pool as-written: "₦1,000,000" — never parsed to a number. */
  prizePoolTotal?: string;
  /** Structured prize breakdown; only populate if source explicitly categorizes it. */
  prizeBreakdown?: Array<{ place: string; prize: string }>;
  /** Legacy display-only prize info text. */
  prizeInfo?: string;

  // ── Dates ────────────────────────────────────────────────────────────────────
  startDate?: string;
  endDate?: string;
  submissionDeadline?: string;
  /** Separate application/registration deadline (distinct from submission deadline). */
  applicationDeadline?: string;

  // ── Location ─────────────────────────────────────────────────────────────────
  venueType?: 'physical' | 'virtual' | 'hybrid';
  locationLabel?: string;
  latitude?: number;
  longitude?: number;

  // ── Taxonomy ─────────────────────────────────────────────────────────────────
  tags?: string[];

  // ── Admin-only passthrough fields ──────────────────────────────────────────
  // Passed from the frontend extraction response, stored server-side as admin-only data.
  // Never returned in public API responses. Included here so the controller can bind them.
  /** Visible page text snapshot (URL path) or OCR transcript (image path) — admin-only */
  rawSourceText?: string;
  /** Supabase Storage path for the uploaded flyer image — admin-only */
  imageUrl?: string;
}
