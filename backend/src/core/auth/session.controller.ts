import {
  Controller,
  Delete,
  Get,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import { SessionService, SessionUser } from './session.service';

export interface RevokeSessionResponse {
  revoked: true;
}

@Controller('session')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Get()
  async getSession(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<SessionUser> {
    const token = parseBearerToken(authorization);
    if (token === undefined) {
      throw new UnauthorizedException('Bearer session token is required');
    }

    const user = await this.sessions.resolveUser(token);
    if (user === null) {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    return user;
  }

  @Delete()
  async revokeSession(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<RevokeSessionResponse> {
    const token = parseBearerToken(authorization);
    if (token === undefined) {
      throw new UnauthorizedException('Bearer session token is required');
    }

    await this.sessions.revoke(token);

    return { revoked: true };
  }
}
