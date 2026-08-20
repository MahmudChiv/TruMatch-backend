import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RatingsGateway } from '../ratings/ratings.gateway';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  SchemaType,
} from '@google/generative-ai';

const GEMINI_MODEL = 'gemini-3.6-flash';

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

/** Structured response schema for Gemini candidate ranking & Team Charter generation */
const MATCHING_RESPONSE_SCHEMA: import('@google/generative-ai').ObjectSchema = {
  type: SchemaType.OBJECT as const,
  properties: {
    matches: {
      type: SchemaType.ARRAY,
      description: 'Ranked list of top candidate recommendations with tailored Team Charters',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          userId: { type: SchemaType.STRING, description: 'ID of the candidate' },
          matchReason: { type: SchemaType.STRING, description: 'Concise one-line explanation of why this candidate is a great match' },
          compatibilityScore: { type: SchemaType.NUMBER, description: 'Compatibility score 0-100' },
          teamCharter: {
            type: SchemaType.OBJECT,
            properties: {
              visionStatement: { type: SchemaType.STRING, description: 'Unified vision for what the team will build' },
              roleComplementarity: { type: SchemaType.STRING, description: 'How candidate and requester roles complement each other' },
              availabilityAgreement: { type: SchemaType.STRING, description: 'Agreed daily commitment and schedule alignment' },
              communicationProtocol: { type: SchemaType.STRING, description: 'Preferred communication channels and check-in frequency' },
              commitmentPromise: { type: SchemaType.STRING, description: 'Mutual promise regarding completion and accountability' },
            },
            required: [
              'visionStatement',
              'roleComplementarity',
              'availabilityAgreement',
              'communicationProtocol',
              'commitmentPromise',
            ],
          },
        },
        required: ['userId', 'matchReason', 'compatibilityScore', 'teamCharter'],
      },
    },
  },
  required: ['matches'],
};

export interface TeamCharter {
  visionStatement: string;
  roleComplementarity: string;
  availabilityAgreement: string;
  communicationProtocol: string;
  commitmentPromise: string;
}

export interface CandidateMatchResult {
  user: {
    id: string;
    username: string;
    name: string | null;
    avatarUrl: string | null;
    bio: string | null;
    roleTags: string[];
    primaryStack: string | null;
    commitmentScore: number;
    declaredHoursPerDay: number | null;
    githubConfidence: string;
  };
  matchReason: string;
  compatibilityScore: number;
  teamCharter: TeamCharter;
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);
  private readonly genAI: GoogleGenerativeAI;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() private readonly ratingsGateway?: RatingsGateway,
  ) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set in environment');
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  /**
   * Helper to parse target team size from hackathon teamSize field string
   */
  private parseTargetSize(teamSizeStr: string | null | undefined): number {
    if (!teamSizeStr) return 4;
    const match = teamSizeStr.match(/\d+/);
    if (match) {
      const parsed = parseInt(match[0], 10);
      if (!isNaN(parsed) && parsed >= 2 && parsed <= 10) return parsed;
    }
    return 4;
  }

  /**
   * Generates a fallback team charter when AI ranking fails or is skipped.
   */
  private generateFallbackCharter(
    userA: { name?: string | null; username: string; roleTags: string[]; primaryStack?: string | null },
    userB: { name?: string | null; username: string; roleTags: string[]; primaryStack?: string | null },
  ): TeamCharter {
    const nameA = userA.name || userA.username;
    const nameB = userB.name || userB.username;
    const rolesA = userA.roleTags.join(', ') || 'Developer';
    const rolesB = userB.roleTags.join(', ') || 'Developer';

    return {
      visionStatement: `Collaborate to build and ship a high-quality hackathon project bringing together ${nameA}'s background and ${nameB}'s skills.`,
      roleComplementarity: `${nameA} brings experience in ${rolesA} (${userA.primaryStack || 'General Stack'}), complementing ${nameB}'s focus on ${rolesB} (${userB.primaryStack || 'General Stack'}).`,
      availabilityAgreement: `Both members agree to align daily availability and communicate blockers promptly.`,
      communicationProtocol: `Daily progress updates via chat and shared project workspace.`,
      commitmentPromise: `Both teammates commit to delivering their assigned parts reliably through project submission.`,
    };
  }

  /**
   * Core AI Team Matching method.
   * Ranks eligible candidates for a hackathon and generates Team Charters in a single Gemini call.
   */
  async findTeammates(hackathonId: string, requestingUserId: string): Promise<{
    candidates: CandidateMatchResult[];
    targetSize: number;
    myTeam: any | null;
  }> {
    const hackathon = await this.prisma.hackathon.findUnique({
      where: { id: hackathonId },
    });
    if (!hackathon || hackathon.status === 'flagged') {
      throw new NotFoundException('Hackathon not found');
    }

    const targetSize = this.parseTargetSize(hackathon.teamSize);

    // Load requesting user's full profile
    const requester = await this.prisma.user.findUnique({
      where: { id: requestingUserId },
      include: {
        commitmentScore_rel: true,
        githubMetrics: true,
      },
    });
    if (!requester) throw new NotFoundException('Requesting user not found');

    // Check if requesting user is in an active team for this hackathon
    const existingMembership = await this.prisma.teamMember.findFirst({
      where: {
        userId: requestingUserId,
        team: { hackathonId },
      },
      include: { team: { include: { members: { include: { user: true } } } } },
    });
    const myTeam = existingMembership ? existingMembership.team : null;

    // Get all users who joined this hackathon
    const joined = await this.prisma.hackathonJoin.findMany({
      where: { hackathonId },
      select: { userId: true },
    });
    const joinedUserIds = joined.map((j) => j.userId);

    // Get users already on complete teams for this hackathon
    const completeTeamMembers = await this.prisma.teamMember.findMany({
      where: {
        team: { hackathonId, status: 'complete' },
      },
      select: { userId: true },
    });
    const excludeUserIds = new Set<string>([
      requestingUserId,
      ...completeTeamMembers.map((m) => m.userId),
    ]);

    // Exclude users already invited (pending or accepted) in either direction for this hackathon
    const existingInvites = await this.prisma.teamInvite.findMany({
      where: {
        hackathonId,
        OR: [
          { fromUserId: requestingUserId },
          { toUserId: requestingUserId },
        ],
        status: { in: ['pending', 'accepted'] },
      },
      select: { fromUserId: true, toUserId: true },
    });
    existingInvites.forEach((inv) => {
      excludeUserIds.add(inv.fromUserId);
      excludeUserIds.add(inv.toUserId);
    });

    const eligibleUserIds = joinedUserIds.filter((id) => !excludeUserIds.has(id));

    if (eligibleUserIds.length === 0) {
      return { candidates: [], targetSize, myTeam };
    }

    // Fetch candidate profiles
    const candidateUsers = await this.prisma.user.findMany({
      where: { id: { in: eligibleUserIds } },
      include: {
        commitmentScore_rel: true,
        githubMetrics: true,
      },
    });

    // Format compact candidate summaries for Gemini
    const requesterSummary = {
      id: requester.id,
      name: requester.name || requester.username,
      roles: requester.roleTags,
      stack: requester.primaryStack || 'Unspecified',
      commitmentScore: requester.commitmentScore,
      declaredHours: requester.commitmentScore_rel?.declaredHoursPerDay ?? null,
      communicationNotes: requester.commitmentScore_rel?.communicationNotes || 'None',
    };

    const candidateSummaries = candidateUsers.map((c) => ({
      id: c.id,
      name: c.name || c.username,
      bio: c.bio || '',
      roles: c.roleTags,
      stack: c.primaryStack || 'Unspecified',
      commitmentScore: c.commitmentScore,
      declaredHours: c.commitmentScore_rel?.declaredHoursPerDay ?? null,
      githubConfidence: c.githubMetrics?.githubConfidence || 'insufficient',
      communicationNotes: c.commitmentScore_rel?.communicationNotes || 'None',
    }));

    // AI Ranking & Charter generation call
    let rankedResults: CandidateMatchResult[] = [];

    try {
      const model = this.genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: MATCHING_RESPONSE_SCHEMA,
        },
        safetySettings: SAFETY_SETTINGS,
      });

      const prompt = `
You are TruMatch's AI Team Matching engine.
Your goal is to select and rank the best potential teammates for a user in a hackathon, and generate a tailored AI Team Charter for each candidate.

REQUESTING USER:
${JSON.stringify(requesterSummary, null, 2)}

ELIGIBLE CANDIDATES POOL (${candidateSummaries.length} available):
${JSON.stringify(candidateSummaries, null, 2)}

HACKATHON: "${hackathon.title}" (Target Team Size: ${targetSize})

INSTRUCTIONS:
1. Evaluate candidates based on:
   - Complementary roles (e.g. Frontend + Backend, AI/ML + Fullstack)
   - Compatible time availability (declared hours/day)
   - Reliable commitment scores
2. For each recommended candidate, generate an AI Team Charter containing:
   - visionStatement: concise 1-2 sentence mission for the team
   - roleComplementarity: how their roles & tech stacks combine
   - availabilityAgreement: clear expectation on daily commit hours
   - communicationProtocol: preferred updates & check-in habits
   - commitmentPromise: commitment signal & delivery guarantee
3. Return top candidates ranked by compatibility.

Produce the JSON response now.
      `.trim();

      const res = await model.generateContent(prompt);
      const rawText = res.response.text();
      const parsed = JSON.parse(rawText) as {
        matches: Array<{
          userId: string;
          matchReason: string;
          compatibilityScore: number;
          teamCharter: TeamCharter;
        }>;
      };

      if (Array.isArray(parsed?.matches)) {
        for (const match of parsed.matches) {
          const u = candidateUsers.find((c) => c.id === match.userId);
          if (u) {
            rankedResults.push({
              user: {
                id: u.id,
                username: u.username,
                name: u.name,
                avatarUrl: u.avatarUrl,
                bio: u.bio,
                roleTags: u.roleTags,
                primaryStack: u.primaryStack,
                commitmentScore: u.commitmentScore,
                declaredHoursPerDay: u.commitmentScore_rel?.declaredHoursPerDay ?? null,
                githubConfidence: u.githubMetrics?.githubConfidence || 'insufficient',
              },
              matchReason: match.matchReason,
              compatibilityScore: Math.round(match.compatibilityScore),
              teamCharter: match.teamCharter,
            });
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Gemini team matching failed: ${String(err)} — using commitment score fallback`);
    }

    // Fallback: if Gemini returned no matches or failed, rank candidates by commitmentScore descending
    if (rankedResults.length === 0) {
      const sortedCandidates = [...candidateUsers].sort(
        (a, b) => b.commitmentScore - a.commitmentScore,
      );

      rankedResults = sortedCandidates.map((u) => ({
        user: {
          id: u.id,
          username: u.username,
          name: u.name,
          avatarUrl: u.avatarUrl,
          bio: u.bio,
          roleTags: u.roleTags,
          primaryStack: u.primaryStack,
          commitmentScore: u.commitmentScore,
          declaredHoursPerDay: u.commitmentScore_rel?.declaredHoursPerDay ?? null,
          githubConfidence: u.githubMetrics?.githubConfidence || 'insufficient',
        },
        matchReason: `High commitment score (${u.commitmentScore}/100) with strong availability.`,
        compatibilityScore: Math.round(u.commitmentScore),
        teamCharter: this.generateFallbackCharter(requester, u),
      }));
    }

    return {
      candidates: rankedResults.slice(0, 6),
      targetSize,
      myTeam,
    };
  }

  /**
   * Sends a team invite to a candidate with an attached Team Charter.
   */
  async sendInvite(
    hackathonId: string,
    fromUserId: string,
    toUserId: string,
    charterJson?: any,
  ) {
    if (fromUserId === toUserId) {
      throw new BadRequestException('You cannot invite yourself');
    }

    // Check if invite already exists from me to user
    const existing = await this.prisma.teamInvite.findFirst({
      where: {
        hackathonId,
        fromUserId,
        toUserId,
      },
    });
    if (existing) {
      if (existing.status === 'pending') {
        throw new BadRequestException('Invite is already pending');
      }
      if (existing.status === 'accepted') {
        throw new BadRequestException('Candidate has already accepted an invite');
      }
    }

    // Check if reverse invite already exists from user to me
    const reverseInvite = await this.prisma.teamInvite.findFirst({
      where: {
        hackathonId,
        fromUserId: toUserId,
        toUserId: fromUserId,
        status: 'pending',
      },
    });
    if (reverseInvite) {
      throw new BadRequestException(
        'This user has already sent you a team invite! Accept their invite from your notifications or the hackathon page to join teams.',
      );
    }

    // Find or create requester's forming team
    let team = await this.prisma.team.findFirst({
      where: {
        hackathonId,
        creatorId: fromUserId,
        status: 'forming',
      },
    });

    if (!team) {
      team = await this.prisma.team.create({
        data: {
          hackathonId,
          creatorId: fromUserId,
          status: 'forming',
          members: {
            create: { userId: fromUserId },
          },
        },
      });
    }

    // Create TeamInvite
    const invite = await this.prisma.teamInvite.create({
      data: {
        hackathonId,
        fromUserId,
        toUserId,
        teamId: team.id,
        charterJson: charterJson || undefined,
        status: 'pending',
      },
      include: {
        toUser: {
          select: { id: true, username: true, name: true, avatarUrl: true },
        },
      },
    });

    // Create in-app Notification for candidate (toUserId)
    const [requester, hackathon] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: fromUserId } }),
      this.prisma.hackathon.findUnique({ where: { id: hackathonId } }),
    ]);

    const fromName = requester?.name || requester?.username || 'A user';
    const hackTitle = hackathon?.title || 'a hackathon';

    const notifRecord = await this.prisma.notification.create({
      data: {
        userId: toUserId,
        type: 'team_invite',
        payload: {
          message: `${fromName} invited you to join their team for ${hackTitle}`,
          inviteId: invite.id,
          hackathonId,
          hackathonTitle: hackTitle,
          fromUserId,
          fromUsername: fromName,
          fromAvatarUrl: requester?.avatarUrl || null,
          charterJson: charterJson || undefined,
        },
      },
    });

    if (this.ratingsGateway) {
      this.ratingsGateway.emitNotification(toUserId, notifRecord);
    }

    return invite;
  }

  /**
   * Accepts or declines an invite.
   * On decline: automatically generates 1 replacement candidate match!
   */
  async respondToInvite(
    inviteId: string,
    userId: string,
    action: 'accept' | 'decline',
  ) {
    const invite = await this.prisma.teamInvite.findUnique({
      where: { id: inviteId },
      include: { team: true },
    });

    if (!invite || invite.toUserId !== userId) {
      throw new NotFoundException('Invite not found');
    }

    if (invite.status !== 'pending') {
      throw new BadRequestException(`Invite has already been ${invite.status}`);
    }

    const [responder, hackathon] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.hackathon.findUnique({ where: { id: invite.hackathonId } }),
    ]);
    const responderName = responder?.name || responder?.username || 'A candidate';
    const hackTitle = hackathon?.title || 'the hackathon';

    if (action === 'accept') {
      await this.prisma.teamInvite.update({
        where: { id: inviteId },
        data: { status: 'accepted' },
      });

      // Auto-settle any reverse pending invite from responder to inviter for this hackathon
      await this.prisma.teamInvite.updateMany({
        where: {
          hackathonId: invite.hackathonId,
          fromUserId: userId,
          toUserId: invite.fromUserId,
          status: 'pending',
        },
        data: { status: 'accepted' },
      });

      if (invite.teamId) {
        // Add member to team if not already present
        await this.prisma.teamMember.upsert({
          where: {
            teamId_userId: { teamId: invite.teamId, userId },
          },
          create: { teamId: invite.teamId, userId },
          update: {},
        });

        // Check if team has reached targetSize
        const count = await this.prisma.teamMember.count({
          where: { teamId: invite.teamId },
        });
        if (count >= (invite.team?.targetSize || 4)) {
          await this.prisma.team.update({
            where: { id: invite.teamId },
            data: { status: 'complete' },
          });
        }
      }

      // Notify the inviter that their invite was accepted
      const notifRecord = await this.prisma.notification.create({
        data: {
          userId: invite.fromUserId,
          type: 'invite_accepted',
          payload: {
            message: `${responderName} accepted your team invite for ${hackTitle}!`,
            inviteId: invite.id,
            hackathonId: invite.hackathonId,
            hackathonTitle: hackTitle,
            toUserId: userId,
            toUsername: responderName,
          },
        },
      });

      if (this.ratingsGateway) {
        this.ratingsGateway.emitNotification(invite.fromUserId, notifRecord);
      }

      return { status: 'accepted', teamId: invite.teamId };
    } else {
      // Action === 'decline'
      await this.prisma.teamInvite.update({
        where: { id: inviteId },
        data: { status: 'declined' },
      });

      // Notify the inviter that their invite was declined
      const notifRecord = await this.prisma.notification.create({
        data: {
          userId: invite.fromUserId,
          type: 'invite_declined',
          payload: {
            message: `${responderName} declined your team invite for ${hackTitle}.`,
            inviteId: invite.id,
            hackathonId: invite.hackathonId,
            hackathonTitle: hackTitle,
            toUserId: userId,
            toUsername: responderName,
          },
        },
      });

      if (this.ratingsGateway) {
        this.ratingsGateway.emitNotification(invite.fromUserId, notifRecord);
      }

      // Automatically generate 1 replacement candidate suggestion
      const replacementPool = await this.findTeammates(
        invite.hackathonId,
        invite.fromUserId,
      );
      const replacementCandidate =
        replacementPool.candidates.length > 0 ? replacementPool.candidates[0] : null;

      return {
        status: 'declined',
        replacementCandidate,
      };
    }
  }

  /**
   * Returns incoming pending invite for a user in a specific hackathon, including charter and team details.
   */
  async getMyPendingInvite(hackathonId: string, userId: string) {
    const invite = await this.prisma.teamInvite.findFirst({
      where: {
        hackathonId,
        toUserId: userId,
        status: 'pending',
      },
      include: {
        fromUser: {
          select: {
            id: true,
            username: true,
            name: true,
            avatarUrl: true,
            roleTags: true,
            primaryStack: true,
            commitmentScore: true,
          },
        },
        team: {
          include: {
            members: {
              include: {
                user: {
                  select: { id: true, username: true, name: true, avatarUrl: true },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invite || null;
  }

  /**
   * Fetches incoming and outgoing invites for a user across all hackathons.
   */
  async getUserInvites(userId: string) {
    const [incoming, outgoing] = await Promise.all([
      this.prisma.teamInvite.findMany({
        where: { toUserId: userId, status: 'pending' },
        include: {
          fromUser: {
            select: {
              id: true,
              username: true,
              name: true,
              avatarUrl: true,
              roleTags: true,
              primaryStack: true,
              commitmentScore: true,
            },
          },
          hackathon: {
            select: { id: true, title: true, logoUrl: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.teamInvite.findMany({
        where: { fromUserId: userId },
        include: {
          toUser: {
            select: {
              id: true,
              username: true,
              name: true,
              avatarUrl: true,
              roleTags: true,
              primaryStack: true,
              commitmentScore: true,
            },
          },
          hackathon: {
            select: { id: true, title: true, logoUrl: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { incoming, outgoing };
  }
}
