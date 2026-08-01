/**
 * Scoring configuration for TruMatch commitment scores.
 *
 * ─── DESIGN RATIONALE ───────────────────────────────────────────────────────
 *
 * The default weights (70% GitHub / 30% interview) reflect the assumption that
 * objective, verifiable GitHub activity data is a stronger commitment signal
 * than self-reported interview answers.
 *
 * HOWEVER, when a user has sparse or missing GitHub data, those weights would
 * unfairly penalise them — a score of 0 on a 70%-weighted component would cap
 * their composite at 30 even if the interview was perfect.
 *
 * The dynamic weighting below is a DESIGNED COMPENSATION for sparse GitHub
 * evidence, NOT a general downgrade of GitHub's importance. When GitHub data
 * is abundant and trustworthy (high confidence), we trust it heavily. When it's
 * thin or absent, we shift weight toward the interview so the user still has a
 * fair path to an accurate score.
 *
 * These are NOT empirically derived from real outcome data. Tune once peer
 * ratings and project completion rates provide validation data.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Confidence tier type ──────────────────────────────────────────────────────

export type GithubConfidenceTier = 'high' | 'low' | 'insufficient';

// ─── Default weights (high-confidence case) ────────────────────────────────────

/** Default GitHub weight — used when github_confidence is 'high' */
export const GITHUB_SCORE_WEIGHT = 0.7;

/** Default interview weight — used when github_confidence is 'high' */
export const INTERVIEW_SCORE_WEIGHT = 0.3;

// ─── Confidence-based dynamic weights ──────────────────────────────────────────

export interface ConfidenceWeights {
  githubWeight: number;
  interviewWeight: number;
}

/**
 * Returns the scoring weights for a given GitHub confidence tier.
 *
 * - high:         70/30 — sufficient data to trust GitHub signals at face value
 * - low:          35/65 — some data exists but not enough for full confidence;
 *                         shift weight toward interview to compensate
 * - insufficient: 0/100 — no qualifying repos; score is fully interview-driven
 *
 * This is a designed compensation for sparse GitHub evidence, not a general
 * downgrade of GitHub's importance. A user with high confidence gets the same
 * 70/30 split as always.
 */
export function getConfidenceWeights(tier: GithubConfidenceTier): ConfidenceWeights {
  switch (tier) {
    case 'high':
      return { githubWeight: GITHUB_SCORE_WEIGHT, interviewWeight: INTERVIEW_SCORE_WEIGHT };
    case 'low':
      return { githubWeight: 0.35, interviewWeight: 0.65 };
    case 'insufficient':
      return { githubWeight: 0.0, interviewWeight: 1.0 };
    default:
      // Defensive: unknown tier → treat as insufficient (safe default)
      return { githubWeight: 0.0, interviewWeight: 1.0 };
  }
}

// ─── Confidence threshold constants ────────────────────────────────────────────

/** Minimum qualifying repos required for 'high' confidence */
export const MIN_REPOS_HIGH_CONFIDENCE = 3;

/** Minimum total commits across qualifying repos for 'high' confidence */
export const MIN_COMMITS_HIGH_CONFIDENCE = 50;

/** Account age threshold in days — accounts < 1 year old are treated as 'new developer' */
export const ACCOUNT_AGE_THRESHOLD_DAYS = 365;

// ─── Discrepancy scoring caps ──────────────────────────────────────────────────

/**
 * Maximum percentage by which a discrepancy's weight can be reduced when the
 * user provides an explanation. An explanation can reduce the penalty by up to
 * 50%, but never fully erase it — there's always a residual signal.
 *
 * Example: if a discrepancy normally costs 10 points, a good explanation can
 * reduce that to at most 5 points, never 0.
 */
export const MAX_DISCREPANCY_REDUCTION = 0.5;

// ─── Warning texts ─────────────────────────────────────────────────────────────

/**
 * Explicit warnings placed at specific points in the user flow.
 * These are constants so they're consistent across backend (sent via events)
 * and can be referenced in AI-generated content like the Team Charter.
 */
export const WARNING_TEXTS = {
  /**
   * Shown before the interview starts.
   * Framed as an honest incentive explanation, not a threat.
   */
  preInterview:
    'Your responses in this interview directly shape your Commitment Score, ' +
    'and your score determines the calibre of teammates you\'ll be matched with. ' +
    'The more specific and honest your answers, the more accurately we can connect ' +
    'you with people who match your level of dedication. There are no trick questions - ' +
    'just be genuine about your experience and availability.',

  /**
   * Shown when both users accept a team match.
   * Framed as a mutual expectation, not an optional afterthought.
   */
  teamFormation:
    'After this project wraps up, you\'ll both have the chance to rate each other\'s ' +
    'commitment honestly. These ratings are a core part of how TruMatch stays accurate - ' +
    'they help future teammates know what to expect. Think of it as a mutual agreement: ' +
    'you\'re each investing in the other\'s reputation by giving honest, constructive feedback.',

  /**
   * Included in the AI-generated Team Charter for any teammate with no prior peer ratings.
   * Framed as normal onboarding context, not a warning about the person.
   */
  charterUnratedTeammate:
    'This teammate\'s commitment score is currently based on their self-reported interview ' +
    'responses and GitHub activity - they haven\'t completed a project on TruMatch yet, so ' +
    'no peer ratings are available. This is completely normal for new members. After this ' +
    'project, the team will have the opportunity to rate one another, which will add a ' +
    'peer-confirmed dimension to everyone\'s score.',
} as const;

