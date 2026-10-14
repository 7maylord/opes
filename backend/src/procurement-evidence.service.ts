import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { projectInvoiceAccrualInDatabase } from './ledger.service';
import {
  evaluatePayableMatch,
  MatchDocument,
  MatchLine,
  MatchUsage,
} from './payable-match';
import { TenantContext } from './tenant-context';

type EvidenceType =
  'PURCHASE_ORDER' | 'CONTRACT' | 'PURCHASE_RECEIPT' | 'SERVICE_ACCEPTANCE';

export interface RecordProcurementEvidenceRequest {
  sourceId?: string;
  evidenceType: EvidenceType;
  vendorId: string;
  sourceReference: string;
  currency: 'USDC';
  totalAmount: string;
  toleranceBps?: number;
  governingSourceId?: string;
  evidenceDocumentId?: string;
  externalAccountingRecordId?: string;
  lineItems: Array<{ description: string; quantity: string; amount: string }>;
}

export interface ProcurementEvidenceResponse {
  sourceId: string;
  versionId: string;
  version: number;
  evidenceType: EvidenceType;
  status: string;
  totalAmountAtomic: string;
}

export interface PayableMatchResponse {
  id: string;
  invoiceVersionId: string;
  status: 'PASS' | 'BLOCKED';
  reasons: string[];
}

interface SourceRow {
  id: string;
  evidence_type: EvidenceType;
  vendor_id: string;
  source_reference: string;
}

interface EvidenceRow extends SourceRow {
  version_id: string;
  version: number;
  status: string;
  currency: string;
  total_amount_atomic: string;
  tolerance_bps: number;
  line_items: unknown;
  governing_source_id: string | null;
  evidence_document_id: string | null;
  external_accounting_record_id: string | null;
}

interface InvoiceRow {
  id: string;
  obligation_id: string;
  vendor_id: string;
  vendor_address_id: string;
  currency: string;
  amount_atomic: string;
  line_items: unknown;
  status: string;
  obligation_status: string;
  address_status: string;
}

interface MatchRow {
  id: string;
  invoice_version_id: string;
  status: 'PASS' | 'BLOCKED';
  reasons: string[];
}

@Injectable()
export class ProcurementEvidenceService {
  constructor(private readonly database: DatabaseService) {}

  async record(
    context: TenantContext,
    input: RecordProcurementEvidenceRequest,
  ): Promise<ProcurementEvidenceResponse> {
    requireVerifier(context);
    const normalized = normalizeEvidenceInput(input);
    return this.database.withTenant(context, async (database) => {
      await requireProvenance(database, context.organizationId, normalized);
      const source = normalized.sourceId
        ? await getAndValidateSource(
            database,
            context.organizationId,
            normalized,
          )
        : await createSource(database, context, normalized);
      if (isDelivery(normalized.evidenceType)) {
        if (!normalized.governingSourceId)
          throw new BadRequestException(
            'governingSourceId is required for delivery evidence',
          );
        const governing = await getSource(
          database,
          context.organizationId,
          normalized.governingSourceId,
        );
        if (!isGoverning(governing.evidence_type))
          throw new BadRequestException(
            'governingSourceId must reference a purchase order or contract',
          );
        if (governing.vendor_id !== normalized.vendorId)
          throw new ConflictException(
            'Delivery and governing evidence vendors do not match',
          );
      } else if (normalized.governingSourceId) {
        throw new BadRequestException(
          'governingSourceId is only allowed for delivery evidence',
        );
      }

      const versionResult = await database.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version),0)+1 AS next_version
         FROM opes.procurement_evidence_versions
         WHERE organization_id=$1 AND source_id=$2`,
        [context.organizationId, source.id],
      );
      const version = requireRow(
        versionResult.rows[0],
        'procurement evidence version',
      ).next_version;
      const inserted = await database.query<EvidenceRow>(
        `INSERT INTO opes.procurement_evidence_versions (
           organization_id,source_id,version,status,currency,total_amount_atomic,
           tolerance_bps,line_items,governing_source_id,evidence_document_id,
           external_accounting_record_id,created_by_membership_id
         ) VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
         RETURNING id AS version_id,version,status,currency,
           total_amount_atomic::text,tolerance_bps,line_items,
           governing_source_id,evidence_document_id,external_accounting_record_id`,
        [
          context.organizationId,
          source.id,
          version,
          normalized.currency,
          normalized.totalAmountAtomic.toString(),
          normalized.toleranceBps,
          JSON.stringify(serializeLines(normalized.lines)),
          normalized.governingSourceId,
          normalized.evidenceDocumentId,
          normalized.externalAccountingRecordId,
          context.membershipId,
        ],
      );
      const row = requireRow(inserted.rows[0], 'procurement evidence');
      await audit(
        database,
        context,
        'procurement.evidence_recorded',
        source.id,
        {
          versionId: row.version_id,
          evidenceType: source.evidence_type,
          version,
        },
      );
      return {
        sourceId: source.id,
        versionId: row.version_id,
        version,
        evidenceType: source.evidence_type,
        status: row.status,
        totalAmountAtomic: row.total_amount_atomic,
      };
    });
  }

  async revoke(
    context: TenantContext,
    sourceId: string,
  ): Promise<ProcurementEvidenceResponse> {
    requireVerifier(context);
    const target = requireUuid(sourceId, 'sourceId');
    return this.database.withTenant(context, async (database) => {
      const current = await getCurrentEvidence(
        database,
        context.organizationId,
        target,
      );
      if (current.status !== 'ACTIVE')
        throw new ConflictException('Procurement evidence is not active');
      const inserted = await database.query<EvidenceRow>(
        `INSERT INTO opes.procurement_evidence_versions (
           organization_id,source_id,version,status,currency,total_amount_atomic,
           tolerance_bps,line_items,governing_source_id,evidence_document_id,
           external_accounting_record_id,created_by_membership_id
         ) VALUES ($1,$2,$3,'REVOKED',$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
         RETURNING id AS version_id,version,status,currency,total_amount_atomic::text,
           tolerance_bps,line_items,governing_source_id,evidence_document_id,
           external_accounting_record_id`,
        [
          context.organizationId,
          target,
          current.version + 1,
          current.currency,
          current.total_amount_atomic,
          current.tolerance_bps,
          JSON.stringify(current.line_items),
          current.governing_source_id,
          current.evidence_document_id,
          current.external_accounting_record_id,
          context.membershipId,
        ],
      );
      await blockMatchedObligations(database, context.organizationId, target);
      const row = requireRow(inserted.rows[0], 'revoked procurement evidence');
      await audit(database, context, 'procurement.evidence_revoked', target, {
        versionId: row.version_id,
      });
      return {
        sourceId: target,
        versionId: row.version_id,
        version: row.version,
        evidenceType: current.evidence_type,
        status: row.status,
        totalAmountAtomic: row.total_amount_atomic,
      };
    });
  }

  async matchInvoice(
    context: TenantContext,
    invoiceVersionId: string,
    governingSourceId: string,
    deliverySourceId: string,
  ): Promise<PayableMatchResponse> {
    requireVerifier(context);
    const invoiceId = requireUuid(invoiceVersionId, 'invoiceVersionId');
    const governingId = requireUuid(governingSourceId, 'governingSourceId');
    const deliveryId = requireUuid(deliverySourceId, 'deliverySourceId');
    return this.database.withTenant(context, async (database) => {
      const existing = await database.query<MatchRow>(
        `SELECT id,invoice_version_id,status,reasons
         FROM opes.payable_evidence_matches
         WHERE organization_id=$1 AND invoice_version_id=$2 AND status='PASS'`,
        [context.organizationId, invoiceId],
      );
      if (existing.rows[0]) return mapMatch(existing.rows[0]);
      const invoice = await getInvoice(
        database,
        context.organizationId,
        invoiceId,
      );
      if (!['PENDING_MATCH', 'BLOCKED'].includes(invoice.status))
        throw new ConflictException(
          'Invoice is not awaiting evidence matching',
        );
      const governing = await getCurrentEvidence(
        database,
        context.organizationId,
        governingId,
      );
      const delivery = await getCurrentEvidence(
        database,
        context.organizationId,
        deliveryId,
      );
      if (!isGoverning(governing.evidence_type))
        throw new BadRequestException(
          'governingSourceId must reference a purchase order or contract',
        );
      if (!isDelivery(delivery.evidence_type))
        throw new BadRequestException(
          'deliverySourceId must reference a receipt or service acceptance',
        );
      const governingUsed = await getUsage(
        database,
        context.organizationId,
        governingId,
        invoiceId,
        'GOVERNING',
      );
      const deliveryUsed = await getUsage(
        database,
        context.organizationId,
        deliveryId,
        invoiceId,
        'DELIVERY',
      );
      const reasons = evaluatePayableMatch({
        invoice: invoiceDocument(invoice),
        governing: evidenceDocument(governing),
        delivery: evidenceDocument(delivery),
        governingSourceId: governingId,
        deliveryGoverningSourceId: delivery.governing_source_id,
        governingUsed,
        deliveryUsed,
        payoutAddressActive: invoice.address_status === 'VERIFIED_ACTIVE',
      });
      const status = reasons.length === 0 ? 'PASS' : 'BLOCKED';
      const inserted = await database.query<MatchRow>(
        `INSERT INTO opes.payable_evidence_matches (
           organization_id,invoice_version_id,governing_evidence_version_id,
           delivery_evidence_version_id,status,reasons,calculation_snapshot,
           created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
         RETURNING id,invoice_version_id,status,reasons`,
        [
          context.organizationId,
          invoiceId,
          governing.version_id,
          delivery.version_id,
          status,
          JSON.stringify(reasons),
          JSON.stringify({
            governingUsedAtomic: governingUsed.amountAtomic.toString(),
            deliveryUsedAtomic: deliveryUsed.amountAtomic.toString(),
            invoiceAmountAtomic: invoice.amount_atomic,
          }),
          context.membershipId,
        ],
      );
      await database.query(
        `UPDATE opes.payable_obligation_versions SET status=$3
         WHERE organization_id=$1 AND id=$2`,
        [
          context.organizationId,
          invoiceId,
          status === 'PASS' ? 'ACCEPTED' : 'BLOCKED',
        ],
      );
      await database.query(
        `UPDATE opes.payable_obligations SET status=$3,updated_at=now()
         WHERE organization_id=$1 AND id=$2 AND status <> 'PAID'`,
        [
          context.organizationId,
          invoice.obligation_id,
          status === 'PASS' ? 'ACCEPTED' : 'BLOCKED',
        ],
      );
      await audit(
        database,
        context,
        `invoice.match_${status.toLowerCase()}`,
        invoice.obligation_id,
        {
          invoiceVersionId: invoiceId,
          governingEvidenceVersionId: governing.version_id,
          deliveryEvidenceVersionId: delivery.version_id,
          reasons,
        },
      );
      if (status === 'PASS')
        await projectInvoiceAccrualInDatabase(
          database,
          context.organizationId,
          invoiceId,
        );
      return mapMatch(requireRow(inserted.rows[0], 'payable evidence match'));
    });
  }
}

interface NormalizedEvidence {
  sourceId: string | null;
  evidenceType: EvidenceType;
  vendorId: string;
  sourceReference: string;
  currency: 'USDC';
  totalAmountAtomic: bigint;
  toleranceBps: number;
  governingSourceId: string | null;
  evidenceDocumentId: string | null;
  externalAccountingRecordId: string | null;
  lines: MatchLine[];
}

function normalizeEvidenceInput(
  input: RecordProcurementEvidenceRequest,
): NormalizedEvidence {
  const evidenceType = requireEvidenceType(input.evidenceType);
  const lines = normalizeLines(input.lineItems);
  const totalAmountAtomic = parseFixed(input.totalAmount, 6, 'totalAmount');
  if (
    lines.reduce((sum, line) => sum + line.amountAtomic, 0n) !==
    totalAmountAtomic
  )
    throw new BadRequestException('line item total does not match totalAmount');
  const toleranceBps = input.toleranceBps ?? 0;
  if (
    !Number.isInteger(toleranceBps) ||
    toleranceBps < 0 ||
    toleranceBps > 10_000
  )
    throw new BadRequestException(
      'toleranceBps must be an integer from 0 to 10000',
    );
  const evidenceDocumentId = optionalUuid(
    input.evidenceDocumentId,
    'evidenceDocumentId',
  );
  const externalAccountingRecordId = optionalUuid(
    input.externalAccountingRecordId,
    'externalAccountingRecordId',
  );
  if (
    Number(Boolean(evidenceDocumentId)) +
      Number(Boolean(externalAccountingRecordId)) !==
    1
  )
    throw new BadRequestException(
      'Exactly one evidenceDocumentId or externalAccountingRecordId is required',
    );
  if (input.currency !== 'USDC')
    throw new BadRequestException('currency must be USDC');
  return {
    sourceId: optionalUuid(input.sourceId, 'sourceId'),
    evidenceType,
    vendorId: requireUuid(input.vendorId, 'vendorId'),
    sourceReference: requireText(input.sourceReference, 'sourceReference'),
    currency: input.currency,
    totalAmountAtomic,
    toleranceBps,
    governingSourceId: optionalUuid(
      input.governingSourceId,
      'governingSourceId',
    ),
    evidenceDocumentId,
    externalAccountingRecordId,
    lines,
  };
}

async function requireProvenance(
  database: TenantDatabase,
  organizationId: string,
  input: NormalizedEvidence,
): Promise<void> {
  const vendor = await database.query(
    `SELECT id FROM opes.vendors WHERE organization_id=$1 AND id=$2 AND status='VERIFIED'`,
    [organizationId, input.vendorId],
  );
  requireRow(vendor.rows[0], 'verified vendor');
  if (input.evidenceDocumentId) {
    const result = await database.query<{
      document_type: string;
      status: string;
    }>(
      `SELECT document_type,status FROM opes.evidence_documents
       WHERE organization_id=$1 AND id=$2`,
      [organizationId, input.evidenceDocumentId],
    );
    const row = requireRow(result.rows[0], 'evidence document');
    const allowed = documentTypes(input.evidenceType);
    if (row.status !== 'VERIFIED' || !allowed.includes(row.document_type))
      throw new ConflictException(
        'Evidence document type or status is invalid',
      );
  } else {
    const result = await database.query<{
      record_type: string;
      normalized_data: unknown;
    }>(
      `SELECT record_type,normalized_data FROM opes.external_accounting_records
       WHERE organization_id=$1 AND id=$2`,
      [organizationId, input.externalAccountingRecordId],
    );
    const row = requireRow(result.rows[0], 'external accounting record');
    const expected =
      input.evidenceType === 'PURCHASE_ORDER'
        ? 'PURCHASE_ORDER'
        : input.evidenceType === 'PURCHASE_RECEIPT'
          ? 'PURCHASE_RECEIPT'
          : null;
    if (row.record_type !== expected)
      throw new ConflictException(
        'Accounting record type does not match evidence type',
      );
    if (
      row.normalized_data &&
      typeof row.normalized_data === 'object' &&
      !Array.isArray(row.normalized_data)
    ) {
      const status = (row.normalized_data as Record<string, unknown>).status;
      if (
        typeof status === 'string' &&
        ['cancel', 'cancelled', 'canceled', 'disabled'].includes(
          status.toLowerCase(),
        )
      )
        throw new ConflictException('Accounting evidence is cancelled');
    }
  }
}

async function createSource(
  database: TenantDatabase,
  context: TenantContext,
  input: NormalizedEvidence,
): Promise<SourceRow> {
  const result = await database.query<SourceRow>(
    `INSERT INTO opes.procurement_evidence_sources (
       organization_id,evidence_type,vendor_id,source_reference,created_by_membership_id
     ) VALUES ($1,$2,$3,$4,$5)
     RETURNING id,evidence_type,vendor_id,source_reference`,
    [
      context.organizationId,
      input.evidenceType,
      input.vendorId,
      input.sourceReference,
      context.membershipId,
    ],
  );
  return requireRow(result.rows[0], 'procurement evidence source');
}

async function getAndValidateSource(
  database: TenantDatabase,
  organizationId: string,
  input: NormalizedEvidence,
): Promise<SourceRow> {
  const row = await getSource(database, organizationId, input.sourceId!);
  if (
    row.evidence_type !== input.evidenceType ||
    row.vendor_id !== input.vendorId ||
    row.source_reference !== input.sourceReference
  )
    throw new ConflictException('Evidence source identity cannot be changed');
  return row;
}

async function getSource(
  database: TenantDatabase,
  organizationId: string,
  sourceId: string,
): Promise<SourceRow> {
  const result = await database.query<SourceRow>(
    `SELECT id,evidence_type,vendor_id,source_reference
     FROM opes.procurement_evidence_sources
     WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
    [organizationId, sourceId],
  );
  return requireRow(result.rows[0], 'procurement evidence source');
}

async function getCurrentEvidence(
  database: TenantDatabase,
  organizationId: string,
  sourceId: string,
): Promise<EvidenceRow> {
  const source = await getSource(database, organizationId, sourceId);
  const result = await database.query<EvidenceRow>(
    `SELECT source.id,source.evidence_type,source.vendor_id,source.source_reference,
       version.id AS version_id,version.version,version.status,version.currency,
       version.total_amount_atomic::text,version.tolerance_bps,version.line_items,
       version.governing_source_id,version.evidence_document_id,
       version.external_accounting_record_id
     FROM opes.procurement_evidence_versions version
     JOIN opes.procurement_evidence_sources source
       ON source.organization_id=version.organization_id AND source.id=version.source_id
     WHERE version.organization_id=$1 AND version.source_id=$2
     ORDER BY version.version DESC LIMIT 1`,
    [organizationId, sourceId],
  );
  return {
    ...requireRow(result.rows[0], 'procurement evidence version'),
    ...source,
  };
}

async function getInvoice(
  database: TenantDatabase,
  organizationId: string,
  invoiceId: string,
): Promise<InvoiceRow> {
  const result = await database.query<InvoiceRow>(
    `SELECT version.id,version.obligation_id,version.vendor_id,
       version.vendor_address_id,version.currency,version.amount_atomic::text,
       version.line_items,version.status,obligation.status AS obligation_status,
       address.status AS address_status
     FROM opes.payable_obligation_versions version
     JOIN opes.payable_obligations obligation
       ON obligation.organization_id=version.organization_id AND obligation.id=version.obligation_id
     JOIN opes.vendor_payout_addresses address
       ON address.organization_id=version.organization_id AND address.id=version.vendor_address_id
     WHERE version.organization_id=$1 AND version.id=$2 FOR UPDATE OF version,obligation`,
    [organizationId, invoiceId],
  );
  return requireRow(result.rows[0], 'invoice version');
}

async function getUsage(
  database: TenantDatabase,
  organizationId: string,
  sourceId: string,
  invoiceId: string,
  role: 'GOVERNING' | 'DELIVERY',
): Promise<MatchUsage> {
  const joinColumn =
    role === 'GOVERNING'
      ? 'match.governing_evidence_version_id'
      : 'match.delivery_evidence_version_id';
  const result = await database.query<{
    amount_atomic: string;
    line_items: unknown;
  }>(
    `SELECT invoice.amount_atomic::text,invoice.line_items
     FROM opes.payable_evidence_matches match
     JOIN opes.procurement_evidence_versions evidence ON evidence.id=${joinColumn}
       AND evidence.organization_id=match.organization_id
     JOIN opes.payable_obligation_versions invoice ON invoice.id=match.invoice_version_id
       AND invoice.organization_id=match.organization_id
     WHERE match.organization_id=$1 AND evidence.source_id=$2
       AND match.status='PASS' AND invoice.status IN ('ACCEPTED','BLOCKED')
       AND invoice.id<>$3`,
    [organizationId, sourceId, invoiceId],
  );
  return {
    amountAtomic: result.rows.reduce(
      (sum, row) => sum + BigInt(row.amount_atomic),
      0n,
    ),
    lines: result.rows.flatMap((row) => parseLines(row.line_items)),
  };
}

async function blockMatchedObligations(
  database: TenantDatabase,
  organizationId: string,
  sourceId: string,
): Promise<void> {
  await database.query(
    `WITH affected AS (
       UPDATE opes.payable_obligation_versions invoice SET status='BLOCKED'
       FROM opes.payable_evidence_matches match
       JOIN opes.procurement_evidence_versions governing
         ON governing.organization_id=match.organization_id
        AND governing.id=match.governing_evidence_version_id
       JOIN opes.procurement_evidence_versions delivery
         ON delivery.organization_id=match.organization_id
        AND delivery.id=match.delivery_evidence_version_id
       JOIN opes.payable_obligations obligation
         ON obligation.organization_id=invoice.organization_id
        AND obligation.id=invoice.obligation_id
       WHERE invoice.organization_id=$1 AND invoice.id=match.invoice_version_id
         AND match.status='PASS' AND obligation.status='ACCEPTED'
         AND (governing.source_id=$2 OR delivery.source_id=$2)
       RETURNING invoice.obligation_id
     )
     UPDATE opes.payable_obligations obligation SET status='BLOCKED',updated_at=now()
     WHERE obligation.organization_id=$1 AND obligation.id IN (SELECT obligation_id FROM affected)`,
    [organizationId, sourceId],
  );
}

function invoiceDocument(row: InvoiceRow): MatchDocument {
  return {
    vendorId: row.vendor_id,
    currency: row.currency,
    totalAmountAtomic: BigInt(row.amount_atomic),
    toleranceBps: 0,
    status: row.status,
    lines: parseLines(row.line_items),
  };
}

function evidenceDocument(row: EvidenceRow): MatchDocument {
  return {
    vendorId: row.vendor_id,
    currency: row.currency,
    totalAmountAtomic: BigInt(row.total_amount_atomic),
    toleranceBps: row.tolerance_bps,
    status: row.status,
    lines: parseLines(row.line_items),
  };
}

function normalizeLines(
  lines: RecordProcurementEvidenceRequest['lineItems'],
): MatchLine[] {
  if (!Array.isArray(lines) || lines.length === 0)
    throw new BadRequestException('lineItems are required');
  return lines.map((line, index) => ({
    description: requireText(
      line.description,
      `lineItems.${index}.description`,
    ),
    quantityMicros: parseFixed(line.quantity, 6, `lineItems.${index}.quantity`),
    amountAtomic: parseFixed(line.amount, 6, `lineItems.${index}.amount`),
  }));
}

function parseLines(value: unknown): MatchLine[] {
  if (!Array.isArray(value))
    throw new ConflictException('Evidence line items are invalid');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new ConflictException('Evidence line item is invalid');
    const row = item as Record<string, unknown>;
    if (
      typeof row.description !== 'string' ||
      typeof row.amountAtomic !== 'string'
    )
      throw new ConflictException('Evidence line item is invalid');
    return {
      description: row.description,
      quantityMicros:
        typeof row.quantityMicros === 'string'
          ? BigInt(row.quantityMicros)
          : 1_000_000n,
      amountAtomic: BigInt(row.amountAtomic),
    };
  });
}

function serializeLines(lines: MatchLine[]) {
  return lines.map((line) => ({
    description: line.description,
    quantityMicros: line.quantityMicros.toString(),
    amountAtomic: line.amountAtomic.toString(),
  }));
}

function parseFixed(value: string, decimals: number, name: string): bigint {
  const text = requireText(value, name);
  if (!/^\d+(\.\d+)?$/.test(text))
    throw new BadRequestException(`${name} must be a positive decimal string`);
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals)
    throw new BadRequestException(`${name} exceeds ${decimals} decimal places`);
  const parsed = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (parsed <= 0n)
    throw new BadRequestException(`${name} must be greater than zero`);
  return parsed;
}

function requireEvidenceType(value: string): EvidenceType {
  if (
    ![
      'PURCHASE_ORDER',
      'CONTRACT',
      'PURCHASE_RECEIPT',
      'SERVICE_ACCEPTANCE',
    ].includes(value)
  )
    throw new BadRequestException('evidenceType is invalid');
  return value as EvidenceType;
}

function documentTypes(type: EvidenceType): string[] {
  if (type === 'CONTRACT') return ['CONTRACT'];
  if (type === 'PURCHASE_RECEIPT') return ['RECEIPT'];
  if (type === 'SERVICE_ACCEPTANCE') return ['MILESTONE', 'OTHER'];
  return ['OTHER'];
}

function isGoverning(type: EvidenceType): boolean {
  return type === 'PURCHASE_ORDER' || type === 'CONTRACT';
}

function isDelivery(type: EvidenceType): boolean {
  return type === 'PURCHASE_RECEIPT' || type === 'SERVICE_ACCEPTANCE';
}

function requireVerifier(context: TenantContext): void {
  if (!['OWNER', 'ADMIN', 'APPROVER'].includes(context.role))
    throw new ForbiddenException('Owner, admin or approver role is required');
}

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new BadRequestException(`${name} is required`);
  return text;
}

function requireUuid(value: string, name: string): string {
  const text = requireText(value, name);
  if (!/^[0-9a-fA-F-]{36}$/.test(text))
    throw new BadRequestException(`${name} must be a UUID`);
  return text;
}

function optionalUuid(value: string | undefined, name: string): string | null {
  return value === undefined ? null : requireUuid(value, name);
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (!row) throw new NotFoundException(`${name} not found`);
  return row;
}

function mapMatch(row: MatchRow): PayableMatchResponse {
  return {
    id: row.id,
    invoiceVersionId: row.invoice_version_id,
    status: row.status,
    reasons: row.reasons,
  };
}

async function audit(
  database: TenantDatabase,
  context: TenantContext,
  eventType: string,
  subjectId: string,
  payload: unknown,
): Promise<void> {
  await database.query(
    `INSERT INTO opes.audit_events (
       organization_id,actor_user_id,actor_membership_id,event_type,
       subject_type,subject_id,payload
     ) VALUES ($1,$2,$3,$4,'PAYABLE_EVIDENCE',$5,$6::jsonb)`,
    [
      context.organizationId,
      context.userId,
      context.membershipId,
      eventType,
      subjectId,
      JSON.stringify(payload),
    ],
  );
}
