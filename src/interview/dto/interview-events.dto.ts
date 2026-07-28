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
}

/** Interview is fully complete — commitment score is ready */
export interface InterviewCompleteEvent {
  sessionId: string;
  commitmentScore: number;
  githubScore: number;
  interviewScore: number;
  declaredHoursPerDay: number | null;
  flaggedDiscrepancies: FlaggedDiscrepancy[];
  communicationStyleNotes: string;
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
 * The structured JSON output Gemini produces at the end of the interview.
 * Enforced via Gemini's responseSchema (controlled generation) — never free-text parsed.
 * Note: flagged_discrepancies items use snake_case (user_explanation) to match
 * what Gemini returns from the responseSchema.
 */
export interface InterviewAnalysis {
  specificity_score: number;           // 0-100
  declared_hours_per_day: number;
  flagged_discrepancies: Array<{
    repo: string;
    issue: string;
    user_explanation: string;          // snake_case — matches Gemini responseSchema
  }>;
  communication_style_notes: string;
}

// ─── Transcript entry ─────────────────────────────────────────────────────────

export interface TranscriptEntry {
  role: 'assistant' | 'user';
  content: string;
  timestamp: string; // ISO 8601
}
