import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * NestJS Guard that restricts route access to authorized admins.
 * Evaluates the authenticated user's GitHub email against the ADMIN_ALLOWLIST environment variable.
 * Must be stacked AFTER JwtAuthGuard so req.user is populated.
 * Throws a generic 403 ForbiddenException ("Admin access required") without leaking allowlist details.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Reject unauthenticated requests or users missing an email
    if (!user || !user.email) {
      throw new ForbiddenException('Admin access required');
    }

    // Parse comma-separated emails from ADMIN_ALLOWLIST env variable
    const rawAllowlist =
      this.configService.get<string>('ADMIN_ALLOWLIST') || '';
    const allowlist = rawAllowlist
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const userEmail = user.email.trim().toLowerCase();

    // Verify user email against allowlist
    if (!allowlist.includes(userEmail)) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
