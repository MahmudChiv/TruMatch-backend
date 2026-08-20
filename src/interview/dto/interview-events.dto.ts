// ─── GitHub confidence tier ───────────────────────────────────────────────────

export type GithubConfidenceTier = 'high' | 'low' | 'insufficient';

// ─── WebSocket event payload shapes ──────────────────────────────────────────

/** Client → Server: start the interview */
export interface InterviewStartPayload {
  userId: string;
}

/** Client → Server: submit an answer */
export interface InterviewAnswerPayload {
  userId: string;
  sessionId: string;
  answer: string;
}

/** Client → Server: signal the interview is complete */
export interface InterviewCompletePayload {
  userId: string;
  sessionId: string;
}

// ─── Server → Client events ───────────────────────────────────────────────────

/** Client → Server: resume an existing interview */
export interface InterviewResumePayload {
  userId: string;
}

/** Returned in acknowledgement or emitted event for interview:resume */
export interface InterviewResumeResponseEvent {
  resumed: boolean;
  sessionId: string;
  transcript: TranscriptEntry[];
  preInterviewWarning: string;
  isFinished?: boolean;
}

/** Returned in the acknowledgement of interview:start */
export interface InterviewStartResponseEvent {
  sessionId: string;
  preInterviewWarning: string;
}

/** Streamed text chunk from Gemini */
export interface InterviewChunkEvent {
  sessionId: string;
  chunk: string;
}

/** A full AI message has finished streaming */
export interface InterviewMessageCompleteEvent {
  sessionId: string;
  fullText: string;
  turnIndex: number;
  isInterviewFinished?: boolean;
}

/** Interview is fully complete — commitment score is ready */
export interface InterviewCompleteEvent {
  sessionId: string;
  commitmentScore: number;
  githubScore: number;
  interviewScore: number;
  appliedGithubWeight: number;
  appliedInterviewWeight: number;
  declaredHoursPerDay: number | null;
  flaggedDiscrepancies: FlaggedDiscrepancy[];
  communicationStyleNotes: string;
  discrepancyResolutionPattern: number | null;
  scoreExplanationSummary: string | null;
  githubConfidence: GithubConfidenceTier;
  preInterviewWarning: string;
}

/** An unrecoverable error occurred */
export interface InterviewErrorEvent {
  sessionId: string;
  reason: string;
}

// ─── Structured output schema (what Gemini must return via responseSchema) ────

export interface FlaggedDiscrepancy {
  repo: string;
  issue: string;
  userExplanation: string;
}

/**
 * Individual discrepancy explanation with capped reduction tracking.
 * Used in the extended analysis to transparently record how much each
 * explanation reduced its discrepancy's weight (never more than MAX_DISCREPANCY_REDUCTION).
 */
export interface DiscrepancyExplanation {
  repo: string;
  issue: string;
  original_weight: number;      // weight this discrepancy would have had without explanation
  explanation_quality: number;   // 0-1, how concrete/verifiable the explanation was (from Gemini)
  reduction_applied: number;     // actual reduction applied (capped at MAX_DISCREPANCY_REDUCTION)
}

/**
 * The structured JSON output Gemini produces at the end of the interview.
 * Enforced via Gemini's responseSchema (controlled generation) — never free-text parsed.
 * Note: uses snake_case to match what Gemini returns from the responseSchema.
 */
export interface InterviewAnalysis {
  specificity_score: number;           // 0-100
  declared_hours_per_day: number;
  role_tags: string[];                 // Parsed role tags: Backend, Frontend, Mobile, AI/ML, Design/UI, Product/PM, DevOps
  primary_stack: string;               // User's self-reported primary tech stack
  flagged_discrepancies: Array<{
    repo: string;
    issue: string;
    user_explanation: string;          // snake_case — matches Gemini responseSchema
  }>;
  communication_style_notes: string;
  bio_summary: string;                 // User's self-described background from early interview question
  discrepancy_explanations: Array<{
    repo: string;
    issue: string;
    original_weight: number;
    explanation_quality: number;        // 0-1, assessed by Gemini
    reduction_applied: number;          // capped at MAX_DISCREPANCY_REDUCTION
  }>;
}

// ─── Transcript entry ─────────────────────────────────────────────────────────

export interface TranscriptEntry {
  role: 'assistant' | 'user';
  content: string;
  timestamp: string; // ISO 8601
}
