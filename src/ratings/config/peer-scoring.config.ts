/**
 * Peer scoring configuration for TruMatch commitment scoring engine.
 *
 * ─── DESIGN RATIONALE ───────────────────────────────────────────────────────
 *
 * As real team history accumulates, peer-verified performance gradually
 * outweighs initial self-reported interview answers and static GitHub metrics.
 *
 * However, to protect against a single small or biased rating batch dominating
 * a user's score too early, the peer weight scales according to the number of
 * DISTINCT teams (`distinct_teams_rated`) the user has been rated in, rather
 * than raw rating count.
 *
 * `PEER_WEIGHT_CURVE`:
 * - 0 distinct teams: peer_weight = 0.00
 * - 1 distinct team:  peer_weight = 0.55
 * - 2-3 distinct teams: peer_weight = 0.85
 * - 4+ distinct teams: peer_weight = 0.95 (capped)
 *
 * As `peer_weight` increases, the remaining weight (`1 - peer_weight`) is split
 * proportionally between `github_weight` and `interview_weight` based on the user's
 * GitHub confidence tier, keeping all three weights summing to 1.0:
 *
 *   remaining = 1 - peer_weight
 *   github_weight = remaining * base_github_weight
 *   interview_weight = remaining * base_interview_weight
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const PEER_WEIGHT_CURVE: Record<number, number> = {
  0: 0.0,
  1: 0.55,
  2: 0.85,
  3: 0.85,
  4: 0.95, // Cap for 4+ distinct teams
};

/**
 * Returns the peer weight for a given count of distinct teams rated.
 */
export function getPeerWeight(distinctTeamsCount: number): number {
  if (distinctTeamsCount <= 0) return PEER_WEIGHT_CURVE[0];
  if (distinctTeamsCount === 1) return PEER_WEIGHT_CURVE[1];
  if (distinctTeamsCount === 2 || distinctTeamsCount === 3) return PEER_WEIGHT_CURVE[2];
  return PEER_WEIGHT_CURVE[4]; // 4+
}

/**
 * Configurable window in days after which unmutual ratings automatically become visible.
 * Default: 7 days.
 */
export const RATING_VISIBILITY_WINDOW_DAYS = 7;

/**
 * Positive modifier for `would_work_again = true`.
 * Added to the rating's base score (0-100 scale).
 */
export const WOULD_WORK_AGAIN_BONUS_POINTS = 5;
