import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { TenantContext } from './tenant-context';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/json',
  'image/jpeg',
  'image/png',
  'text/csv',
  'text/plain',
]);
const MUTATING_EXTRACTION_KEYS = new Set([
  'tool_calls',
  'function_call',
  'tool_call_id',
]);

export interface CreateVendorRequest {
  displayName: string;
  metadata?: unknown;
}

export interface VendorResponse {
  id: string;
  displayName: string;
  status: string;
  version: number;
  metadata: unknown;
}

export interface CreateVendorAddressRequest {
  environment: string;
  chainId: number;
  assetSymbol: string;
  assetAddress: string;
  payoutAddress: string;
  metadata?: unknown;
}

export interface VendorAddressResponse {
  id: string;
  vendorId: string;
  environment: string;
  chainId: number;
  assetSymbol: string;
  assetAddress: string;
  payoutAddress: string;
  status: string;
  version: number;
  replacesAddressId: string | null;
}

export interface RecordEvidenceDocumentRequest {
  documentType: 'INVOICE' | 'CONTRACT' | 'RECEIPT' | 'MILESTONE' | 'OTHER';
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256Hex: string;
  storageKey: string;
  metadata?: unknown;
}

export interface EvidenceDocumentResponse {
  id: string;
  documentType: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256Hex: string;
  storageKey: string;
  status: string;
  metadata: unknown;
}

export interface RecordDocumentExtractionRequest {
  schemaName: string;
  schemaVersion: string;
  modelProvider: string;
  modelName: string;
  sourceSha256Hex: string;
  output: unknown;
}

export interface DocumentExtractionResponse {
  id: string;
  documentId: string;
  schemaName: string;
  schemaVersion: string;
  modelProvider: string;
  modelName: string;
  sourceSha256Hex: string;
  output: unknown;
  status: string;
}

interface VendorRow {
  id: string;
  display_name: string;
  status: string;
  version: number;
  metadata: unknown;
}

interface VendorAddressRow {
  id: string;
  vendor_id: string;
  environment: string;
  chain_id: number;
  asset_symbol: string;
  asset_address: string;
  payout_address: string;
  status: string;
  version: number;
  replaces_address_id: string | null;
}

interface EvidenceDocumentRow {
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

interface DocumentExtractionRow {
  id: string;
  document_id: string;
  schema_name: string;
  schema_version: string;
  model_provider: string;
  model_name: string;
  source_sha256_hex: string;
  output: unknown;
  status: string;
}

@Injectable()
export class EvidenceService {
  constructor(private readonly database: DatabaseService) {}

  async createVendor(
    context: TenantContext,
    input: CreateVendorRequest,
  ): Promise<VendorResponse> {
    requireManagerRole(context);
    const displayName = requireText(input.displayName, 'displayName');

    const result = await this.database.withTenant(context, (database) =>
      database.query<VendorRow>(
        `
          INSERT INTO opes.vendors (
            organization_id,
            display_name,
            metadata,
            created_by_membership_id
          )
          VALUES ($1, $2, $3::jsonb, $4)
          RETURNING id, display_name, status, version, metadata
        `,
        [
          context.organizationId,
          displayName,
          JSON.stringify(input.metadata ?? {}),
          context.membershipId,
        ],
      ),
    );

    return mapVendor(requireRow(result.rows[0], 'vendor'));
  }

  async addVendorAddress(
    context: TenantContext,
    vendorId: string,
    input: CreateVendorAddressRequest,
  ): Promise<VendorAddressResponse> {
    requireManagerRole(context);
    const vendor = requireUuid(vendorId, 'vendorId');
    const address = normalizeAddress(input.payoutAddress, 'payoutAddress');
    const assetAddress = normalizeAddress(input.assetAddress, 'assetAddress');
    const environment = requireText(input.environment, 'environment');
    const assetSymbol = requireText(
      input.assetSymbol,
      'assetSymbol',
    ).toUpperCase();
    const chainId = requirePositiveInteger(input.chainId, 'chainId');

    return this.database.withTenant(context, async (database) => {
      await requireVendor(database, context.organizationId, vendor);
      const active = await database.query<{ id: string; version: number }>(
        `
          SELECT id, version
            FROM opes.vendor_payout_addresses
           WHERE organization_id = $1
             AND vendor_id = $2
             AND environment = $3
             AND chain_id = $4
             AND lower(asset_address) = lower($5)
             AND status = 'VERIFIED_ACTIVE'
           ORDER BY version DESC
           LIMIT 1
        `,
        [context.organizationId, vendor, environment, chainId, assetAddress],
      );
      const prior = active.rows[0];

      const inserted = await database.query<VendorAddressRow>(
        `
          INSERT INTO opes.vendor_payout_addresses (
            organization_id,
            vendor_id,
            environment,
            chain_id,
            asset_symbol,
            asset_address,
            payout_address,
            version,
            replaces_address_id,
            metadata,
            created_by_membership_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
          RETURNING
            id,
            vendor_id,
            environment,
            chain_id,
            asset_symbol,
            asset_address,
            payout_address,
            status,
            version,
            replaces_address_id
        `,
        [
          context.organizationId,
          vendor,
          environment,
          chainId,
          assetSymbol,
          assetAddress,
          address,
          (prior?.version ?? 0) + 1,
          prior?.id ?? null,
          JSON.stringify(input.metadata ?? {}),
          context.membershipId,
        ],
      );

      if (prior !== undefined) {
        await database.query(
          `
            UPDATE opes.vendors
               SET status = 'ADDRESS_REVIEW',
                   version = version + 1,
                   updated_at = now()
             WHERE organization_id = $1
               AND id = $2
          `,
          [context.organizationId, vendor],
        );
        await audit(
          database,
          context,
          'vendor.address_change_requested',
          'vendor',
          vendor,
          {
            previousAddressId: prior.id,
          },
        );
      }

      return mapVendorAddress(requireRow(inserted.rows[0], 'vendor address'));
    });
  }

  async verifyVendorAddress(
    context: TenantContext,
    addressId: string,
  ): Promise<VendorAddressResponse> {
    requireVerifierRole(context);
    const targetAddressId = requireUuid(addressId, 'addressId');

    return this.database.withTenant(context, async (database) => {
      const current = await database.query<VendorAddressRow>(
        `
          SELECT
            id,
            vendor_id,
            environment,
            chain_id,
            asset_symbol,
            asset_address,
            payout_address,
            status,
            version,
            replaces_address_id
          FROM opes.vendor_payout_addresses
          WHERE organization_id = $1
            AND id = $2
          LIMIT 1
        `,
        [context.organizationId, targetAddressId],
      );
      const pending = requireRow(current.rows[0], 'vendor address');
      if (pending.status !== 'PENDING_REVIEW') {
        throw new ConflictException('Vendor address is not pending review');
      }

      await database.query(
        `
          UPDATE opes.vendor_payout_addresses
             SET status = 'SUPERSEDED',
                 updated_at = now()
           WHERE organization_id = $1
             AND vendor_id = $2
             AND environment = $3
             AND chain_id = $4
             AND lower(asset_address) = lower($5)
             AND status = 'VERIFIED_ACTIVE'
        `,
        [
          context.organizationId,
          pending.vendor_id,
          pending.environment,
          pending.chain_id,
          pending.asset_address,
        ],
      );

      const verified = await database.query<VendorAddressRow>(
        `
          UPDATE opes.vendor_payout_addresses
             SET status = 'VERIFIED_ACTIVE',
                 verified_by_membership_id = $3,
                 verified_at = now(),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
          RETURNING
            id,
            vendor_id,
            environment,
            chain_id,
            asset_symbol,
            asset_address,
            payout_address,
            status,
            version,
            replaces_address_id
        `,
        [context.organizationId, targetAddressId, context.membershipId],
      );
      await database.query(
        `
          UPDATE opes.vendors
             SET status = 'VERIFIED',
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [context.organizationId, pending.vendor_id],
      );
      await audit(
        database,
        context,
        'vendor.address_verified',
        'vendor_payout_address',
        targetAddressId,
        { vendorId: pending.vendor_id, version: pending.version },
      );

      return mapVendorAddress(requireRow(verified.rows[0], 'vendor address'));
    });
  }

  async recordEvidenceDocument(
    context: TenantContext,
    input: RecordEvidenceDocumentRequest,
  ): Promise<EvidenceDocumentResponse> {
    const documentType = validateDocumentType(input.documentType);
    const filename = requireText(input.filename, 'filename');
    const contentType = validateContentType(input.contentType);
    const sizeBytes = requireDocumentSize(input.sizeBytes);
    const sha256Hex = validateSha256(input.sha256Hex, 'sha256Hex');
    const storageKey = validateStorageKey(input.storageKey);

    try {
      const result = await this.database.withTenant(context, (database) =>
        database.query<EvidenceDocumentRow>(
          `
            INSERT INTO opes.evidence_documents (
              organization_id,
              document_type,
              filename,
              content_type,
              size_bytes,
              sha256_hex,
              storage_key,
              metadata,
              created_by_membership_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
            RETURNING
              id,
              document_type,
              filename,
              content_type,
              size_bytes,
              sha256_hex,
              storage_key,
              status,
              metadata
          `,
          [
            context.organizationId,
            documentType,
            filename,
            contentType,
            sizeBytes,
            sha256Hex,
            storageKey,
            JSON.stringify(input.metadata ?? {}),
            context.membershipId,
          ],
        ),
      );

      return mapDocument(requireRow(result.rows[0], 'evidence document'));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Evidence document hash already exists');
      }
      throw error;
    }
  }

  async recordDocumentExtraction(
    context: TenantContext,
    documentId: string,
    input: RecordDocumentExtractionRequest,
  ): Promise<DocumentExtractionResponse> {
    const evidenceDocumentId = requireUuid(documentId, 'documentId');
    const schemaName = requireText(input.schemaName, 'schemaName');
    const schemaVersion = requireText(input.schemaVersion, 'schemaVersion');
    const modelProvider = requireText(input.modelProvider, 'modelProvider');
    const modelName = requireText(input.modelName, 'modelName');
    const sourceSha256Hex = validateSha256(
      input.sourceSha256Hex,
      'sourceSha256Hex',
    );
    validateExtractionOutput(input.output);

    const result = await this.database.withTenant(context, async (database) => {
      await requireDocument(
        database,
        context.organizationId,
        evidenceDocumentId,
      );
      return database.query<DocumentExtractionRow>(
        `
          INSERT INTO opes.document_extractions (
            organization_id,
            document_id,
            schema_name,
            schema_version,
            model_provider,
            model_name,
            source_sha256_hex,
            output,
            created_by_membership_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
          RETURNING
            id,
            document_id,
            schema_name,
            schema_version,
            model_provider,
            model_name,
            source_sha256_hex,
            output,
            status
        `,
        [
          context.organizationId,
          evidenceDocumentId,
          schemaName,
          schemaVersion,
          modelProvider,
          modelName,
          sourceSha256Hex,
          JSON.stringify(input.output),
          context.membershipId,
        ],
      );
    });

    return mapExtraction(requireRow(result.rows[0], 'document extraction'));
  }
}

async function requireVendor(
  database: TenantDatabase,
  organizationId: string,
  vendorId: string,
): Promise<void> {
  const result = await database.query(
    `
      SELECT id
        FROM opes.vendors
       WHERE organization_id = $1
         AND id = $2
       LIMIT 1
    `,
    [organizationId, vendorId],
  );
  if (result.rows[0] === undefined) {
    throw new NotFoundException('Vendor not found');
  }
}

async function requireDocument(
  database: TenantDatabase,
  organizationId: string,
  documentId: string,
): Promise<void> {
  const result = await database.query(
    `
      SELECT id
        FROM opes.evidence_documents
       WHERE organization_id = $1
         AND id = $2
       LIMIT 1
    `,
    [organizationId, documentId],
  );
  if (result.rows[0] === undefined) {
    throw new NotFoundException('Evidence document not found');
  }
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

function requireManagerRole(context: TenantContext): void {
  if (context.role !== 'OWNER' && context.role !== 'ADMIN') {
    throw new ForbiddenException('Only owners and admins can manage vendors');
  }
}

function requireVerifierRole(context: TenantContext): void {
  if (
    context.role !== 'OWNER' &&
    context.role !== 'ADMIN' &&
    context.role !== 'APPROVER'
  ) {
    throw new ForbiddenException(
      'Only owners, admins and approvers can verify vendors',
    );
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

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BadRequestException(`${name} must be a positive integer`);
  }
  return value;
}

function requireDocumentSize(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_DOCUMENT_BYTES) {
    throw new BadRequestException('sizeBytes must be between 1 and 10485760');
  }
  return value;
}

function validateContentType(value: string): string {
  const contentType = requireText(value, 'contentType').toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new BadRequestException('contentType is not allowed');
  }
  return contentType;
}

function validateDocumentType(value: string): string {
  if (
    !['INVOICE', 'CONTRACT', 'RECEIPT', 'MILESTONE', 'OTHER'].includes(value)
  ) {
    throw new BadRequestException('documentType is not allowed');
  }
  return value;
}

function validateSha256(value: string, name: string): string {
  const hash = requireText(value, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new BadRequestException(`${name} must be a sha256 hex digest`);
  }
  return hash;
}

function validateStorageKey(value: string): string {
  const key = requireText(value, 'storageKey');
  if (key.startsWith('/') || key.includes('..') || key.length > 512) {
    throw new BadRequestException('storageKey is invalid');
  }
  return key;
}

function normalizeAddress(value: string, name: string): string {
  const address = requireText(value, name).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    throw new BadRequestException(`${name} must be an EVM address`);
  }
  return address;
}

function validateExtractionOutput(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('output must be an object');
  }
  if (containsMutatingToolRequest(value)) {
    throw new BadRequestException(
      'extraction output cannot contain tool calls',
    );
  }
}

function containsMutatingToolRequest(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsMutatingToolRequest);
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) =>
      MUTATING_EXTRACTION_KEYS.has(key) || containsMutatingToolRequest(child),
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

function mapVendor(row: VendorRow): VendorResponse {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    version: row.version,
    metadata: row.metadata,
  };
}

function mapVendorAddress(row: VendorAddressRow): VendorAddressResponse {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    environment: row.environment,
    chainId: row.chain_id,
    assetSymbol: row.asset_symbol,
    assetAddress: row.asset_address,
    payoutAddress: row.payout_address,
    status: row.status,
    version: row.version,
    replacesAddressId: row.replaces_address_id,
  };
}

function mapDocument(row: EvidenceDocumentRow): EvidenceDocumentResponse {
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

function mapExtraction(row: DocumentExtractionRow): DocumentExtractionResponse {
  return {
    id: row.id,
    documentId: row.document_id,
    schemaName: row.schema_name,
    schemaVersion: row.schema_version,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    sourceSha256Hex: row.source_sha256_hex,
    output: row.output,
    status: row.status,
  };
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (row === undefined) {
    throw new Error(`Expected ${name} row`);
  }
  return row;
}
