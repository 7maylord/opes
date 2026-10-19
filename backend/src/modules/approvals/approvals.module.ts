import { Module } from '@nestjs/common';
import { ApprovalInboxController } from './approval-inbox.controller';
import { ApprovalInboxService } from './approval-inbox.service';

@Module({
  controllers: [ApprovalInboxController],
  providers: [ApprovalInboxService],
})
export class ApprovalsModule {}
