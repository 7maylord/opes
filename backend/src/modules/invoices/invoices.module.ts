import { Module } from '@nestjs/common';
import { EvidenceModule } from '../evidence/evidence.module';
import { PaymentsModule } from '../payments/payments.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { AgentDecisionService } from './agent-decision.service';
import { DecisionController } from './decision.controller';
import { DecisionService } from './decision.service';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';
import { AnomalyReviewController } from './anomaly-review.controller';
import { AnomalyReviewService } from './anomaly-review.service';

@Module({
  imports: [EvidenceModule, PaymentsModule, TreasuryModule],
  controllers: [InvoiceController, DecisionController, AnomalyReviewController],
  providers: [
    InvoiceService,
    DecisionService,
    AgentDecisionService,
    AnomalyReviewService,
  ],
})
export class InvoicesModule {}
