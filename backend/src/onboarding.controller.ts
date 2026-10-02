import { Body, Controller, Post } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import type { OnboardingRequest, OnboardingResult } from './onboarding.service';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post()
  onboard(@Body() body: OnboardingRequest): Promise<OnboardingResult> {
    return this.onboarding.onboard(body);
  }
}
