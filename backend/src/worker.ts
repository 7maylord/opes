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
  const runReconciliation = async () => {
    try {
      await reconciliation.process();
    } catch (error) {
      logger.error('treasury reconciliation worker failed', error);
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

  await runProvisioning();
  await runPayments();
  await runLiquidity();
  await runRecurring();
  await runEscrow();
  await runReconciliation();
  await runAccounting();
  await runWatchedBucket();
  const interval = setInterval(() => {
    void runProvisioning();
    void runPayments();
    void runLiquidity();
    void runRecurring();
    void runEscrow();
    void runReconciliation();
    void runAccounting();
    void runWatchedBucket();
  }, 10_000);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  clearInterval(interval);
  await app.close();
}

void bootstrapWorker();
