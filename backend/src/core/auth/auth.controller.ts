import {
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import { AuthService, AuthSessionResult } from './auth.service';

@Controller('auth/privy/session')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post()
  exchange(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<AuthSessionResult> {
    const token = parseBearerToken(authorization);
    if (!token)
      throw new UnauthorizedException('Privy bearer token is required');
    return this.auth.exchangePrivyToken(token);
  }
}
