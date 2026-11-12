import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { DocumentExtractionService } from './document-extraction.service';
import { DocumentStorageService } from './document-storage.service';
import { EvidenceController } from './evidence.controller';
import { EvidenceService } from './evidence.service';
import { InvoiceModelService } from './invoice-model.service';
import { ProcurementEvidenceController } from './procurement-evidence.controller';
import { ProcurementEvidenceService } from './procurement-evidence.service';

@Module({
  imports: [PaymentsModule],
  controllers: [EvidenceController, ProcurementEvidenceController],
  providers: [
    EvidenceService,
    DocumentStorageService,
    DocumentExtractionService,
    InvoiceModelService,
    ProcurementEvidenceService,
  ],
  exports: [
    EvidenceService,
    DocumentStorageService,
    DocumentExtractionService,
    InvoiceModelService,
  ],
})
export class EvidenceModule {}
