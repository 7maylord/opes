import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProvisioningWorkerService } from './provisioning-worker.service';
import { PaymentExecutionWorkerService } from './payment-execution-worker.service';
import { LiquidityExecutionWorkerService } from './liquidity-execution-worker.service';
import { loadRuntimeConfig } from './runtime.config';
import { RecurringExecutionService } from './recurring-execution.service';
import { EscrowExecutionService } from './escrow-execution.service';
import { TreasuryReconciliationService } from './treasury-reconciliation.service';
import { AccountingConnectorService } from './accounting-connector.service';
import { WatchedBucketService } from './watched-bucket.service';
import { NotificationEmailWorkerService } from './notification-email-worker.service';

async function bootstrapWorker() {
  const config = loadRuntimeConfig();
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  const logger = new Logger('Worker');

  app.enableShutdownHooks();
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
  // Skip a tick while the previous run of the same job is still going, so slow
  // RPC/bucket calls can't stack up overlapping runs (and their memory).
  const guarded = (name: string, job: () => Promise<unknown>) => {
    let running = false;
    return async () => {
      if (running) return;
      running = true;
      try {
        await job();
      } catch (error) {
        logger.error(`${name} worker failed`, error);
      } finally {
        running = false;
      }
    };
  };
  const runProvisioning = guarded('provisioning', () => provisioning.processDueArcProvisioning());
  const runLiquidity = guarded('liquidity', () => liquidity.processDueLiquidityActions());
  const runPayments = guarded('payments', () => payments.processDuePaymentExecutions());
  const runRecurring = guarded('recurring', () => recurring.processDue());
  const runEscrow = guarded('escrow', () => escrow.processDue());
  let reconciliationRunning = false;
  const runReconciliation = async () => {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    try {
      await reconciliation.process();
    } catch (error) {
      logger.error('treasury reconciliation worker failed', error);
    } finally {
      reconciliationRunning = false;
    }
  };
  const runAccounting = guarded('accounting', () => accounting.processDue());
  const runWatchedBucket = guarded('watchedBucket', () => watchedBucket.processDue());
  const runNotificationEmails = guarded('notificationEmails', () => notificationEmails.processDue());

  await runProvisioning();
  await runPayments();
  await runLiquidity();
  await runRecurring();
  await runEscrow();
  await runReconciliation();
  await runAccounting();
  await runWatchedBucket();
  await runNotificationEmails();
  const interval = setInterval(() => {
    void runProvisioning();
    void runPayments();
    void runLiquidity();
    void runRecurring();
    void runEscrow();
    void runReconciliation();
    void runAccounting();
    void runWatchedBucket();
    void runNotificationEmails();
  }, 10_000);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  clearInterval(interval);
  await app.close();
}

void bootstrapWorker();
