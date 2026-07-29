import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface GithubProfileData {
  githubId: string;
  username: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  bio?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreateFromGithub(profile: GithubProfileData) {
    return this.prisma.user.upsert({
      where: { githubId: profile.githubId },
      update: {
        username: profile.username,
        email: profile.email ?? undefined,
        name: profile.name ?? undefined,
        avatarUrl: profile.avatarUrl ?? undefined,
        bio: profile.bio ?? undefined,
      },
      create: {
        githubId: profile.githubId,
        username: profile.username,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        bio: profile.bio,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async findByGithubId(githubId: string) {
    return this.prisma.user.findUnique({
      where: { githubId },
    });
  }

  async updateGithubToken(userId: string, encryptedToken: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { githubAccessToken: encryptedToken },
    });
  }

  /**
   * Aggregates all dashboard data for a user in a single DB round-trip.
   * Each section is returned independently so the frontend can handle
   * partial availability (e.g. interview not yet done).
   */
  async getDashboardData(userId: string) {
    const [user, commitmentScore, githubMetrics, interviewSession] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            githubId: true,
            username: true,
            email: true,
            name: true,
            avatarUrl: true,
            bio: true,
            commitmentScore: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        this.prisma.commitmentScore.findUnique({
          where: { userId },
        }),
        this.prisma.githubMetrics.findUnique({
          where: { userId },
        }),
        this.prisma.interviewSession.findUnique({
          where: { userId },
          select: {
            id: true,
            status: true,
            structuredOutput: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ]);

    return {
      user,
      commitmentScore,
      githubMetrics,
      interviewSession,
    };
  }
}

