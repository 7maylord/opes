import { runWorkerLoop } from './core/worker-loop';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProvisioningWorkerService } from './modules/agents/provisioning-worker.service';
import { PaymentExecutionWorkerService } from './modules/payments/payment-execution-worker.service';
import { LiquidityExecutionWorkerService } from './modules/treasury/liquidity-execution-worker.service';
import { loadRuntimeConfig } from './core/config/runtime.config';
import { RecurringExecutionService } from './modules/agreements/recurring-execution.service';
import { EscrowExecutionService } from './modules/agreements/escrow-execution.service';
import { TreasuryReconciliationService } from './modules/treasury/treasury-reconciliation.service';
import { AccountingConnectorService } from './modules/integrations/accounting-connector.service';
import { WatchedBucketService } from './modules/integrations/watched-bucket.service';
import { NotificationEmailWorkerService } from './modules/notifications/notification-email-worker.service';
import { WebhookDeliveryWorkerService } from './modules/developers/webhook-delivery-worker.service';

async function bootstrapWorker() {
  const config = loadRuntimeConfig();
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  const logger = new Logger('Worker');

  logger.log(`worker started in ${config.environment}`);

  const provisioning = app.get(ProvisioningWorkerService);
  const payments = app.get(PaymentExecutionWorkerService);
  const liquidity = app.get(LiquidityExecutionWorkerService);
  const recurring = app.get(RecurringExecutionService);
  const escrow = app.get(EscrowExecutionService);
  const reconciliation = app.get(TreasuryReconciliationService);
  const accounting = app.get(AccountingConnectorService);
  const watchedBucket = app.get(WatchedBucketService);
  const notificationEmails = app.get(NotificationEmailWorkerService);
  const webhooks = app.get(WebhookDeliveryWorkerService);
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const tasks: Array<[string, () => Promise<unknown>]> = [
    ['provisioning', () => provisioning.processDueArcProvisioning()],
    ['payments', () => payments.processDuePaymentExecutions()],
    ['liquidity', () => liquidity.processDueLiquidityActions()],
    ['recurring', () => recurring.processDue()],
    ['escrow', () => escrow.processDue()],
    ['reconciliation', () => reconciliation.process()],
    ['accounting', () => accounting.processDue()],
    ['watched bucket', () => watchedBucket.processDue()],
    ['notification emails', () => notificationEmails.processDue()],
    ['webhooks', () => webhooks.processDue()],
  ];
  try {
    await Promise.all(
      tasks.map(([name, work]) =>
        runWorkerLoop(work, stop.signal, (error) =>
          logger.error(`${name} worker failed`, error),
        ),
      ),
    );
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await app.close();
  }
}

void bootstrapWorker();
