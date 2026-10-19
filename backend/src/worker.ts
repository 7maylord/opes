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
  const runProvisioning = async () => {
    try {
      await provisioning.processDueArcProvisioning();
    } catch (error) {
      logger.error('arc provisioning worker failed', error);
    }
  };
  const runLiquidity = async () => {
    try {
      await liquidity.processDueLiquidityActions();
    } catch (error) {
      logger.error('liquidity execution worker failed', error);
    }
  };
  const runPayments = async () => {
    try {
      await payments.processDuePaymentExecutions();
    } catch (error) {
      logger.error('payment execution worker failed', error);
    }
  };
  const runRecurring = async () => {
    try {
      await recurring.processDue();
    } catch (error) {
      logger.error('recurring execution worker failed', error);
    }
  };
  const runEscrow = async () => {
    try {
      await escrow.processDue();
    } catch (error) {
      logger.error('escrow execution worker failed', error);
    }
  };
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
  const runAccounting = async () => {
    try {
      await accounting.processDue();
    } catch (error) {
      logger.error('accounting connector worker failed', error);
    }
  };
  const runWatchedBucket = async () => {
    try {
      await watchedBucket.processDue();
    } catch (error) {
      logger.error('watched bucket worker failed', error);
    }
  };
  const runNotificationEmails = async () => {
    try {
      await notificationEmails.processDue();
    } catch (error) {
      logger.error('notification email worker failed', error);
    }
  };

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
