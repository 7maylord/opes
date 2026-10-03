import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProvisioningWorkerService } from './provisioning-worker.service';
import { loadRuntimeConfig } from './runtime.config';

async function bootstrapWorker() {
  const config = loadRuntimeConfig();
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  const logger = new Logger('Worker');

  app.enableShutdownHooks();
  logger.log(`worker started in ${config.environment}`);

  const provisioning = app.get(ProvisioningWorkerService);
  const runProvisioning = async () => {
    try {
      await provisioning.processDueArcProvisioning();
    } catch (error) {
      logger.error('arc provisioning worker failed', error);
    }
  };
  await runProvisioning();
  const interval = setInterval(() => void runProvisioning(), 10_000);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  clearInterval(interval);
  await app.close();
}

void bootstrapWorker();
