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
}
