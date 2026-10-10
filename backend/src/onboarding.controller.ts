import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { parseBearerToken } from './auth-header';
import { OnboardingService } from './onboarding.service';
import type { OnboardingRequest, OnboardingResult } from './onboarding.service';
import { SessionService } from './session.service';

@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly sessions: SessionService,
  ) {}

  @Post()
  async onboard(
    @Body() body: OnboardingRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<OnboardingResult> {
    const token = parseBearerToken(authorization);
    const user = token ? await this.sessions.resolveUser(token) : null;
    if (!user)
      throw new UnauthorizedException('Valid bearer session is required');
    return this.onboarding.onboard(user, body, idempotencyKey);
  }
}
