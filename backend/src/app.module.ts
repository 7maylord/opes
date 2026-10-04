import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseService } from './database.service';
import { DecisionController } from './decision.controller';
import { DecisionService } from './decision.service';
import { EvidenceController } from './evidence.controller';
import { EvidenceService } from './evidence.service';
import { FactoryManifestService } from './factory-manifest.service';
import { InvoiceController } from './invoice.controller';
import { LedgerController } from './ledger.controller';
import { InvoiceService } from './invoice.service';
import { LifecycleController } from './lifecycle.controller';
import { LiquidityController } from './liquidity.controller';
import { LiquidityExecutionWorkerService } from './liquidity-execution-worker.service';
import { LifecycleService } from './lifecycle.service';
import { LiquidityService } from './liquidity.service';
import { LedgerService } from './ledger.service';
import { OnboardingController } from './onboarding.controller';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { PaymentExecutionService } from './payment-execution.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentExecutionWorkerService } from './payment-execution-worker.service';
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
    DecisionController,
    EvidenceController,
    InvoiceController,
    LedgerController,
    LifecycleController,
    LiquidityController,
    OnboardingController,
    OperationsController,
    PaymentWebhookController,
    OrganizationInvitationController,
    OrganizationController,
    SessionController,
  ],
  providers: [
    AgentService,
    AppService,
    DatabaseService,
    DecisionService,
    EvidenceService,
    FactoryManifestService,
    InvoiceService,
    LedgerService,
    LifecycleService,
    LiquidityService,
    LiquidityExecutionWorkerService,
    OnboardingService,
    OperationsService,
    PaymentExecutionService,
    PaymentExecutionWorkerService,
    PaymentReconciliationService,
    ProvisioningWorkerService,
    OrganizationService,
    SessionService,
    TenantContextService,
  ],
})
export class AppModule {}
