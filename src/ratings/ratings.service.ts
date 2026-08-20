import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRatingDto } from './dto/create-rating.dto';
import {
  FullRatingDto,
  AnonymousCommentDto,
  PublicPeerRatingSummaryDto,
} from './dto/rating-response.dto';
import {
  getPeerWeight,
  RATING_VISIBILITY_WINDOW_DAYS,
  WOULD_WORK_AGAIN_BONUS_POINTS,
} from './config/peer-scoring.config';
import { getConfidenceWeights } from '../interview/config/scoring.config';
import type { GithubConfidenceTier } from '../interview/config/scoring.config';
import { RatingsGateway } from './ratings.gateway';

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RatingsGateway,
  ) {}

  /**
   * Submit a rating from a rater to a ratee for a specific team.
   * Enforces:
   * - Endpoint level check: rater and ratee must both be in team_members for teamId.
   * - Cannot rate self.
   * - Unique rating per (teamId, raterId, rateeId).
   * - Scores between 1 and 5.
   * - Blind mutual rating check: visibleAt stays null until counterpart has rated,
   *   or 7-day window passes.
   * - Immediately recalculates ratee's commitment score.
   */
  async submitRating(raterId: string, dto: CreateRatingDto) {
    if (raterId === dto.rateeId) {
      throw new BadRequestException('You cannot rate yourself');
    }

    if (
      dto.deliveredScore < 1 ||
      dto.deliveredScore > 5 ||
      dto.communicationScore < 1 ||
      dto.communicationScore > 5
    ) {
      throw new BadRequestException('Scores must be integers between 1 and 5');
    }

    // Verify team membership for both users
    const memberships = await this.prisma.teamMember.findMany({
      where: {
        teamId: dto.teamId,
        userId: { in: [raterId, dto.rateeId] },
      },
    });

    if (memberships.length < 2) {
      throw new ForbiddenException(
        'Both users must be members of the specified team to submit a rating',
      );
    }

    // Check for existing rating
    const existing = await this.prisma.rating.findUnique({
      where: {
        teamId_raterId_rateeId: {
          teamId: dto.teamId,
          raterId,
          rateeId: dto.rateeId,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        'You have already rated this teammate for this team',
      );
    }

    // Check if counterpart rating exists (blind mutual condition)
    const counterpartRating = await this.prisma.rating.findUnique({
      where: {
        teamId_raterId_rateeId: {
          teamId: dto.teamId,
          raterId: dto.rateeId,
          rateeId: raterId,
        },
      },
    });

    let visibleAt: Date | null = null;
    let isMutualNow = false;

    if (counterpartRating) {
      // Both have rated each other! Set visibleAt for both.
      visibleAt = new Date();
      isMutualNow = true;
    }

    // Create the rating
    const rating = await this.prisma.rating.create({
      data: {
        teamId: dto.teamId,
        raterId,
        rateeId: dto.rateeId,
        deliveredScore: Math.round(dto.deliveredScore),
        communicationScore: Math.round(dto.communicationScore),
        wouldWorkAgain: dto.wouldWorkAgain,
        comment: dto.comment ? dto.comment.trim() : null,
        visibleAt,
      },
    });

    if (isMutualNow && counterpartRating && !counterpartRating.visibleAt) {
      await this.prisma.rating.update({
        where: { id: counterpartRating.id },
        data: { visibleAt },
      });
    }

    // Immediate commitment score recalculation for ratee
    await this.recalculateCommitmentScore(dto.rateeId);

    this.logger.log(
      `Rating submitted by ${raterId} for ${dto.rateeId} in team ${dto.teamId} (visibleAt: ${visibleAt?.toISOString() ?? 'null'})`,
    );

    return rating;
  }

  /**
   * Called by BullMQ daily job to reveal ratings whose 7-day window has expired.
   */
  async checkAndUnlockExpiredRatings(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RATING_VISIBILITY_WINDOW_DAYS);

    const expiredRatings = await this.prisma.rating.findMany({
      where: {
        visibleAt: null,
        createdAt: { lte: cutoffDate },
      },
      select: { id: true, rateeId: true },
    });

    if (expiredRatings.length === 0) return 0;

    const now = new Date();
    await this.prisma.rating.updateMany({
      where: {
        id: { in: expiredRatings.map((r) => r.id) },
      },
      data: { visibleAt: now },
    });

    // Recalculate commitment score for all affected ratees
    const affectedRateeIds = Array.from(
      new Set(expiredRatings.map((r) => r.rateeId)),
    );
    for (const rateeId of affectedRateeIds) {
      await this.recalculateCommitmentScore(rateeId);
    }

    this.logger.log(
      `Unlocked ${expiredRatings.length} expired ratings for ${affectedRateeIds.length} users`,
    );
    return expiredRatings.length;
  }

  /**
   * Computes peer_rating_score as a trimmed-mean of a user's ratings across all received ratings,
   * with would_work_again factored in as a positive modifier.
   * Computes peer_weight based on distinct team count (PEER_WEIGHT_CURVE).
   *
   * SECTION 7 ERROR HANDLING:
   * If peer_rating_score computation fails for any reason, defaults peer_weight to 0
   * for that cycle rather than erroring the whole scoring pipeline.
   */
  async computePeerRatingScore(userId: string): Promise<{
    peerRatingScore: number | null;
    peerWeight: number;
    distinctTeamsRated: number;
  }> {
    try {
      const ratings = await this.prisma.rating.findMany({
        where: { rateeId: userId },
        select: {
          teamId: true,
          deliveredScore: true,
          communicationScore: true,
          wouldWorkAgain: true,
        },
      });

      if (ratings.length === 0) {
        return {
          peerRatingScore: null,
          peerWeight: 0,
          distinctTeamsRated: 0,
        };
      }

      // Compute distinct teams count
      const distinctTeams = new Set(ratings.map((r) => r.teamId));
      const distinctTeamsRated = distinctTeams.size;

      // Compute peer_weight from curve
      const peerWeight = getPeerWeight(distinctTeamsRated);

      // Map each rating to a 0-100 score + wouldWorkAgain bonus
      const itemScores = ratings.map((r) => {
        // Base score on 20-100 scale ((delivered + comm) / 2 * 20)
        const baseScore = ((r.deliveredScore + r.communicationScore) / 2) * 20;
        const bonus = r.wouldWorkAgain ? WOULD_WORK_AGAIN_BONUS_POINTS : 0;
        return Math.min(100, baseScore + bonus);
      });

      let peerRatingScore: number;

      if (itemScores.length >= 5) {
        // Trimmed mean: drop 1 lowest and 1 highest
        itemScores.sort((a, b) => a - b);
        const trimmed = itemScores.slice(1, -1);
        const sum = trimmed.reduce((acc, s) => acc + s, 0);
        peerRatingScore = sum / trimmed.length;
      } else {
        // Arithmetic mean for < 5 ratings
        const sum = itemScores.reduce((acc, s) => acc + s, 0);
        peerRatingScore = sum / itemScores.length;
      }

      peerRatingScore = Math.round(peerRatingScore * 100) / 100;

      return {
        peerRatingScore,
        peerWeight,
        distinctTeamsRated,
      };
    } catch (err) {
      this.logger.error(
        `Error computing peer rating score for user ${userId}: ${(err as Error).message}`,
      );
      // SECTION 7: Fail-safe fallback to peer_weight = 0
      return {
        peerRatingScore: null,
        peerWeight: 0,
        distinctTeamsRated: 0,
      };
    }
  }

  /**
   * Recalculates the full CommitmentScore for a user incorporating GitHub, interview, and peer ratings.
   * Rebalances github_weight and interview_weight proportionally as peer_weight increases.
   */
  async recalculateCommitmentScore(userId: string): Promise<void> {
    const existingScore = await this.prisma.commitmentScore.findUnique({
      where: { userId },
    });

    if (!existingScore) {
      // User has no CommitmentScore yet (e.g. hasn't finished interview)
      return;
    }

    const metrics = await this.prisma.githubMetrics.findUnique({
      where: { userId },
    });
    const confidenceTier = (metrics?.githubConfidence ??
      'insufficient') as GithubConfidenceTier;

    // Get base dynamic weights from GitHub confidence tier
    const baseWeights = getConfidenceWeights(confidenceTier);

    // Compute peer score and weight curve
    const { peerRatingScore, peerWeight, distinctTeamsRated } =
      await this.computePeerRatingScore(userId);

    let appliedGithubWeight: number;
    let appliedInterviewWeight: number;
    let appliedPeerWeight: number;
    let commitmentScore: number;

    if (peerRatingScore !== null && peerWeight > 0) {
      appliedPeerWeight = peerWeight;
      const remaining = 1 - peerWeight;

      // Rebalance GitHub and interview weights proportionally
      appliedGithubWeight =
        Math.round(remaining * baseWeights.githubWeight * 1000) / 1000;
      appliedInterviewWeight =
        Math.round(remaining * baseWeights.interviewWeight * 1000) / 1000;

      commitmentScore =
        Math.round(
          (existingScore.githubScore * appliedGithubWeight +
            existingScore.interviewScore * appliedInterviewWeight +
            peerRatingScore * appliedPeerWeight) *
            100,
        ) / 100;
    } else {
      appliedPeerWeight = 0;
      appliedGithubWeight = baseWeights.githubWeight;
      appliedInterviewWeight = baseWeights.interviewWeight;
      commitmentScore =
        Math.round(
          (existingScore.githubScore * appliedGithubWeight +
            existingScore.interviewScore * appliedInterviewWeight) *
            100,
        ) / 100;
    }

    await this.prisma.commitmentScore.update({
      where: { userId },
      data: {
        commitmentScore,
        peerRatingScore,
        peerWeight,
        appliedPeerWeight,
        distinctTeamsRated,
        appliedGithubWeight,
        appliedInterviewWeight,
      },
    });

    // Update denormalized score on User model
    await this.prisma.user.update({
      where: { id: userId },
      data: { commitmentScore },
    });

    this.gateway.emitRatingUpdated(userId, {
      commitmentScore,
      peerRatingScore,
      peerWeight: appliedPeerWeight,
      distinctTeamsRated,
    });
  }

  /**
   * SECTION 4 & SECTION 6: Get public peer rating summary for a user profile.
   * Strips rater_id and rater details at the serialization layer for all visible comments.
   */
  async getPublicPeerRatingSummary(
    userId: string,
  ): Promise<PublicPeerRatingSummaryDto> {
    const cs = await this.prisma.commitmentScore.findUnique({
      where: { userId },
      select: {
        peerRatingScore: true,
        distinctTeamsRated: true,
        appliedPeerWeight: true,
      },
    });

    // Fetch visible ratings with comments
    const visibleRatings = await this.prisma.rating.findMany({
      where: {
        rateeId: userId,
        visibleAt: { not: null },
        comment: { not: null },
      },
      select: {
        id: true,
        teamId: true,
        deliveredScore: true,
        communicationScore: true,
        wouldWorkAgain: true,
        comment: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // SECTION 4: Serialization layer anonymity - raterId is NOT in the select statement!
    const comments: AnonymousCommentDto[] = visibleRatings
      .filter((r) => Boolean(r.comment && r.comment.trim().length > 0))
      .map((r) => ({
        id: r.id,
        teamId: r.teamId,
        comment: r.comment!,
        deliveredScore: r.deliveredScore,
        communicationScore: r.communicationScore,
        wouldWorkAgain: r.wouldWorkAgain,
        createdAt: r.createdAt,
      }));

    return {
      peerRatingScore: cs?.peerRatingScore ?? null,
      distinctTeamsRated: cs?.distinctTeamsRated ?? 0,
      appliedPeerWeight: cs?.appliedPeerWeight ?? 0,
      comments,
    };
  }

  /**
   * Get ratings for a team.
   * Returns full details for ratings authored by requesterId,
   * but anonymizes (omits raterId) for other ratings visible to the user.
   */
  async getRatingsForTeam(teamId: string, requesterId: string) {
    // Enforce team membership
    const membership = await this.prisma.teamMember.findUnique({
      where: {
        teamId_userId: { teamId, userId: requesterId },
      },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this team');
    }

    const ratings = await this.prisma.rating.findMany({
      where: { teamId },
      select: {
        id: true,
        teamId: true,
        raterId: true,
        rateeId: true,
        deliveredScore: true,
        communicationScore: true,
        wouldWorkAgain: true,
        comment: true,
        visibleAt: true,
        createdAt: true,
      },
    });

    return ratings.map((r) => {
      // If requester authored it, return full rating
      if (r.raterId === requesterId) {
        return r;
      }
      // If rating is visible and requester is ratee (or teammate), hide raterId for comment anonymity
      if (r.visibleAt) {
        const { raterId, ...anonymized } = r;
        return anonymized;
      }
      // If not visible yet to ratee, suppress comment
      const { raterId, comment, ...hiddenComment } = r;
      return { ...hiddenComment, comment: null };
    });
  }

  /**
   * Get pending rating opportunities for a user (unrated teammates in completed teams/hackathons).
   */
  async getPendingRatingsForUser(userId: string) {
    const userMemberships = await this.prisma.teamMember.findMany({
      where: { userId },
      include: {
        team: {
          include: {
            hackathon: true,
            members: {
              include: {
                user: {
                  select: {
                    id: true,
                    username: true,
                    name: true,
                    avatarUrl: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const pendingList: Array<{
      teamId: string;
      hackathonTitle: string;
      pendingRatees: Array<{
        id: string;
        username: string;
        name: string | null;
        avatarUrl: string | null;
      }>;
    }> = [];

    const now = new Date();

    for (const membership of userMemberships) {
      const team = membership.team;
      const hackathon = team.hackathon;

      // Condition: status == 'complete' OR hackathon endDate has passed OR endDate is null
      const isCompleted =
        team.status === 'complete' ||
        !hackathon.endDate ||
        hackathon.endDate <= now;

      if (!isCompleted) continue;

      // Find teammates user hasn't rated yet
      const teammateIds = team.members
        .map((m) => m.userId)
        .filter((id) => id !== userId);

      const givenRatings = await this.prisma.rating.findMany({
        where: {
          teamId: team.id,
          raterId: userId,
          rateeId: { in: teammateIds },
        },
        select: { rateeId: true },
      });

      const ratedSet = new Set(givenRatings.map((r) => r.rateeId));
      const unratedTeammates = team.members
        .filter((m) => m.userId !== userId && !ratedSet.has(m.userId))
        .map((m) => m.user);

      if (unratedTeammates.length > 0) {
        pendingList.push({
          teamId: team.id,
          hackathonTitle: hackathon.title,
          pendingRatees: unratedTeammates,
        });
      }
    }

    return pendingList;
  }

  /**
   * Helper to create in-app notifications and emit WS event.
   */
  async createNotification(userId: string, type: string, payload: any) {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        type,
        payload,
      },
    });

    this.gateway.emitNotification(userId, notification);
    return notification;
  }
}
