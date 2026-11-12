import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OrganizationInvitationController } from './organization-invitation.controller';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

@Module({
  controllers: [
    OnboardingController,
    OrganizationController,
    OrganizationInvitationController,
  ],
  providers: [OnboardingService, OrganizationService],
})
export class OrganizationsModule {}
