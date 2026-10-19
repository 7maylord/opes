import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { PaymentExecutionWorkerService } from './payment-execution-worker.service';
import { PaymentExecutionService } from './payment-execution.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentWebhookController } from './payment-webhook.controller';

@Module({
  controllers: [LedgerController, PaymentWebhookController],
  providers: [
    LedgerService,
    PaymentExecutionService,
    PaymentExecutionWorkerService,
    PaymentReconciliationService,
  ],
  exports: [
    LedgerService,
    PaymentExecutionService,
    PaymentExecutionWorkerService,
    PaymentReconciliationService,
  ],
})
export class PaymentsModule {}
