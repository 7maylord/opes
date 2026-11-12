import { Global, Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationEmailWorkerService } from './notification-email-worker.service';
import { NotificationService } from './notification.service';

@Global()
@Module({
  controllers: [NotificationController],
  providers: [NotificationService, NotificationEmailWorkerService],
  exports: [NotificationService, NotificationEmailWorkerService],
})
export class NotificationsModule {}
