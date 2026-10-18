import { NestFactory } from '@nestjs/core';
import { configureApiDocumentation } from './api-documentation';
import { AppModule } from './app.module';
import { useCorrelationIds } from './correlation-id';
import { loadRuntimeConfig } from './runtime.config';

async function bootstrap() {
  const config = loadRuntimeConfig();
  const app = await NestFactory.create(AppModule, { rawBody: true });
  useCorrelationIds(app);
  app.enableCors({
    origin: config.allowedOrigins,
    credentials: true,
  });
  configureApiDocumentation(app);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}
void bootstrap();
