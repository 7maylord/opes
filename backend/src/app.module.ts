import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { AgentsModule } from './modules/agents/agents.module';
import { AgreementsModule } from './modules/agreements/agreements.module';
import { EvidenceModule } from './modules/evidence/evidence.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OperationsModule } from './modules/operations/operations.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { TreasuryModule } from './modules/treasury/treasury.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';

@Module({
  imports: [
    CoreModule,
    InfrastructureModule,
    NotificationsModule,
    OrganizationsModule,
    AgentsModule,
    PaymentsModule,
    EvidenceModule,
    AgreementsModule,
    TreasuryModule,
    InvoicesModule,
    IntegrationsModule,
    WorkspaceModule,
    OperationsModule,
  ],
})
export class AppModule {}
