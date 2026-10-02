import {
  Controller,
  Get,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionService, SessionUser } from './session.service';

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
}

function parseBearerToken(value: string | undefined): string | undefined {
  const prefix = 'Bearer ';
  if (value === undefined || !value.startsWith(prefix)) {
    return undefined;
  }

  const token = value.slice(prefix.length).trim();
  return token === '' ? undefined : token;
}
