import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadRuntimeConfig } from './runtime.config';

async function bootstrapWorker() {
  const config = loadRuntimeConfig();
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  const logger = new Logger('Worker');

  app.enableShutdownHooks();
  logger.log(`worker started in ${config.environment}`);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  await app.close();
}

void bootstrapWorker();
