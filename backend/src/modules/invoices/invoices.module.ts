import { Module } from '@nestjs/common';
import { EvidenceModule } from '../evidence/evidence.module';
import { PaymentsModule } from '../payments/payments.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { AgentDecisionService } from './agent-decision.service';
import { DecisionController } from './decision.controller';
import { DecisionService } from './decision.service';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';

@Module({
  imports: [EvidenceModule, PaymentsModule, TreasuryModule],
  controllers: [InvoiceController, DecisionController],
  providers: [InvoiceService, DecisionService, AgentDecisionService],
})
export class InvoicesModule {}
