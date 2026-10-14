import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  AccountingProvider,
  AccountingProviderConfig,
  AccountingRecordType,
  ErpNextCredentials,
  fetchAccountingRecords,
  ImportedAccountingRecord,
  OdooCredentials,
  writeSettlementNote,
} from './accounting-provider';
import {
  decryptConnectorCredentials,
  encryptConnectorCredentials,
} from './connector-credentials';
import { DatabaseService, TenantDatabase } from './database.service';
import { TenantContext } from './tenant-context';

export interface CreateAccountingConnectorRequest {
  provider: AccountingProvider;
  label: string;
  baseUrl: string;
  databaseName?: string;
  credentials: { apiKey?: string; apiSecret?: string };
}

export interface AccountingConnectorResponse {
  id: string;
  provider: AccountingProvider;
  label: string;
  baseUrl: string;
  databaseName: string | null;
  status: string;
  syncCursor: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
}

export interface AccountingRecordResponse {
  id: string;
  connectorId: string;
  recordType: AccountingRecordType;
  externalId: string;
  providerUpdatedAt: Date | null;
  normalizedData: unknown;
  fetchedAt: Date;
}

export interface RequestSettlementWritebackRequest {
  paymentExecutionId: string;
  externalBillId: string;
}

interface ConnectorRow {
  id: string;
  organization_id: string;
  provider: AccountingProvider;
  label: string;
  base_url: string;
  database_name: string | null;
  encrypted_credentials: string;
  status: string;
  sync_cursor: Date | null;
  last_synced_at: Date | null;
  last_error: string | null;
}

interface RecordRow {
  id: string;
  connector_id: string;
  record_type: AccountingRecordType;
  external_id: string;
  provider_updated_at: Date | null;
  normalized_data: unknown;
  fetched_at: Date;
}

interface OutboxRow {
  id: string;
  organization_id: string;
  aggregate_id: string;
  event_type: string;
  payload: { attempts?: number };
}

interface WritebackRow extends ConnectorRow {
  writeback_id: string;
  payment_execution_id: string;
  external_bill_id: string;
  transaction_hash: string;
}

@Injectable()
export class AccountingConnectorService {
  constructor(private readonly database: DatabaseService) {}

  async create(
    context: TenantContext,
    input: CreateAccountingConnectorRequest,
  ): Promise<AccountingConnectorResponse> {
    requireManager(context);
    const id = randomUUID();
    const provider = requireProvider(input.provider);
    const label = requireText(input.label, 'label');
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const databaseName =
      provider === 'ODOO' ? optionalText(input.databaseName) : null;
    const credentials = validateCredentials(provider, input.credentials);
    const encrypted = encryptConnectorCredentials(
      context.organizationId,
      id,
      credentials,
    );

    return this.database.withTenant(context, async (database) => {
      const result = await database.query<ConnectorRow>(
        `INSERT INTO opes.accounting_connector_bindings (
           id,organization_id,provider,label,base_url,database_name,
           encrypted_credentials,created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          id,
          context.organizationId,
          provider,
          label,
          baseUrl,
          databaseName,
          encrypted,
          context.membershipId,
        ],
      );
      await enqueue(
        database,
        context.organizationId,
        id,
        'accounting.connector.sync',
      );
      await database.query(
        `INSERT INTO opes.audit_events (
           organization_id,actor_user_id,actor_membership_id,event_type,
           subject_type,subject_id,payload
         ) VALUES ($1,$2,$3,'ACCOUNTING_CONNECTOR_CREATED','ACCOUNTING_CONNECTOR',$4,$5::jsonb)`,
        [
          context.organizationId,
          context.userId,
          context.membershipId,
          id,
          JSON.stringify({ provider, label, baseUrl }),
        ],
      );
      return mapConnector(requireRow(result.rows[0], 'connector'));
    });
  }

  async list(context: TenantContext): Promise<AccountingConnectorResponse[]> {
    const result = await this.database.withTenant(context, (database) =>
      database.query<ConnectorRow>(
        `SELECT * FROM opes.accounting_connector_bindings
          WHERE organization_id=$1 ORDER BY created_at`,
        [context.organizationId],
      ),
    );
    return result.rows.map(mapConnector);
  }

  async listRecords(
    context: TenantContext,
    connectorId: string,
  ): Promise<AccountingRecordResponse[]> {
    const result = await this.database.withTenant(context, (database) =>
      database.query<RecordRow>(
        `SELECT DISTINCT ON (record_type,external_id)
           id,connector_id,record_type,external_id,provider_updated_at,
           normalized_data,fetched_at
         FROM opes.external_accounting_records
         WHERE organization_id=$1 AND connector_id=$2
         ORDER BY record_type,external_id,provider_updated_at DESC NULLS LAST,fetched_at DESC`,
        [context.organizationId, connectorId],
      ),
    );
    return result.rows.map((row) => ({
      id: row.id,
      connectorId: row.connector_id,
      recordType: row.record_type,
      externalId: row.external_id,
      providerUpdatedAt: row.provider_updated_at,
      normalizedData: row.normalized_data,
      fetchedAt: row.fetched_at,
    }));
  }

  async requestSync(
    context: TenantContext,
    connectorId: string,
  ): Promise<{ queued: true }> {
    requireManager(context);
    await this.database.withTenant(context, async (database) => {
      const result = await database.query<{ id: string }>(
        `SELECT id FROM opes.accounting_connector_bindings
          WHERE organization_id=$1 AND id=$2 AND status <> 'DISABLED'`,
        [context.organizationId, connectorId],
      );
      requireRow(result.rows[0], 'connector');
      await enqueue(
        database,
        context.organizationId,
        connectorId,
        'accounting.connector.sync',
      );
    });
    return { queued: true };
  }

  async requestSettlementWriteback(
    context: TenantContext,
    connectorId: string,
    input: RequestSettlementWritebackRequest,
  ): Promise<{ id: string; status: string }> {
    requireManager(context);
    const paymentExecutionId = requireUuid(
      input.paymentExecutionId,
      'paymentExecutionId',
    );
    const externalBillId = requireText(input.externalBillId, 'externalBillId');
    return this.database.withTenant(context, async (database) => {
      const eligible = await database.query<{ ok: boolean }>(
        `SELECT true AS ok
         FROM opes.accounting_connector_bindings connector
         JOIN opes.external_accounting_records bill
           ON bill.organization_id=connector.organization_id
          AND bill.connector_id=connector.id
          AND bill.record_type='VENDOR_BILL'
          AND bill.external_id=$3
         JOIN opes.ledger_entries ledger
           ON ledger.organization_id=connector.organization_id
          AND ledger.ledger_event_type='PAYMENT_SETTLED'
          AND ledger.ledger_event_id=$4
         WHERE connector.organization_id=$1 AND connector.id=$2
           AND connector.status <> 'DISABLED'
         LIMIT 1`,
        [
          context.organizationId,
          connectorId,
          externalBillId,
          paymentExecutionId,
        ],
      );
      if (!eligible.rows[0]) {
        throw new ConflictException(
          'Writeback requires an imported vendor bill and reconciled payment settlement',
        );
      }
      const inserted = await database.query<{ id: string; status: string }>(
        `INSERT INTO opes.accounting_settlement_writebacks (
           organization_id,connector_id,payment_execution_id,external_bill_id,
           requested_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (organization_id,connector_id,payment_execution_id,external_bill_id)
         DO UPDATE SET updated_at=opes.accounting_settlement_writebacks.updated_at
         RETURNING id,status`,
        [
          context.organizationId,
          connectorId,
          paymentExecutionId,
          externalBillId,
          context.membershipId,
        ],
      );
      const row = requireRow(inserted.rows[0], 'writeback');
      if (row.status === 'PENDING' || row.status === 'FAILED') {
        await enqueue(
          database,
          context.organizationId,
          row.id,
          'accounting.settlement.writeback',
          'ACCOUNTING_WRITEBACK',
        );
      }
      return row;
    });
  }

  async processDue(limit = 10): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const event = await this.claim();
      if (!event) break;
      try {
        if (event.event_type === 'accounting.connector.sync') {
          await this.processSync(event);
        } else {
          await this.processWriteback(event);
        }
        await this.completeEvent(event.id);
      } catch (error) {
        await this.failEvent(event, error);
      }
      processed += 1;
    }
    return processed;
  }

  private async claim(): Promise<OutboxRow | undefined> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<OutboxRow>(
        `UPDATE opes.outbox_events SET status='PROCESSING',updated_at=now()
         WHERE id=(
           SELECT id FROM opes.outbox_events
           WHERE event_type IN ('accounting.connector.sync','accounting.settlement.writeback')
             AND ((status='PENDING' AND available_at<=now())
               OR (status='PROCESSING' AND updated_at<now()-interval '5 minutes'))
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
         ) RETURNING id,organization_id,aggregate_id,event_type,payload`,
      );
      return result.rows[0];
    });
  }

  private async processSync(event: OutboxRow): Promise<void> {
    const connector = await this.getConnectorForWorker(
      event.organization_id,
      event.aggregate_id,
    );
    if (connector.status === 'DISABLED') return;
    const config = providerConfig(connector);
    const records = await fetchAccountingRecords(config, connector.sync_cursor);
    await this.database.withWorker(async (database) => {
      for (const record of records)
        await insertRecord(database, connector, record);
      const cursor = maxModifiedAt(records, connector.sync_cursor);
      await database.query(
        `UPDATE opes.accounting_connector_bindings
         SET status='ACTIVE',sync_cursor=$3,last_synced_at=now(),last_error=NULL,updated_at=now()
         WHERE organization_id=$1 AND id=$2`,
        [connector.organization_id, connector.id, cursor],
      );
    });
  }

  private async processWriteback(event: OutboxRow): Promise<void> {
    const row = await this.database.withWorker(async (database) => {
      const result = await database.query<WritebackRow>(
        `UPDATE opes.accounting_settlement_writebacks writeback
         SET status='PROCESSING',updated_at=now()
         FROM opes.accounting_connector_bindings connector,
              opes.payment_executions execution
         WHERE writeback.organization_id=$1 AND writeback.id=$2
           AND connector.organization_id=writeback.organization_id
           AND connector.id=writeback.connector_id
           AND execution.organization_id=writeback.organization_id
           AND execution.id=writeback.payment_execution_id
           AND EXISTS (
             SELECT 1 FROM opes.ledger_entries ledger
             WHERE ledger.organization_id=writeback.organization_id
               AND ledger.ledger_event_type='PAYMENT_SETTLED'
               AND ledger.ledger_event_id=writeback.payment_execution_id
           )
         RETURNING connector.*,writeback.id AS writeback_id,
           writeback.payment_execution_id,writeback.external_bill_id,
           execution.transaction_hash`,
        [event.organization_id, event.aggregate_id],
      );
      return requireRow(result.rows[0], 'eligible writeback');
    });
    const reference = await writeSettlementNote(
      providerConfig(row),
      row.external_bill_id,
      `OPES payment ${row.payment_execution_id} settled on-chain in transaction ${row.transaction_hash}.`,
    );
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.accounting_settlement_writebacks
         SET status='COMPLETED',provider_reference=$3,failure_reason=NULL,
             completed_at=now(),updated_at=now()
         WHERE organization_id=$1 AND id=$2`,
        [row.organization_id, row.writeback_id, reference],
      ),
    );
  }

  private async getConnectorForWorker(
    organizationId: string,
    connectorId: string,
  ): Promise<ConnectorRow> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<ConnectorRow>(
        `SELECT * FROM opes.accounting_connector_bindings
          WHERE organization_id=$1 AND id=$2`,
        [organizationId, connectorId],
      );
      return requireRow(result.rows[0], 'connector');
    });
  }

  private async completeEvent(eventId: string): Promise<void> {
    await this.database.withWorker((database) =>
      database.query(
        `UPDATE opes.outbox_events SET status='PROCESSED',processed_at=now(),updated_at=now()
          WHERE id=$1`,
        [eventId],
      ),
    );
  }

  private async failEvent(event: OutboxRow, error: unknown): Promise<void> {
    const reason =
      error instanceof Error
        ? error.message.slice(0, 500)
        : 'Accounting provider failed';
    const attempts = Number(event.payload?.attempts ?? 0) + 1;
    await this.database.withWorker(async (database) => {
      await database.query(
        `UPDATE opes.outbox_events
         SET status=$2,available_at=now()+interval '30 seconds',
             payload=payload||jsonb_build_object('attempts',$3::int,'failureReason',$4::text),
             processed_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END,updated_at=now()
         WHERE id=$1`,
        [event.id, attempts >= 5 ? 'FAILED' : 'PENDING', attempts, reason],
      );
      if (event.event_type === 'accounting.connector.sync') {
        await database.query(
          `UPDATE opes.accounting_connector_bindings
           SET status='FAILED',last_error=$3,updated_at=now()
           WHERE organization_id=$1 AND id=$2`,
          [event.organization_id, event.aggregate_id, reason],
        );
      } else {
        await database.query(
          `UPDATE opes.accounting_settlement_writebacks
           SET status=$3,failure_reason=$4,updated_at=now()
           WHERE organization_id=$1 AND id=$2`,
          [
            event.organization_id,
            event.aggregate_id,
            attempts >= 5 ? 'FAILED' : 'PENDING',
            reason,
          ],
        );
      }
    });
  }
}

function providerConfig(row: ConnectorRow): AccountingProviderConfig {
  return {
    provider: row.provider,
    baseUrl: row.base_url,
    databaseName: row.database_name,
    credentials: decryptConnectorCredentials(
      row.organization_id,
      row.id,
      row.encrypted_credentials,
    ),
  };
}

async function insertRecord(
  database: TenantDatabase,
  connector: ConnectorRow,
  record: ImportedAccountingRecord,
): Promise<void> {
  const versionHash = createHash('sha256')
    .update(stableStringify(record.rawData))
    .digest('hex');
  const intake = await database.query<{ id: string }>(
    `INSERT INTO opes.intake_envelopes (
       organization_id,source_type,source_event_id,payload_hash,status,raw_metadata
     ) VALUES ($1,$2,$3,$4,'VERIFIED',$5::jsonb)
     ON CONFLICT (organization_id,source_type,source_event_id)
     DO UPDATE SET updated_at=opes.intake_envelopes.updated_at
     RETURNING id`,
    [
      connector.organization_id,
      connector.provider,
      `${connector.id}:${record.recordType}:${record.externalId}:${versionHash}`,
      versionHash,
      JSON.stringify({
        connectorId: connector.id,
        recordType: record.recordType,
        externalId: record.externalId,
      }),
    ],
  );
  const intakeEnvelopeId = requireRow(intake.rows[0], 'intake envelope').id;
  await database.query(
    `INSERT INTO opes.external_accounting_records (
       organization_id,connector_id,record_type,external_id,version_hash,
       provider_updated_at,normalized_data,raw_data,intake_envelope_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
     ON CONFLICT (organization_id,connector_id,record_type,external_id,version_hash)
     DO NOTHING`,
    [
      connector.organization_id,
      connector.id,
      record.recordType,
      record.externalId,
      versionHash,
      record.providerUpdatedAt,
      JSON.stringify(record.normalizedData),
      JSON.stringify(record.rawData),
      intakeEnvelopeId,
    ],
  );
}

async function enqueue(
  database: TenantDatabase,
  organizationId: string,
  aggregateId: string,
  eventType: string,
  aggregateType = 'ACCOUNTING_CONNECTOR',
): Promise<void> {
  await database.query(
    `INSERT INTO opes.outbox_events (
       organization_id,event_type,aggregate_type,aggregate_id,payload
     ) SELECT $1,$2,$4,$3,'{}'::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM opes.outbox_events
         WHERE organization_id=$1 AND event_type=$2 AND aggregate_id=$3
           AND status IN ('PENDING','PROCESSING')
       )`,
    [organizationId, eventType, aggregateId, aggregateType],
  );
}

function maxModifiedAt(
  records: ImportedAccountingRecord[],
  current: Date | null,
): Date | null {
  return records.reduce<Date | null>((maximum, record) => {
    if (!record.providerUpdatedAt) return maximum;
    const candidate = new Date(record.providerUpdatedAt);
    return !maximum || candidate > maximum ? candidate : maximum;
  }, current);
}

function validateCredentials(
  provider: AccountingProvider,
  input: CreateAccountingConnectorRequest['credentials'],
): OdooCredentials | ErpNextCredentials {
  const apiKey = requireText(input?.apiKey, 'credentials.apiKey');
  if (provider === 'ODOO') return { apiKey };
  return {
    apiKey,
    apiSecret: requireText(input?.apiSecret, 'credentials.apiSecret'),
  };
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(requireText(value, 'baseUrl'));
  } catch {
    throw new BadRequestException('baseUrl must be a valid HTTP URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new BadRequestException(
      'baseUrl must be a valid HTTP URL without embedded credentials',
    );
  }
  return parsed.toString().replace(/\/$/, '');
}

function requireProvider(value: string): AccountingProvider {
  if (value !== 'ODOO' && value !== 'ERPNEXT') {
    throw new BadRequestException('provider must be ODOO or ERPNEXT');
  }
  return value;
}

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new BadRequestException(`${name} is required`);
  return text;
}

function optionalText(value: string | undefined): string | null {
  return value?.trim() || null;
}

function requireUuid(value: string, name: string): string {
  const text = requireText(value, name);
  if (!/^[0-9a-fA-F-]{36}$/.test(text))
    throw new BadRequestException(`${name} must be a UUID`);
  return text;
}

function requireManager(context: TenantContext): void {
  if (context.role !== 'OWNER' && context.role !== 'ADMIN') {
    throw new ForbiddenException('Owner or admin role is required');
  }
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (!row) throw new NotFoundException(`${name} not found`);
  return row;
}

function mapConnector(row: ConnectorRow): AccountingConnectorResponse {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    baseUrl: row.base_url,
    databaseName: row.database_name,
    status: row.status,
    syncCursor: row.sync_cursor,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}
