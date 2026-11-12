import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { PaymentExecutionWorkerService } from './payment-execution-worker.service';
import { PaymentExecutionService } from './payment-execution.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentCorrectionController } from './payment-correction.controller';
import { PaymentCorrectionService } from './payment-correction.service';

@Module({
  controllers: [
    LedgerController,
    PaymentWebhookController,
    PaymentCorrectionController,
  ],
  providers: [
    LedgerService,
    PaymentExecutionService,
    PaymentExecutionWorkerService,
    PaymentReconciliationService,
    PaymentCorrectionService,
  ],
  exports: [
    LedgerService,
    PaymentExecutionService,
    PaymentExecutionWorkerService,
    PaymentReconciliationService,
  ],
})
export class PaymentsModule {}
