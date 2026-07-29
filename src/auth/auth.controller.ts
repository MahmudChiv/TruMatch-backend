import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { GithubAuthGuard } from './guards/github-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { User } from '@prisma/client';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) { }

  @Get('github')
  @UseGuards(GithubAuthGuard)
  async githubAuth() {
    // Passport redirects to GitHub
  }

  @Get('github/callback')
  @UseGuards(GithubAuthGuard)
  async githubAuthCallback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as User;
    const code = this.authService.generateAuthCode(user);

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';

    return res.redirect(`${frontendUrl}/auth/callback?code=${code}`);
  }

  @Post('exchange')
  @HttpCode(HttpStatus.OK)
  async exchangeCode(
    @Body('code') code: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = this.authService.exchangeAuthCode(code);

    // Also set httpOnly cookie
    res.cookie('trumatch_token', result.accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    });

    return result;
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getProfile(@Req() req: Request) {
    return req.user;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('trumatch_token', { path: '/', sameSite: 'none', secure: true });
    return { message: 'Logged out successfully' };
  }
}
