import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService, TenantDatabase } from './database.service';
import {
  EvidenceDocumentResponse,
  EvidenceService,
  RecordEvidenceDocumentRequest,
} from './evidence.service';
import { RailwayBucketService } from './railway-bucket.service';
import { TenantContext } from './tenant-context';

export interface InitiateDocumentUploadRequest {
  documentType: RecordEvidenceDocumentRequest['documentType'];
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256Hex: string;
  sourceEventId?: string;
  metadata?: unknown;
}

export interface InitiateDocumentUploadResponse {
  document: EvidenceDocumentResponse;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  expiresAt: string;
}

interface DocumentRow {
  id: string;
  document_type: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256_hex: string;
  storage_key: string;
  status: string;
  metadata: unknown;
}

@Injectable()
export class DocumentStorageService {
  constructor(
    private readonly database: DatabaseService,
    private readonly evidence: EvidenceService,
    private readonly bucket: RailwayBucketService,
  ) {}

  async initiateUpload(
    context: TenantContext,
    input: InitiateDocumentUploadRequest,
  ): Promise<InitiateDocumentUploadResponse> {
    if (!this.bucket.isConfigured())
      throw new ConflictException('Railway Bucket is not configured');
    const stagingKey = `staging/${context.organizationId}/${randomUUID()}`;
    const document = await this.evidence.recordEvidenceDocument(context, {
      ...input,
      storageKey: stagingKey,
    });
    if (document.status === 'VERIFIED') {
      return {
        document,
        uploadUrl: '',
        uploadHeaders: {},
        expiresAt: new Date().toISOString(),
      };
    }
    const upload = await this.bucket.createUploadUrl(
      document.storageKey,
      document.contentType,
      document.sha256Hex,
    );
    return {
      document,
      uploadUrl: upload.url,
      uploadHeaders: upload.headers,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
  }

  async finalizeUpload(
    context: TenantContext,
    documentId: string,
  ): Promise<EvidenceDocumentResponse> {
    const document = await this.getDocument(context, documentId);
    if (document.status === 'VERIFIED') return mapDocument(document);
    if (document.status !== 'STAGING')
      throw new ConflictException('Evidence document cannot be finalized');

    const stored = await this.bucket.read(document.storage_key);
    if (stored.sizeBytes !== document.size_bytes)
      throw new BadRequestException('Uploaded document size does not match');
    if (stored.contentType?.toLowerCase() !== document.content_type)
      throw new BadRequestException(
        'Uploaded document content type does not match',
      );
    const actualHash = createHash('sha256').update(stored.bytes).digest('hex');
    if (actualHash !== document.sha256_hex)
      throw new BadRequestException('Uploaded document hash does not match');

    const finalKey = `documents/${context.organizationId}/${document.id}/${document.sha256_hex}`;
    await this.bucket.finalize(document.storage_key, finalKey);
    const finalized = await this.database.withTenant(
      context,
      async (database) => {
        const result = await database.query<DocumentRow>(
          `UPDATE opes.evidence_documents
            SET storage_key = $3, status = 'VERIFIED', finalized_at = now(), updated_at = now()
          WHERE organization_id = $1 AND id = $2 AND status = 'STAGING'
          RETURNING id, document_type, filename, content_type, size_bytes,
            sha256_hex, storage_key, status, metadata`,
          [context.organizationId, document.id, finalKey],
        );
        await database.query(
          `UPDATE opes.intake_envelopes
            SET status = 'VERIFIED', updated_at = now()
          WHERE organization_id = $1 AND document_id = $2`,
          [context.organizationId, document.id],
        );
        return result;
      },
    );
    const row = finalized.rows[0];
    if (!row)
      throw new ConflictException('Evidence document was already finalized');
    await this.bucket.delete(document.storage_key).catch(() => undefined);
    return mapDocument(row);
  }

  async createDownload(
    context: TenantContext,
    documentId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const document = await this.getDocument(context, documentId);
    if (document.status !== 'VERIFIED')
      throw new ConflictException('Evidence document is not verified');
    return {
      url: await this.bucket.createDownloadUrl(
        document.storage_key,
        document.filename,
      ),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
  }

  async readVerified(
    context: TenantContext,
    documentId: string,
  ): Promise<{ document: EvidenceDocumentResponse; bytes: Uint8Array }> {
    const document = await this.getDocument(context, documentId);
    if (document.status !== 'VERIFIED')
      throw new ConflictException('Evidence document is not verified');
    const stored = await this.bucket.read(document.storage_key);
    const actualHash = createHash('sha256').update(stored.bytes).digest('hex');
    if (
      stored.sizeBytes !== document.size_bytes ||
      stored.contentType?.toLowerCase() !== document.content_type ||
      actualHash !== document.sha256_hex
    )
      throw new ConflictException(
        'Stored evidence no longer matches its record',
      );
    return { document: mapDocument(document), bytes: stored.bytes };
  }

  private async getDocument(
    context: TenantContext,
    documentId: string,
  ): Promise<DocumentRow> {
    if (!/^[0-9a-fA-F-]{36}$/.test(documentId))
      throw new BadRequestException('documentId must be a UUID');
    const result = await this.database.withTenant(context, (database) =>
      selectDocument(database, context.organizationId, documentId),
    );
    if (!result) throw new NotFoundException('Evidence document not found');
    return result;
  }
}

async function selectDocument(
  database: TenantDatabase,
  organizationId: string,
  documentId: string,
): Promise<DocumentRow | undefined> {
  const result = await database.query<DocumentRow>(
    `SELECT id, document_type, filename, content_type, size_bytes,
        sha256_hex, storage_key, status, metadata
       FROM opes.evidence_documents
      WHERE organization_id = $1 AND id = $2 LIMIT 1`,
    [organizationId, documentId],
  );
  return result.rows[0];
}

function mapDocument(row: DocumentRow): EvidenceDocumentResponse {
  return {
    id: row.id,
    documentType: row.document_type,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256Hex: row.sha256_hex,
    storageKey: row.storage_key,
    status: row.status,
    metadata: row.metadata,
  };
}
