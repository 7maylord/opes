import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { DocumentStorageService } from './document-storage.service';
import {
  DocumentExtractionResponse,
  EvidenceService,
} from './evidence.service';
import { InvoiceModelService } from './invoice-model.service';
import { TenantContext } from './tenant-context';

@Injectable()
export class DocumentExtractionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly documents: DocumentStorageService,
    private readonly model: InvoiceModelService,
    private readonly evidence: EvidenceService,
  ) {}

  async extractInvoice(
    context: TenantContext,
    documentId: string,
  ): Promise<DocumentExtractionResponse> {
    const existing = await this.findExisting(context, documentId);
    if (existing) return existing;
    const { document, bytes } = await this.documents.readVerified(
      context,
      documentId,
    );
    if (document.documentType !== 'INVOICE')
      throw new Error('Only invoice documents can use invoice extraction');
    const result = await this.model.extract({
      filename: document.filename,
      contentType: document.contentType,
      bytes,
      sourceSha256Hex: document.sha256Hex,
    });
    return this.evidence.recordDocumentExtraction(context, documentId, {
      schemaName: 'invoice',
      schemaVersion: '1',
      modelProvider: result.provider,
      modelName: result.model,
      sourceSha256Hex: document.sha256Hex,
      output: result.output,
      providerResponseId: result.responseId,
      promptVersion: result.promptVersion,
      requestHash: result.requestHash,
    });
  }

  private async findExisting(
    context: TenantContext,
    documentId: string,
  ): Promise<DocumentExtractionResponse | null> {
    const modelName =
      process.env.OPES_DEEPSEEK_MODEL?.trim() || 'deepseek-flash';
    const result = await this.database.withTenant(context, (database) =>
      database.query<{
        id: string;
        document_id: string;
        schema_name: string;
        schema_version: string;
        model_provider: string;
        model_name: string;
        source_sha256_hex: string;
        output: unknown;
        status: string;
      }>(
        `SELECT extraction.id, extraction.document_id, extraction.schema_name,
            extraction.schema_version, extraction.model_provider, extraction.model_name,
            extraction.source_sha256_hex, extraction.output, extraction.status
           FROM opes.document_extractions AS extraction
           JOIN opes.evidence_documents AS document
             ON document.organization_id = extraction.organization_id
            AND document.id = extraction.document_id
          WHERE extraction.organization_id = $1 AND extraction.document_id = $2
            AND extraction.schema_name = 'invoice' AND extraction.schema_version = '1'
            AND extraction.model_provider = 'deepseek'
            AND extraction.model_name = $3
            AND extraction.source_sha256_hex = document.sha256_hex
          ORDER BY extraction.created_at DESC LIMIT 1`,
        [context.organizationId, documentId, modelName],
      ),
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          documentId: row.document_id,
          schemaName: row.schema_name,
          schemaVersion: row.schema_version,
          modelProvider: row.model_provider,
          modelName: row.model_name,
          sourceSha256Hex: row.source_sha256_hex,
          output: row.output,
          status: row.status,
        }
      : null;
  }
}
