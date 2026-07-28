import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { User } from '@prisma/client';

interface AuthCodeEntry {
  user: User;
  createdAt: number;
}

@Injectable()
export class AuthService {
  // In-memory store for short-lived (60s) authorization codes
  private readonly authCodes = new Map<string, AuthCodeEntry>();

  constructor(private readonly jwtService: JwtService) {
    // Periodically clean expired codes every 30 seconds
    setInterval(() => this.cleanExpiredCodes(), 30000);
  }

  /**
   * Generates a single-use, 60s opaque code for the authenticated user.
   */
  generateAuthCode(user: User): string {
    const code = randomUUID();
    this.authCodes.set(code, {
      user,
      createdAt: Date.now(),
    });
    return code;
  }

  /**
   * Exchanges an opaque authorization code for a JWT.
   * Codes are strictly one-time use and expire after 60 seconds.
   */
  exchangeAuthCode(code: string) {
    const entry = this.authCodes.get(code);
    if (!entry) {
      throw new UnauthorizedException('Invalid or expired authorization code');
    }

    // Single-use: delete immediately regardless of outcome
    this.authCodes.delete(code);

    const isExpired = Date.now() - entry.createdAt > 60000;
    if (isExpired) {
      throw new UnauthorizedException('Authorization code has expired');
    }

    const payload = {
      sub: entry.user.id,
      githubId: entry.user.githubId,
      username: entry.user.username,
    };

    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: entry.user,
    };
  }

  private cleanExpiredCodes() {
    const now = Date.now();
    for (const [code, entry] of this.authCodes.entries()) {
      if (now - entry.createdAt > 60000) {
        this.authCodes.delete(code);
      }
    }
  }
}
