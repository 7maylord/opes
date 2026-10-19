import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { DocumentStorageService } from '../evidence/document-storage.service';
import { MAX_DOCUMENT_BYTES } from '../../infrastructure/storage/document-content';
import { EvidenceService } from '../evidence/evidence.service';
import {
  BucketObject,
  RailwayBucketService,
} from '../../infrastructure/storage/railway-bucket.service';
import { TenantContext } from '../../core/database/tenant-context';

interface WatchRow {
  id: string;
  etag: string;
  size_bytes: string;
  last_modified: Date;
  status: string;
  first_observed_at: Date;
  updated_at: Date;
}

interface TenantBinding {
  organization_id: string;
  agent_id: string;
}

@Injectable()
export class WatchedBucketService {
  private readonly logger = new Logger(WatchedBucketService.name);
  private readonly inboxPrefix = prefix(
    process.env.OPES_BUCKET_INBOX_PREFIX,
    'inbox',
  );
  private readonly processedPrefix = prefix(
    process.env.OPES_BUCKET_PROCESSED_PREFIX,
    'processed',
  );
  private readonly quarantinePrefix = prefix(
    process.env.OPES_BUCKET_QUARANTINE_PREFIX,
    'quarantine',
  );
  private readonly stableMs = stableMilliseconds(
    process.env.OPES_BUCKET_STABLE_SECONDS,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly bucket: RailwayBucketService,
    private readonly evidence: EvidenceService,
    private readonly documents: DocumentStorageService,
  ) {}

  async processDue(): Promise<number> {
    if (!this.bucket.isConfigured()) return 0;
    const continuationToken = await this.readCursor();
    const page = await this.bucket.list(this.inboxPrefix, continuationToken);
    let processed = 0;
    for (const object of page.objects) {
      try {
        if (await this.processObject(object)) processed += 1;
      } catch (error) {
        await this.markFailed(object.key, error);
        this.logger.warn(
          `watched bucket object ${object.key} failed: ${message(error)}`,
        );
      }
    }
    await this.writeCursor(page.continuationToken);
    return processed;
  }

  private async processObject(object: BucketObject): Promise<boolean> {
    const observation = await this.claimStable(object);
    if (!observation) return false;
    const path = parsePath(object.key, this.inboxPrefix);
    if (!path) return this.quarantine(object, 'INVALID_INBOX_PATH');
    if (!isDocumentType(path.documentType))
      return this.quarantine(object, 'UNSUPPORTED_DOCUMENT_TYPE');
    const tenant = await this.resolveTenant(path.organizationId);
    if (!tenant) return this.quarantine(object, 'UNKNOWN_ORGANIZATION');

    const current = await this.bucket.stat(object.key);
    if (!sameVersion(object, current)) {
      await this.resetObservation(current);
      return false;
    }
    if (!current.contentType)
      return this.quarantine(object, 'MISSING_CONTENT_TYPE');
    if (current.sizeBytes < 1 || current.sizeBytes > MAX_DOCUMENT_BYTES)
      return this.quarantine(object, 'INVALID_DOCUMENT_SIZE');
    const stored = await this.bucket.read(object.key);
    const afterRead = await this.bucket.stat(object.key);
    if (!sameVersion(current, afterRead)) {
      await this.resetObservation(afterRead);
      return false;
    }

    const sha256Hex = createHash('sha256').update(stored.bytes).digest('hex');
    const context: TenantContext = {
      organizationId: tenant.organization_id,
      userId: observation.id,
      membershipId: observation.id,
      role: 'OPERATOR_VIEWER',
      agentId: tenant.agent_id,
      requestId: observation.id,
    };
    const document = await this.evidence.recordEvidenceDocument(
      context,
      {
        documentType: path.documentType,
        filename: path.filename,
        contentType: current.contentType,
        sizeBytes: stored.sizeBytes,
        sha256Hex,
        storageKey: object.key,
        sourceEventId: createHash('sha256')
          .update(`${object.key}\0${object.etag}`)
          .digest('hex'),
        metadata: {
          watchedBucket: {
            sourceKey: object.key,
            etag: object.etag,
            trustedForVendorOrPayoutAuthority: false,
          },
        },
      },
      { sourceType: 'WATCHED_BUCKET', automated: true },
    );
    const processedKey = `${this.processedPrefix}${path.organizationId}/${path.documentType}/${sha256Hex}-${safeFilename(path.filename)}`;
    const finalized = await this.documents.finalizeUpload(
      context,
      document.id,
      object.etag,
      false,
    );
    await this.bucket.finalize(finalized.storageKey, processedKey);
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.watched_bucket_objects SET organization_id=$2,document_type=$3,document_id=$4,
       content_type=$5,status='PROCESSED',quarantine_reason=NULL,failure_reason=NULL,processed_at=now(),updated_at=now()
       WHERE source_key=$1`,
        [
          object.key,
          tenant.organization_id,
          path.documentType,
          finalized.id,
          current.contentType,
        ],
      ),
    );
    await this.bucket.delete(object.key);
    return true;
  }

  private async claimStable(object: BucketObject): Promise<WatchRow | null> {
    return this.database.withWorker(async (database) => {
      const selected = await database.query<WatchRow>(
        `SELECT id,etag,size_bytes::text,last_modified,status,first_observed_at,updated_at
         FROM opes.watched_bucket_objects WHERE source_key=$1 FOR UPDATE`,
        [object.key],
      );
      const row = selected.rows[0];
      if (!row) {
        await database.query(
          `INSERT INTO opes.watched_bucket_objects(source_key,etag,size_bytes,last_modified) VALUES ($1,$2,$3,$4)`,
          [object.key, object.etag, object.sizeBytes, object.lastModified],
        );
        return null;
      }
      if (
        row.etag !== object.etag ||
        Number(row.size_bytes) !== object.sizeBytes ||
        row.last_modified.valueOf() !== object.lastModified.valueOf()
      ) {
        await database.query(
          `UPDATE opes.watched_bucket_objects SET organization_id=NULL,etag=$2,size_bytes=$3,last_modified=$4,
          content_type=NULL,document_type=NULL,document_id=NULL,status='OBSERVED',quarantine_reason=NULL,failure_reason=NULL,
          first_observed_at=now(),processed_at=NULL,updated_at=now() WHERE source_key=$1`,
          [object.key, object.etag, object.sizeBytes, object.lastModified],
        );
        return null;
      }
      if (row.status === 'PROCESSED' || row.status === 'QUARANTINED')
        return null;
      const stable =
        Date.now() - row.first_observed_at.valueOf() >= this.stableMs;
      const reclaimable =
        row.status !== 'PROCESSING' ||
        Date.now() - row.updated_at.valueOf() >= 5 * 60_000;
      if (!stable || !reclaimable) return null;
      await database.query(
        `UPDATE opes.watched_bucket_objects SET status='PROCESSING',failure_reason=NULL,updated_at=now() WHERE id=$1`,
        [row.id],
      );
      return row;
    });
  }

  private async resetObservation(object: BucketObject) {
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.watched_bucket_objects SET etag=$2,size_bytes=$3,last_modified=$4,status='OBSERVED',
       first_observed_at=now(),failure_reason=NULL,updated_at=now() WHERE source_key=$1`,
        [object.key, object.etag, object.sizeBytes, object.lastModified],
      ),
    );
  }

  private async quarantine(
    object: BucketObject,
    reason: string,
  ): Promise<boolean> {
    const suffix = object.key.slice(this.inboxPrefix.length);
    await this.bucket.move(
      object.key,
      `${this.quarantinePrefix}${suffix}.${object.etag}`,
    );
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.watched_bucket_objects SET status='QUARANTINED',quarantine_reason=$2,
       failure_reason=NULL,processed_at=now(),updated_at=now() WHERE source_key=$1`,
        [object.key, reason],
      ),
    );
    return true;
  }

  private async resolveTenant(
    organizationId: string,
  ): Promise<TenantBinding | null> {
    if (!uuidPattern.test(organizationId)) return null;
    const result = await this.database.withOrganizationScope(
      organizationId,
      (database) =>
        database.query<TenantBinding>(
          `SELECT organization.id AS organization_id,agent.id AS agent_id FROM opes.organizations organization
       JOIN opes.business_agents agent ON agent.organization_id=organization.id AND agent.is_primary=true
       WHERE organization.id=$1 AND organization.lifecycle_status='ACTIVE'`,
          [organizationId],
        ),
    );
    return result.rows[0] ?? null;
  }

  private async markFailed(key: string, error: unknown) {
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.watched_bucket_objects SET status='FAILED',failure_reason=$2,updated_at=now() WHERE source_key=$1`,
        [key, message(error).slice(0, 1000)],
      ),
    );
  }

  private async readCursor(): Promise<string | undefined> {
    const result = await this.database.withWorker((database) =>
      database.query<{ continuation_token: string | null }>(
        `SELECT continuation_token FROM opes.watched_bucket_cursors WHERE prefix=$1`,
        [this.inboxPrefix],
      ),
    );
    return result.rows[0]?.continuation_token ?? undefined;
  }

  private async writeCursor(value?: string) {
    await this.database.withWorker((database) =>
      database.query(
        `INSERT INTO opes.watched_bucket_cursors(prefix,continuation_token) VALUES ($1,$2)
       ON CONFLICT(prefix) DO UPDATE SET continuation_token=EXCLUDED.continuation_token,updated_at=now()`,
        [this.inboxPrefix, value ?? null],
      ),
    );
  }
}

type DocumentType = 'INVOICE' | 'CONTRACT' | 'RECEIPT' | 'MILESTONE' | 'OTHER';
const documentTypes = new Set<string>([
  'INVOICE',
  'CONTRACT',
  'RECEIPT',
  'MILESTONE',
  'OTHER',
]);
function isDocumentType(value: string): value is DocumentType {
  return documentTypes.has(value);
}
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parsePath(key: string, inboxPrefix: string) {
  const parts = key.slice(inboxPrefix.length).split('/');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  return {
    organizationId: parts[0],
    documentType: parts[1].toUpperCase(),
    filename: parts[2],
  };
}
function sameVersion(left: BucketObject, right: BucketObject) {
  return (
    left.key === right.key &&
    left.etag === right.etag &&
    left.sizeBytes === right.sizeBytes &&
    left.lastModified.valueOf() === right.lastModified.valueOf()
  );
}
function prefix(value: string | undefined, fallback: string) {
  const clean = (value?.trim() || fallback).replace(/^\/+|\/+$/g, '');
  return `${clean}/`;
}
function stableMilliseconds(value: string | undefined) {
  if (!value) return 30_000;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600)
    throw new Error(
      'OPES_BUCKET_STABLE_SECONDS must be an integer from 0 to 3600',
    );
  return seconds * 1000;
}
function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'document';
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Unknown watched bucket error';
}
