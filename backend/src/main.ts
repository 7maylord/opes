import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadRuntimeConfig } from './runtime.config';

async function bootstrap() {
  const config = loadRuntimeConfig();
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: config.allowedOrigins,
    credentials: true,
  });
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}
void bootstrap();
