import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService, TenantDatabase } from './database.service';
import { projectInvoiceAccrualInDatabase } from './ledger.service';
import { TenantContext } from './tenant-context';

const USDC_DECIMALS = 6;

export interface VerifyInvoiceRequest {
  vendorId: string;
  vendorAddressId: string;
  evidenceDocumentId: string;
  extractionId?: string;
  invoiceNumber: string;
  currency: 'USDC';
  amount: string;
  lineItems: Array<{
    description: string;
    amount: string;
  }>;
}

export interface PayableObligationResponse {
  id: string;
  versionId: string;
  version: number;
  vendorId: string;
  vendorAddressId: string;
  evidenceDocumentId: string;
  extractionId: string | null;
  invoiceNumber: string;
  currency: string;
  amountAtomic: string;
  amountDecimals: number;
  obligationKey: string;
  contentHash: string;
  status: string;
}

interface VendorRow {
  id: string;
  status: string;
  display_name: string;
}

interface VendorAddressRow {
  id: string;
  vendor_id: string;
  status: string;
  asset_symbol: string;
  payout_address: string;
}

interface EvidenceDocumentRow {
  id: string;
  document_type: string;
  sha256_hex: string;
}

interface ExtractionRow {
  id: string;
  document_id: string;
  source_sha256_hex: string;
  output: unknown;
}

interface ObligationRow {
  id: string;
}

interface VersionRow {
  id: string;
  version: number;
  status: string;
}

@Injectable()
export class InvoiceService {
  constructor(private readonly database: DatabaseService) {}

  async verifyInvoice(
    context: TenantContext,
    input: VerifyInvoiceRequest,
  ): Promise<PayableObligationResponse> {
    const vendorId = requireUuid(input.vendorId, 'vendorId');
    const vendorAddressId = requireUuid(
      input.vendorAddressId,
      'vendorAddressId',
    );
    const evidenceDocumentId = requireUuid(
      input.evidenceDocumentId,
      'evidenceDocumentId',
    );
    const extractionId =
      input.extractionId === undefined
        ? null
        : requireUuid(input.extractionId, 'extractionId');
    const invoiceNumber = requireText(input.invoiceNumber, 'invoiceNumber');
    const currency = validateCurrency(input.currency);
    const amountAtomic = parseAtomicAmount(
      input.amount,
      USDC_DECIMALS,
      'amount',
    );
    const lineItems = normalizeLineItems(input.lineItems);
    const lineTotal = lineItems.reduce(
      (sum, item) => sum + item.amountAtomic,
      0n,
    );
    if (lineTotal !== amountAtomic) {
      throw new BadRequestException('line item total does not match amount');
    }

    return this.database.withTenant(context, async (database) => {
      const vendor = await getVendor(
        database,
        context.organizationId,
        vendorId,
      );
      if (vendor.status !== 'VERIFIED') {
        throw new ConflictException('Vendor is not verified');
      }

      const address = await getVendorAddress(
        database,
        context.organizationId,
        vendorAddressId,
      );
      if (address.vendor_id !== vendor.id) {
        throw new BadRequestException(
          'vendorAddressId does not belong to vendor',
        );
      }
      if (address.status !== 'VERIFIED_ACTIVE') {
        throw new ConflictException('Vendor payout address is not active');
      }
      if (address.asset_symbol !== currency) {
        throw new BadRequestException(
          'Vendor payout asset does not match invoice currency',
        );
      }

      const document = await getEvidenceDocument(
        database,
        context.organizationId,
        evidenceDocumentId,
      );
      if (document.document_type !== 'INVOICE') {
        throw new BadRequestException('Evidence document is not an invoice');
      }

      const extraction =
        extractionId === null
          ? null
          : await getExtraction(database, context.organizationId, extractionId);
      if (extraction !== null) {
        if (extraction.document_id !== document.id) {
          throw new BadRequestException(
            'Extraction does not belong to invoice document',
          );
        }
        if (extraction.source_sha256_hex !== document.sha256_hex) {
          throw new BadRequestException(
            'Extraction source hash does not match invoice document',
          );
        }
        validateExtractionClaims(extraction.output, {
          vendorName: vendor.display_name,
          invoiceNumber,
          currency,
          amount: input.amount,
          payoutAddress: address.payout_address,
        });
      }

      const obligationKey = hashStable({
        kind: 'invoice',
        vendorId,
        invoiceNumber: invoiceNumber.toUpperCase(),
      });
      const contentHash = hashStable({
        kind: 'invoice-version',
        vendorId,
        vendorAddressId,
        evidenceDocumentId,
        extractionId,
        invoiceNumber: invoiceNumber.toUpperCase(),
        currency,
        amountAtomic: amountAtomic.toString(),
        lineItems: lineItems.map((item) => ({
          description: item.description,
          amountAtomic: item.amountAtomic.toString(),
        })),
      });

      try {
        const obligation = await upsertObligation(database, context, {
          vendorId,
          invoiceNumber,
          obligationKey,
        });
        const version = await insertVersion(database, context, {
          obligationId: obligation.id,
          vendorId,
          vendorAddressId,
          evidenceDocumentId,
          extractionId,
          invoiceNumber,
          currency,
          amountAtomic,
          lineItems,
          contentHash,
        });
        await audit(
          database,
          context,
          'invoice.accepted',
          'payable_obligation',
          obligation.id,
          {
            versionId: version.id,
            amountAtomic: amountAtomic.toString(),
            currency,
          },
        );
        await projectInvoiceAccrualInDatabase(
          database,
          context.organizationId,
          version.id,
        );

        return {
          id: obligation.id,
          versionId: version.id,
          version: version.version,
          vendorId,
          vendorAddressId,
          evidenceDocumentId,
          extractionId,
          invoiceNumber,
          currency,
          amountAtomic: amountAtomic.toString(),
          amountDecimals: USDC_DECIMALS,
          obligationKey,
          contentHash,
          status: version.status,
        };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('Duplicate invoice version');
        }
        throw error;
      }
    });
  }
}

async function getVendor(
  database: TenantDatabase,
  organizationId: string,
  vendorId: string,
): Promise<VendorRow> {
  const result = await database.query<VendorRow>(
    `
      SELECT id, status, display_name
        FROM opes.vendors
       WHERE organization_id = $1
         AND id = $2
       LIMIT 1
    `,
    [organizationId, vendorId],
  );
  return requireRow(result.rows[0], 'vendor');
}

async function getVendorAddress(
  database: TenantDatabase,
  organizationId: string,
  addressId: string,
): Promise<VendorAddressRow> {
  const result = await database.query<VendorAddressRow>(
    `
      SELECT id, vendor_id, status, asset_symbol, payout_address
        FROM opes.vendor_payout_addresses
       WHERE organization_id = $1
         AND id = $2
       LIMIT 1
    `,
    [organizationId, addressId],
  );
  return requireRow(result.rows[0], 'vendor payout address');
}

async function getEvidenceDocument(
  database: TenantDatabase,
  organizationId: string,
  documentId: string,
): Promise<EvidenceDocumentRow> {
  const result = await database.query<EvidenceDocumentRow>(
    `
      SELECT id, document_type, sha256_hex
        FROM opes.evidence_documents
       WHERE organization_id = $1
         AND id = $2
       LIMIT 1
    `,
    [organizationId, documentId],
  );
  return requireRow(result.rows[0], 'evidence document');
}

async function getExtraction(
  database: TenantDatabase,
  organizationId: string,
  extractionId: string,
): Promise<ExtractionRow> {
  const result = await database.query<ExtractionRow>(
    `
      SELECT id, document_id, source_sha256_hex, output
        FROM opes.document_extractions
       WHERE organization_id = $1
         AND id = $2
       LIMIT 1
    `,
    [organizationId, extractionId],
  );
  return requireRow(result.rows[0], 'document extraction');
}

async function upsertObligation(
  database: TenantDatabase,
  context: TenantContext,
  input: {
    vendorId: string;
    invoiceNumber: string;
    obligationKey: string;
  },
): Promise<ObligationRow> {
  const result = await database.query<ObligationRow>(
    `
      INSERT INTO opes.payable_obligations (
        organization_id,
        vendor_id,
        source_reference,
        obligation_key,
        created_by_membership_id
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (organization_id, obligation_key)
      DO UPDATE SET updated_at = opes.payable_obligations.updated_at
      RETURNING id
    `,
    [
      context.organizationId,
      input.vendorId,
      input.invoiceNumber,
      input.obligationKey,
      context.membershipId,
    ],
  );
  return requireRow(result.rows[0], 'payable obligation');
}

async function insertVersion(
  database: TenantDatabase,
  context: TenantContext,
  input: {
    obligationId: string;
    vendorId: string;
    vendorAddressId: string;
    evidenceDocumentId: string;
    extractionId: string | null;
    invoiceNumber: string;
    currency: string;
    amountAtomic: bigint;
    lineItems: NormalizedLineItem[];
    contentHash: string;
  },
): Promise<VersionRow> {
  const version = await nextVersion(
    database,
    context.organizationId,
    input.obligationId,
  );
  const result = await database.query<VersionRow>(
    `
      INSERT INTO opes.payable_obligation_versions (
        organization_id,
        obligation_id,
        version,
        evidence_document_id,
        extraction_id,
        vendor_id,
        vendor_address_id,
        invoice_number,
        currency,
        amount_atomic,
        amount_decimals,
        line_items,
        content_hash,
        created_by_membership_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 6, $11::jsonb, $12, $13)
      RETURNING id, version, status
    `,
    [
      context.organizationId,
      input.obligationId,
      version,
      input.evidenceDocumentId,
      input.extractionId,
      input.vendorId,
      input.vendorAddressId,
      input.invoiceNumber,
      input.currency,
      input.amountAtomic.toString(),
      JSON.stringify(
        input.lineItems.map((item) => ({
          description: item.description,
          amountAtomic: item.amountAtomic.toString(),
        })),
      ),
      input.contentHash,
      context.membershipId,
    ],
  );
  return requireRow(result.rows[0], 'payable obligation version');
}

async function nextVersion(
  database: TenantDatabase,
  organizationId: string,
  obligationId: string,
): Promise<number> {
  const result = await database.query<{ next_version: number }>(
    `
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM opes.payable_obligation_versions
       WHERE organization_id = $1
         AND obligation_id = $2
    `,
    [organizationId, obligationId],
  );
  return requireRow(result.rows[0], 'next version').next_version;
}

async function audit(
  database: TenantDatabase,
  context: TenantContext,
  eventType: string,
  subjectType: string,
  subjectId: string,
  payload: unknown,
): Promise<void> {
  await database.query(
    `
      INSERT INTO opes.audit_events (
        organization_id,
        actor_user_id,
        actor_membership_id,
        event_type,
        subject_type,
        subject_id,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      context.organizationId,
      context.userId,
      context.membershipId,
      eventType,
      subjectType,
      subjectId,
      JSON.stringify(payload),
    ],
  );
}

interface NormalizedLineItem {
  description: string;
  amountAtomic: bigint;
}

function normalizeLineItems(
  items: VerifyInvoiceRequest['lineItems'],
): NormalizedLineItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequestException('lineItems are required');
  }

  return items.map((item, index) => ({
    description: requireText(
      item.description,
      `lineItems.${index}.description`,
    ),
    amountAtomic: parseAtomicAmount(
      item.amount,
      USDC_DECIMALS,
      `lineItems.${index}.amount`,
    ),
  }));
}

function parseAtomicAmount(
  value: string,
  decimals: number,
  name: string,
): bigint {
  const text = requireText(value, name);
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new BadRequestException(`${name} must be a positive decimal string`);
  }
  const [whole, fractional = ''] = text.split('.');
  if (fractional.length > decimals) {
    throw new BadRequestException(`${name} exceeds ${decimals} decimal places`);
  }
  const atomic = BigInt(whole + fractional.padEnd(decimals, '0'));
  if (atomic <= 0n) {
    throw new BadRequestException(`${name} must be greater than zero`);
  }
  return atomic;
}

function validateCurrency(value: string): 'USDC' {
  if (value !== 'USDC') {
    throw new BadRequestException('currency must be USDC');
  }
  return value;
}

function validateExtractionClaims(
  output: unknown,
  expected: {
    vendorName: string;
    invoiceNumber: string;
    currency: string;
    amount: string;
    payoutAddress: string;
  },
): void {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new BadRequestException('Extraction output is malformed');
  }
  const claims = output as Record<string, unknown>;
  compareOptionalString(claims.vendorName, expected.vendorName, 'vendorName');
  compareOptionalString(
    claims.invoiceNumber,
    expected.invoiceNumber,
    'invoiceNumber',
  );
  compareOptionalString(claims.currency, expected.currency, 'currency');
  compareOptionalString(claims.totalAmount, expected.amount, 'totalAmount');
  compareOptionalString(
    claims.payoutAddress,
    expected.payoutAddress,
    'payoutAddress',
  );
}

function compareOptionalString(
  actual: unknown,
  expected: string,
  name: string,
): void {
  if (actual === undefined) {
    return;
  }
  if (typeof actual !== 'string') {
    throw new BadRequestException(`Extraction ${name} is malformed`);
  }
  if (actual.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new BadRequestException(`Extraction ${name} does not match invoice`);
  }
}

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (text === undefined || text === '') {
    throw new BadRequestException(`${name} is required`);
  }
  return text;
}

function requireUuid(value: string, name: string): string {
  const text = requireText(value, name);
  if (!/^[0-9a-fA-F-]{36}$/.test(text)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return text;
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (row === undefined) {
    throw new NotFoundException(`${name} not found`);
  }
  return row;
}
