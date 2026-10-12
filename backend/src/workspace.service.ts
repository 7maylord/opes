import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from './database.service';
import { TenantContext } from './tenant-context';

export const workspaceKinds = [
  'vendor',
  'evidence',
  'invoice',
  'decision',
  'execution',
  'subscription',
  'escrow',
  'ledger',
  'audit',
] as const;

export type WorkspaceKind = (typeof workspaceKinds)[number];

export interface WorkspaceRecord {
  id: string;
  kind: WorkspaceKind;
  title: string;
  subtitle: string;
  status: string;
  amountAtomic: string | null;
  assetSymbol: string | null;
  chainId: number | null;
  transactionHash: string | null;
  createdAt: string;
  updatedAt: string;
  details: Record<string, unknown>;
}

export interface WorkspacePage {
  items: WorkspaceRecord[];
  nextCursor: string | null;
}

export interface WorkspaceHistoryEvent {
  id: string;
  eventType: string;
  status: string;
  transactionHash: string | null;
  createdAt: string;
  details: Record<string, unknown>;
}

export interface WorkspaceDetail {
  record: WorkspaceRecord;
  history: WorkspaceHistoryEvent[];
}

export interface WorkspaceListQuery {
  limit?: string;
  cursor?: string;
  status?: string;
  search?: string;
}

interface RecordRow {
  id: string;
  kind: WorkspaceKind;
  title: string;
  subtitle: string;
  status: string;
  amount_atomic: string | null;
  asset_symbol: string | null;
  chain_id: number | null;
  transaction_hash: string | null;
  created_at: Date;
  updated_at: Date;
  details: Record<string, unknown>;
}

interface HistoryRow {
  id: string;
  event_type: string;
  status: string;
  transaction_hash: string | null;
  created_at: Date;
  details: Record<string, unknown>;
}

interface Cursor {
  createdAt: string;
  id: string;
}

@Injectable()
export class WorkspaceService {
  constructor(private readonly database: DatabaseService) {}

  async list(
    context: TenantContext,
    kindText: string,
    input: WorkspaceListQuery,
  ): Promise<WorkspacePage> {
    const kind = parseKind(kindText);
    const limit = parseLimit(input.limit);
    const cursor = parseCursor(input.cursor);
    const status = cleanOptional(input.status);
    const search = cleanOptional(input.search);

    return this.database.withTenant(context, async (database) => {
      const result = await database.query<RecordRow>(
        `${recordsSql()}
         SELECT id, kind, title, subtitle, status, amount_atomic, asset_symbol,
                chain_id, transaction_hash, created_at, updated_at, details
           FROM records
          WHERE organization_id = $1
            AND kind = $2
            AND ($3::text IS NULL OR status = $3)
            AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%' OR subtitle ILIKE '%' || $4 || '%')
            AND ($5::timestamptz IS NULL OR (created_at, id) < ($5, $6::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $7`,
        [
          context.organizationId,
          kind,
          status,
          search,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit + 1,
        ],
      );
      const hasNext = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        items: rows.map(mapRecord),
        nextCursor:
          hasNext && last !== undefined
            ? encodeCursor(last.created_at, last.id)
            : null,
      };
    });
  }

  async detail(
    context: TenantContext,
    kindText: string,
    recordId: string,
  ): Promise<WorkspaceDetail> {
    const kind = parseKind(kindText);
    const id = requireUuid(recordId);
    return this.database.withTenant(context, async (database) => {
      const recordResult = await database.query<RecordRow>(
        `${recordsSql()}
         SELECT id, kind, title, subtitle, status, amount_atomic, asset_symbol,
                chain_id, transaction_hash, created_at, updated_at, details
           FROM records
          WHERE organization_id = $1 AND kind = $2 AND id = $3
          LIMIT 1`,
        [context.organizationId, kind, id],
      );
      const record = recordResult.rows[0];
      if (record === undefined) throw new NotFoundException('Record not found');

      const history = await database.query<HistoryRow>(
        `
          SELECT id, event_type, status, transaction_hash, created_at, details
            FROM (
              SELECT id, event_type, 'RECORDED'::text AS status, NULL::text AS transaction_hash,
                     created_at, payload AS details
                FROM opes.audit_events
               WHERE organization_id = $1 AND subject_id = $2
              UNION ALL
              SELECT id, action_type, status, transaction_hash, created_at, payload
                FROM opes.lifecycle_chain_actions
               WHERE organization_id = $1 AND target_id = $2
              UNION ALL
              SELECT id, 'LEDGER_' || ledger_event_type, direction, transaction_hash, created_at,
                     jsonb_build_object('account', account, 'amountAtomic', amount_atomic::text, 'assetSymbol', asset_symbol)
                FROM opes.ledger_entries
               WHERE organization_id = $1
                 AND (source_id = $2 OR source_version_id = $2 OR ledger_event_id = $2)
              UNION ALL
              SELECT id, 'PAYMENT_ATTEMPT', status, transaction_hash, created_at,
                     jsonb_build_object('provider', provider, 'failureReason', failure_reason)
                FROM opes.payment_execution_attempts
               WHERE organization_id = $1 AND execution_id = $2
            ) AS events
           ORDER BY created_at DESC, id DESC
           LIMIT 100
        `,
        [context.organizationId, id],
      );
      return {
        record: mapRecord(record),
        history: history.rows.map(mapHistory),
      };
    });
  }
}

function recordsSql(): string {
  return `
    WITH records AS (
      SELECT v.organization_id, v.id, 'vendor'::text AS kind, v.display_name AS title,
             'Vendor'::text AS subtitle, v.status, NULL::text AS amount_atomic,
             NULL::text AS asset_symbol, NULL::integer AS chain_id, NULL::text AS transaction_hash,
             v.created_at, v.updated_at,
             jsonb_build_object(
               'version', v.version,
               'addresses', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'id', a.id, 'environment', a.environment, 'chainId', a.chain_id,
                   'assetSymbol', a.asset_symbol, 'payoutAddress', a.payout_address, 'status', a.status
                 ) ORDER BY a.created_at DESC)
                   FROM opes.vendor_payout_addresses a
                  WHERE a.organization_id = v.organization_id AND a.vendor_id = v.id
               ), '[]'::jsonb)
             ) AS details
        FROM opes.vendors v
      UNION ALL
      SELECT d.organization_id, d.id, 'evidence', d.filename, d.document_type, d.status,
             NULL, NULL, NULL, NULL, d.created_at, d.created_at,
             jsonb_build_object('contentType', d.content_type, 'sizeBytes', d.size_bytes, 'sha256Hex', d.sha256_hex)
        FROM opes.evidence_documents d
      UNION ALL
      SELECT i.organization_id, i.id, 'invoice', 'Invoice ' || i.invoice_number, v.display_name,
             i.status, i.amount_atomic::text, i.currency, NULL, NULL, i.created_at, i.created_at,
             jsonb_build_object('obligationId', i.obligation_id, 'vendorId', i.vendor_id,
               'vendorAddressId', i.vendor_address_id, 'evidenceDocumentId', i.evidence_document_id,
               'invoiceNumber', i.invoice_number, 'lineItems', i.line_items, 'version', i.version)
        FROM opes.payable_obligation_versions i
        JOIN opes.vendors v ON v.organization_id = i.organization_id AND v.id = i.vendor_id
      UNION ALL
      SELECT p.organization_id, p.id, 'decision', 'Decision · ' || p.derived_action, p.source_type,
             CASE WHEN p.expires_at <= now() THEN 'EXPIRED' ELSE p.derived_action END,
             p.amount_atomic::text, p.route_asset_symbol, p.route_chain_id, NULL, p.created_at, p.created_at,
             jsonb_build_object('sourceId', p.source_id, 'sourceVersionId', p.source_version_id,
               'paymentMode', p.payment_mode, 'liquidityRoute', p.liquidity_route,
               'routeEnvironment', p.route_environment, 'destinationAddress', p.destination_address,
               'checks', p.checks, 'expiresAt', p.expires_at)
        FROM opes.payment_decisions p
      UNION ALL
      SELECT e.organization_id, e.id, 'execution', 'Payment execution', e.route_environment,
             e.status, e.amount_atomic::text, e.route_asset_symbol, e.route_chain_id, e.transaction_hash,
             e.requested_at, e.updated_at,
             jsonb_build_object('decisionId', e.decision_id, 'approvalId', e.approval_id,
               'destinationAddress', e.destination_address, 'failureReason', e.failure_reason,
               'executionMode', e.execution_mode, 'liquidityActionId', e.liquidity_action_id)
        FROM opes.payment_executions e
      UNION ALL
      SELECT s.organization_id, s.id, 'subscription', 'Subscription · ' || v.display_name,
             sv.cadence, s.status, sv.amount_atomic::text, sv.currency, NULL, s.transaction_hash,
             s.created_at, s.updated_at,
             jsonb_build_object('vendorId', s.vendor_id, 'vendorAddressId', s.vendor_address_id,
               'versionId', sv.id, 'anchorDate', sv.anchor_date, 'timezone', sv.timezone,
               'mandateId', s.mandate_id)
        FROM opes.subscriptions s
        JOIN opes.vendors v ON v.organization_id = s.organization_id AND v.id = s.vendor_id
        JOIN LATERAL (
          SELECT * FROM opes.subscription_versions current
           WHERE current.organization_id = s.organization_id AND current.subscription_id = s.id
           ORDER BY current.version DESC LIMIT 1
        ) sv ON true
      UNION ALL
      SELECT e.organization_id, e.id, 'escrow', 'Escrow · ' || v.display_name,
             'Milestone agreement', e.status, e.total_amount_atomic::text, e.currency, NULL,
             e.transaction_hash, e.created_at, e.updated_at,
             jsonb_build_object('vendorId', e.vendor_id, 'vendorAddressId', e.vendor_address_id,
               'chainAgreementId', e.chain_agreement_id,
               'milestones', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title,
                   'amountAtomic', m.amount_atomic::text, 'status', m.status,
                   'evidenceDocumentId', m.evidence_document_id) ORDER BY m.milestone_index)
                   FROM opes.escrow_milestones m
                  WHERE m.organization_id = e.organization_id AND m.agreement_id = e.id
               ), '[]'::jsonb))
        FROM opes.escrow_agreements e
        JOIN opes.vendors v ON v.organization_id = e.organization_id AND v.id = e.vendor_id
      UNION ALL
      SELECT l.organization_id, l.id, 'ledger', replace(l.ledger_event_type, '_', ' '), l.account,
             l.direction, l.amount_atomic::text, l.asset_symbol, NULL, l.transaction_hash,
             l.created_at, l.created_at,
             jsonb_build_object('eventId', l.ledger_event_id, 'lineNumber', l.line_number,
               'sourceType', l.source_type, 'sourceId', l.source_id,
               'sourceVersionId', l.source_version_id, 'counterpartyId', l.counterparty_id)
        FROM opes.ledger_entries l
      UNION ALL
      SELECT a.organization_id, a.id, 'audit', replace(a.event_type, '.', ' '), a.subject_type,
             'RECORDED', NULL, NULL, NULL, NULL, a.created_at, a.created_at,
             jsonb_build_object('subjectId', a.subject_id, 'payload', a.payload)
        FROM opes.audit_events a
    )`;
}

function parseKind(value: string): WorkspaceKind {
  if ((workspaceKinds as readonly string[]).includes(value))
    return value as WorkspaceKind;
  throw new BadRequestException('Unsupported workspace record type');
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^\d+$/.test(value))
    throw new BadRequestException('limit must be an integer');
  const parsed = Number(value);
  if (parsed < 1 || parsed > 50)
    throw new BadRequestException('limit must be between 1 and 50');
  return parsed;
}

function cleanOptional(value: string | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned === undefined || cleaned === '' ? null : cleaned;
}

function requireUuid(value: string): string {
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
      value,
    )
  ) {
    throw new BadRequestException('recordId is invalid');
  }
  return value;
}

function parseCursor(value: string | undefined): Cursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<Cursor>;
    if (
      typeof parsed.createdAt !== 'string' ||
      Number.isNaN(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('invalid cursor');
    }
    return { createdAt: parsed.createdAt, id: requireUuid(parsed.id) };
  } catch {
    throw new BadRequestException('cursor is invalid');
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString('base64url');
}

function mapRecord(row: RecordRow): WorkspaceRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    amountAtomic: row.amount_atomic,
    assetSymbol: row.asset_symbol,
    chainId: row.chain_id,
    transactionHash: row.transaction_hash,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    details: row.details,
  };
}

function mapHistory(row: HistoryRow): WorkspaceHistoryEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    status: row.status,
    transactionHash: row.transaction_hash,
    createdAt: row.created_at.toISOString(),
    details: row.details,
  };
}
