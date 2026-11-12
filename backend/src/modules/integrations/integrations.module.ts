import { Module } from '@nestjs/common';
import { EvidenceModule } from '../evidence/evidence.module';
import { AccountingConnectorController } from './accounting-connector.controller';
import { AccountingConnectorService } from './accounting-connector.service';
import {
  EmailInboxController,
  ResendInboundController,
} from './email-inbox.controller';
import { EmailInboxService } from './email-inbox.service';
import {
  VendorPortalAdminController,
  VendorPortalController,
} from './vendor-portal.controller';
import { VendorPortalService } from './vendor-portal.service';
import { WatchedBucketService } from './watched-bucket.service';

@Module({
  imports: [EvidenceModule],
  controllers: [
    AccountingConnectorController,
    EmailInboxController,
    ResendInboundController,
    VendorPortalAdminController,
    VendorPortalController,
  ],
  providers: [
    AccountingConnectorService,
    EmailInboxService,
    VendorPortalService,
    WatchedBucketService,
  ],
  exports: [AccountingConnectorService, WatchedBucketService],
})
export class IntegrationsModule {}
