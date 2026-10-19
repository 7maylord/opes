import { Module } from '@nestjs/common';
import { DeveloperPlatformController } from './developer-platform.controller';
import { DeveloperPlatformService } from './developer-platform.service';
import { PublicApiController } from './public-api.controller';
import { WebhookDeliveryWorkerService } from './webhook-delivery-worker.service';
@Module({
  controllers: [DeveloperPlatformController, PublicApiController],
  providers: [DeveloperPlatformService, WebhookDeliveryWorkerService],
  exports: [WebhookDeliveryWorkerService],
})
export class DevelopersModule {}
