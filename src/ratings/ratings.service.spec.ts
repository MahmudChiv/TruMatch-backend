import { Test, TestingModule } from '@nestjs/testing';
import { RatingsService } from './ratings.service';
import { PrismaService } from '../prisma/prisma.service';
import { RatingsGateway } from './ratings.gateway';
import { BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';

describe('RatingsService', () => {
  let service: RatingsService;
  let prisma: jest.Mocked<PrismaService>;
  let gateway: jest.Mocked<RatingsGateway>;

  beforeEach(async () => {
    const mockPrisma = {
      teamMember: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      rating: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      commitmentScore: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      user: {
        update: jest.fn(),
      },
      githubMetrics: {
        findUnique: jest.fn(),
      },
      notification: {
        create: jest.fn(),
      },
    };

    const mockGateway = {
      emitRatingUpdated: jest.fn(),
      emitNotification: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RatingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RatingsGateway, useValue: mockGateway },
      ],
    }).compile();

    service = module.get<RatingsService>(RatingsService);
    prisma = module.get(PrismaService);
    gateway = module.get(RatingsGateway);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('submitRating', () => {
    it('should throw BadRequestException if rater attempts to rate themselves', async () => {
      await expect(
        service.submitRating('user-1', {
          teamId: 'team-1',
          rateeId: 'user-1',
          deliveredScore: 5,
          communicationScore: 5,
          wouldWorkAgain: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException if users are not members of the same team', async () => {
      (prisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        { teamId: 'team-1', userId: 'user-1' },
      ]);

      await expect(
        service.submitRating('user-1', {
          teamId: 'team-1',
          rateeId: 'user-2',
          deliveredScore: 5,
          communicationScore: 5,
          wouldWorkAgain: true,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ConflictException if rating already submitted for team', async () => {
      (prisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        { teamId: 'team-1', userId: 'user-1' },
        { teamId: 'team-1', userId: 'user-2' },
      ]);
      (prisma.rating.findUnique as jest.Mock).mockResolvedValue({ id: 'r-1' });

      await expect(
        service.submitRating('user-1', {
          teamId: 'team-1',
          rateeId: 'user-2',
          deliveredScore: 5,
          communicationScore: 5,
          wouldWorkAgain: true,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should set visibleAt to null if counterpart has not rated yet', async () => {
      (prisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        { teamId: 'team-1', userId: 'user-1' },
        { teamId: 'team-1', userId: 'user-2' },
      ]);
      (prisma.rating.findUnique as jest.Mock)
        .mockResolvedValueOnce(null) // check existing rating
        .mockResolvedValueOnce(null); // check counterpart rating

      (prisma.rating.create as jest.Mock).mockResolvedValue({
        id: 'r-new',
        teamId: 'team-1',
        raterId: 'user-1',
        rateeId: 'user-2',
        visibleAt: null,
      });

      jest.spyOn(service, 'recalculateCommitmentScore').mockResolvedValue();

      const result = await service.submitRating('user-1', {
        teamId: 'team-1',
        rateeId: 'user-2',
        deliveredScore: 4,
        communicationScore: 5,
        wouldWorkAgain: true,
      });

      expect(prisma.rating.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            visibleAt: null,
          }),
        }),
      );
      expect(result.visibleAt).toBeNull();
    });

    it('should set visibleAt to Date when blind mutual condition is met', async () => {
      (prisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        { teamId: 'team-1', userId: 'user-1' },
        { teamId: 'team-1', userId: 'user-2' },
      ]);
      (prisma.rating.findUnique as jest.Mock)
        .mockResolvedValueOnce(null) // existing
        .mockResolvedValueOnce({ id: 'counterpart-1', visibleAt: null }); // counterpart

      (prisma.rating.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({ id: 'r-new', ...data }),
      );
      (prisma.rating.update as jest.Mock).mockResolvedValue({});

      jest.spyOn(service, 'recalculateCommitmentScore').mockResolvedValue();

      const result = await service.submitRating('user-1', {
        teamId: 'team-1',
        rateeId: 'user-2',
        deliveredScore: 5,
        communicationScore: 5,
        wouldWorkAgain: true,
      });

      expect(result.visibleAt).toBeInstanceOf(Date);
      expect(prisma.rating.update).toHaveBeenCalledWith({
        where: { id: 'counterpart-1' },
        data: expect.objectContaining({ visibleAt: expect.any(Date) }),
      });
    });
  });

  describe('computePeerRatingScore (distinct-team-weighted)', () => {
    it('should calculate peerWeight = 0.55 for 1 distinct team', async () => {
      (prisma.rating.findMany as jest.Mock).mockResolvedValue([
        { teamId: 't-1', deliveredScore: 5, communicationScore: 5, wouldWorkAgain: true },
      ]);

      const result = await service.computePeerRatingScore('user-1');
      expect(result.distinctTeamsRated).toBe(1);
      expect(result.peerWeight).toBe(0.55);
      expect(result.peerRatingScore).toBe(100);
    });

    it('should calculate peerWeight = 0.85 for 2 distinct teams', async () => {
      (prisma.rating.findMany as jest.Mock).mockResolvedValue([
        { teamId: 't-1', deliveredScore: 5, communicationScore: 5, wouldWorkAgain: true },
        { teamId: 't-2', deliveredScore: 4, communicationScore: 4, wouldWorkAgain: false },
      ]);

      const result = await service.computePeerRatingScore('user-1');
      expect(result.distinctTeamsRated).toBe(2);
      expect(result.peerWeight).toBe(0.85);
    });

    it('should fail-safe to peerWeight = 0 on error (Section 7)', async () => {
      (prisma.rating.findMany as jest.Mock).mockRejectedValue(new Error('DB failure'));

      const result = await service.computePeerRatingScore('user-1');
      expect(result.peerRatingScore).toBeNull();
      expect(result.peerWeight).toBe(0);
      expect(result.distinctTeamsRated).toBe(0);
    });
  });

  describe('getPublicPeerRatingSummary (Section 4 Anonymity)', () => {
    it('should omit raterId from all comments in response', async () => {
      (prisma.commitmentScore.findUnique as jest.Mock).mockResolvedValue({
        peerRatingScore: 92,
        distinctTeamsRated: 2,
        appliedPeerWeight: 0.85,
      });

      (prisma.rating.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'r-1',
          teamId: 't-1',
          deliveredScore: 5,
          communicationScore: 4,
          wouldWorkAgain: true,
          comment: 'Great teammate!',
          createdAt: new Date(),
        },
      ]);

      const summary = await service.getPublicPeerRatingSummary('user-1');

      expect(summary.peerRatingScore).toBe(92);
      expect(summary.comments).toHaveLength(1);
      expect((summary.comments[0] as any).raterId).toBeUndefined();
      expect(summary.comments[0].comment).toBe('Great teammate!');
    });
  });
});
