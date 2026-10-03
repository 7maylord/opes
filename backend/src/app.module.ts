import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database.service';
import { FactoryManifestService } from './factory-manifest.service';
import { OnboardingController } from './onboarding.controller';
import { ProvisioningWorkerService } from './provisioning-worker.service';
import { OnboardingService } from './onboarding.service';
import { OrganizationInvitationController } from './organization-invitation.controller';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

@Module({
  imports: [],
  controllers: [
    AgentController,
    AppController,
    OnboardingController,
    OrganizationInvitationController,
    OrganizationController,
    SessionController,
  ],
  providers: [
    AgentService,
    AppService,
    DatabaseService,
    FactoryManifestService,
    OnboardingService,
    ProvisioningWorkerService,
    OrganizationService,
    SessionService,
    TenantContextService,
  ],
})
export class AppModule {}
