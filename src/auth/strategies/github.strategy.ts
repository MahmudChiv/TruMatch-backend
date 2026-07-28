import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-github2';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { encryptToken } from '../../github-sync/crypto.util';

@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      clientID: configService.get<string>('GITHUB_CLIENT_ID') || 'placeholder_id',
      clientSecret: configService.get<string>('GITHUB_CLIENT_SECRET') || 'placeholder_secret',
      callbackURL: configService.get<string>('GITHUB_CALLBACK_URL') || 'http://localhost:3001/auth/github/callback',
      scope: ['user:email', 'read:user', 'repo'],
    });
  }

  async validate(accessToken: string, _refreshToken: string, profile: Profile) {
    const primaryEmail = profile.emails && profile.emails.length > 0
      ? profile.emails[0].value
      : null;

    const avatarUrl = profile.photos && profile.photos.length > 0
      ? profile.photos[0].value
      : undefined;

    const user = await this.usersService.findOrCreateFromGithub({
      githubId: profile.id,
      username: profile.username || `github_${profile.id}`,
      email: primaryEmail || undefined,
      name: profile.displayName || profile.username,
      avatarUrl: avatarUrl,
      bio: (profile as any)._json?.bio || undefined,
    });

    // Encrypt and persist the OAuth access token so sync jobs can use it later
    const encrypted = encryptToken(accessToken);
    await this.usersService.updateGithubToken(user.id, encrypted);

    return user;
  }
}
