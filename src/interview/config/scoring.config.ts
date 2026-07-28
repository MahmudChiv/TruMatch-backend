/**
 * Scoring weights for the composite commitment_score.
 *
 * IMPORTANT: These are initial reasonable defaults based on the assumption that
 * objective GitHub activity data (commit cadence, PR merge rate, issue close rate)
 * is a stronger signal than self-reported interview answers. They are NOT
 * empirically derived from real outcome data.
 *
 * Tune these once real outcome data (peer ratings, project completion rates,
 * post-project surveys) becomes available to validate or adjust the balance.
 *
 * Invariant that must always hold: GITHUB_SCORE_WEIGHT + INTERVIEW_SCORE_WEIGHT === 1
 */
export const GITHUB_SCORE_WEIGHT = 0.7;
export const INTERVIEW_SCORE_WEIGHT = 0.3;
