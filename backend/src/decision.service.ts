import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService, TenantDatabase } from './database.service';
import { TenantContext } from './tenant-context';

type DecisionAction = 'PAY' | 'DELAY' | 'ESCALATE' | 'REJECT';
type CheckStatus = 'PASS' | 'BLOCK' | 'REQUIRES_APPROVAL';

const MAX_AUTONOMOUS_USDC_ATOMIC = 1_000_000_000n;
const SUPPORTED_ROUTE = {
  liquidityRoute: 'OPERATING',
  environment: 'arc-testnet',
  chainId: 5042002,
  assetSymbol: 'USDC',
};

export interface EvaluateInvoiceDecisionRequest {
  invoiceVersionId: string;
  modelAction: DecisionAction;
  modelName: string;
  modelRationale: string;
  promptVersion: string;
  route: {
    liquidityRoute: 'OPERATING' | 'GATEWAY' | 'CCTP' | 'NONE';
    environment: string;
    chainId: number;
    assetSymbol: string;
  };
  expiresAt: string;
}

export interface DecisionCheckResponse {
  code: string;
  status: CheckStatus;
  message: string;
}

export interface PaymentDecisionResponse {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceVersionId: string;
  decisionVersion: number;
  paymentMode: string;
  modelAction: DecisionAction;
  derivedAction: DecisionAction;
  liquidityRoute: string;
  routeEnvironment: string;
  routeChainId: number;
  routeAssetSymbol: string;
  amountAtomic: string;
  destinationAddress: string;
  evidenceBundleHash: string;
  policySnapshotHash: string;
  contextHash: string;
  decisionHash: string | null;
  checks: DecisionCheckResponse[];
  expiresAt: string;
}

interface InvoiceVersionRow {
  id: string;
  obligation_id: string;
  vendor_id: string;
  vendor_address_id: string;
  evidence_document_id: string;
  extraction_id: string | null;
  invoice_number: string;
  currency: string;
  amount_atomic: string;
  amount_decimals: number;
  content_hash: string;
  obligation_key: string;
  vendor_status: string;
  vendor_version: number;
  address_status: string;
  payout_address: string;
  address_version: number;
}

interface BindingRow {
  id: string;
  address: string | null;
  status: string;
}

interface DecisionRow {
  id: string;
  source_type: string;
  source_id: string;
  source_version_id: string;
  decision_version: number;
  payment_mode: string;
  model_action: DecisionAction;
  derived_action: DecisionAction;
  liquidity_route: string;
  route_environment: string;
  route_chain_id: number;
  route_asset_symbol: string;
  amount_atomic: string;
  destination_address: string;
  evidence_bundle_hash: string;
  policy_snapshot_hash: string;
  context_hash: string;
  decision_hash: string | null;
  checks: DecisionCheckResponse[];
  expires_at: Date;
}

@Injectable()
export class DecisionService {
  constructor(private readonly database: DatabaseService) {}

  async evaluateInvoicePayment(
    context: TenantContext,
    input: EvaluateInvoiceDecisionRequest,
  ): Promise<PaymentDecisionResponse> {
    const invoiceVersionId = requireUuid(
      input.invoiceVersionId,
      'invoiceVersionId',
    );
    const modelAction = validateAction(input.modelAction);
    const modelName = requireText(input.modelName, 'modelName');
    const modelRationale = requireText(input.modelRationale, 'modelRationale');
    const promptVersion = requireText(input.promptVersion, 'promptVersion');
    const route = validateRoute(input.route);
    const expiresAt = validateFutureTimestamp(input.expiresAt);

    return this.database.withTenant(context, async (database) => {
      const invoice = await getInvoiceVersion(
        database,
        context.organizationId,
        invoiceVersionId,
      );
      const vaultBinding = await getActiveVaultBinding(
        database,
        context.organizationId,
      );
      const checks = buildChecks(invoice, vaultBinding, route, modelAction);
      const derivedAction = deriveAction(modelAction, checks);
      const evidenceBundleHash = hashStable({
        invoiceVersionId: invoice.id,
        contentHash: invoice.content_hash,
        evidenceDocumentId: invoice.evidence_document_id,
        extractionId: invoice.extraction_id,
      });
      const policySnapshot = {
        policyVersion: 'b6-static-v1',
        maxAutonomousUsdcAtomic: MAX_AUTONOMOUS_USDC_ATOMIC.toString(),
        supportedRoute: SUPPORTED_ROUTE,
      };
      const policySnapshotHash = hashStable(policySnapshot);
      const decisionVersion = await nextDecisionVersion(
        database,
        context.organizationId,
        invoice.id,
      );
      const contextPayload = {
        schemaVersion: 'opes.payment-decision.v1',
        organizationId: context.organizationId,
        source: {
          kind: 'INVOICE',
          obligationId: invoice.obligation_id,
          invoiceVersionId: invoice.id,
          obligationKey: invoice.obligation_key,
        },
        vendor: {
          id: invoice.vendor_id,
          version: invoice.vendor_version,
          addressId: invoice.vendor_address_id,
          addressVersion: invoice.address_version,
        },
        destination: invoice.payout_address,
        amountAtomic: invoice.amount_atomic,
        asset: invoice.currency,
        route,
        evidenceBundleHash,
        policySnapshotHash,
        expiresAt,
      };
      const contextHash = hashStable(contextPayload);

      const inserted = await database.query<DecisionRow>(
        `
          INSERT INTO opes.payment_decisions (
            organization_id,
            source_type,
            source_id,
            source_version_id,
            decision_version,
            payment_mode,
            model_action,
            derived_action,
            liquidity_route,
            route_environment,
            route_chain_id,
            route_asset_symbol,
            amount_atomic,
            destination_address,
            vendor_id,
            vendor_address_id,
            evidence_bundle_hash,
            policy_snapshot_hash,
            context_hash,
            decision_hash,
            checks,
            model_name,
            model_rationale,
            prompt_version,
            evidence_check_version,
            expires_at,
            created_by_membership_id
          )
          VALUES (
            $1, 'INVOICE', $2, $3, $4, 'DIRECT', $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, NULL, $18::jsonb, $19, $20,
            $21, 'b6-static-v1', $22, $23
          )
          RETURNING
            id,
            source_type,
            source_id,
            source_version_id,
            decision_version,
            payment_mode,
            model_action,
            derived_action,
            liquidity_route,
            route_environment,
            route_chain_id,
            route_asset_symbol,
            amount_atomic,
            destination_address,
            evidence_bundle_hash,
            policy_snapshot_hash,
            context_hash,
            decision_hash,
            checks,
            expires_at
        `,
        [
          context.organizationId,
          invoice.obligation_id,
          invoice.id,
          decisionVersion,
          modelAction,
          derivedAction,
          route.liquidityRoute,
          route.environment,
          route.chainId,
          route.assetSymbol,
          invoice.amount_atomic,
          invoice.payout_address,
          invoice.vendor_id,
          invoice.vendor_address_id,
          evidenceBundleHash,
          policySnapshotHash,
          contextHash,
          JSON.stringify(checks),
          modelName,
          modelRationale,
          promptVersion,
          expiresAt,
          context.membershipId,
        ],
      );

      return mapDecision(requireRow(inserted.rows[0], 'payment decision'));
    });
  }
}

async function getInvoiceVersion(
  database: TenantDatabase,
  organizationId: string,
  invoiceVersionId: string,
): Promise<InvoiceVersionRow> {
  const result = await database.query<InvoiceVersionRow>(
    `
      SELECT
        version.id,
        version.obligation_id,
        version.vendor_id,
        version.vendor_address_id,
        version.evidence_document_id,
        version.extraction_id,
        version.invoice_number,
        version.currency,
        version.amount_atomic::text AS amount_atomic,
        version.amount_decimals,
        version.content_hash,
        obligation.obligation_key,
        vendor.status AS vendor_status,
        vendor.version AS vendor_version,
        address.status AS address_status,
        address.payout_address,
        address.version AS address_version
      FROM opes.payable_obligation_versions AS version
      JOIN opes.payable_obligations AS obligation
        ON obligation.organization_id = version.organization_id
       AND obligation.id = version.obligation_id
      JOIN opes.vendors AS vendor
        ON vendor.organization_id = version.organization_id
       AND vendor.id = version.vendor_id
      JOIN opes.vendor_payout_addresses AS address
        ON address.organization_id = version.organization_id
       AND address.id = version.vendor_address_id
      WHERE version.organization_id = $1
        AND version.id = $2
        AND version.status = 'ACCEPTED'
      LIMIT 1
    `,
    [organizationId, invoiceVersionId],
  );
  return requireRow(result.rows[0], 'invoice version');
}

async function getActiveVaultBinding(
  database: TenantDatabase,
  organizationId: string,
): Promise<BindingRow | null> {
  const result = await database.query<BindingRow>(
    `
      SELECT id, address, status
        FROM opes.tenant_resource_bindings
       WHERE organization_id = $1
         AND provider = 'arc'
         AND environment = 'arc-testnet'
         AND resource_type = 'business_policy_vault_contract'
         AND status = 'ACTIVE'
       LIMIT 1
    `,
    [organizationId],
  );
  return result.rows[0] ?? null;
}

async function nextDecisionVersion(
  database: TenantDatabase,
  organizationId: string,
  sourceVersionId: string,
): Promise<number> {
  const result = await database.query<{ next_version: number }>(
    `
      SELECT COALESCE(MAX(decision_version), 0) + 1 AS next_version
        FROM opes.payment_decisions
       WHERE organization_id = $1
         AND source_type = 'INVOICE'
         AND source_version_id = $2
    `,
    [organizationId, sourceVersionId],
  );
  return requireRow(result.rows[0], 'next decision version').next_version;
}

function buildChecks(
  invoice: InvoiceVersionRow,
  vaultBinding: BindingRow | null,
  route: EvaluateInvoiceDecisionRequest['route'],
  modelAction: DecisionAction,
): DecisionCheckResponse[] {
  return [
    check(
      'model_advisory_only',
      'PASS',
      `model proposed ${modelAction}; deterministic checks derive executable action`,
    ),
    check(
      'vendor_verified',
      invoice.vendor_status === 'VERIFIED' ? 'PASS' : 'BLOCK',
      invoice.vendor_status === 'VERIFIED'
        ? 'vendor is verified'
        : 'vendor is not verified',
    ),
    check(
      'payout_address_active',
      invoice.address_status === 'VERIFIED_ACTIVE' ? 'PASS' : 'BLOCK',
      invoice.address_status === 'VERIFIED_ACTIVE'
        ? 'payout address is active'
        : 'payout address is not active',
    ),
    check(
      'route_supported',
      routeSupported(route) ? 'PASS' : 'BLOCK',
      routeSupported(route) ? 'route is supported' : 'route is unsupported',
    ),
    check(
      'vault_binding_active',
      vaultBinding?.address !== undefined && vaultBinding.address !== null
        ? 'PASS'
        : 'BLOCK',
      vaultBinding?.address !== undefined && vaultBinding.address !== null
        ? 'verified vault binding is active'
        : 'verified vault binding is missing',
    ),
    check(
      'autonomous_amount_limit',
      BigInt(invoice.amount_atomic) <= MAX_AUTONOMOUS_USDC_ATOMIC
        ? 'PASS'
        : 'REQUIRES_APPROVAL',
      BigInt(invoice.amount_atomic) <= MAX_AUTONOMOUS_USDC_ATOMIC
        ? 'amount is within autonomous limit'
        : 'amount requires human approval',
    ),
  ];
}

function check(
  code: string,
  status: CheckStatus,
  message: string,
): DecisionCheckResponse {
  return { code, status, message };
}

function deriveAction(
  modelAction: DecisionAction,
  checks: DecisionCheckResponse[],
): DecisionAction {
  if (checks.some((item) => item.status === 'BLOCK')) {
    return 'REJECT';
  }
  if (checks.some((item) => item.status === 'REQUIRES_APPROVAL')) {
    return 'ESCALATE';
  }
  return modelAction === 'PAY' ? 'PAY' : modelAction;
}

function routeSupported(
  route: EvaluateInvoiceDecisionRequest['route'],
): boolean {
  return (
    route.liquidityRoute === SUPPORTED_ROUTE.liquidityRoute &&
    route.environment === SUPPORTED_ROUTE.environment &&
    route.chainId === SUPPORTED_ROUTE.chainId &&
    route.assetSymbol === SUPPORTED_ROUTE.assetSymbol
  );
}

function validateRoute(
  route: EvaluateInvoiceDecisionRequest['route'],
): EvaluateInvoiceDecisionRequest['route'] {
  if (route === null || typeof route !== 'object') {
    throw new BadRequestException('route is required');
  }
  const liquidityRoute = requireText(
    route.liquidityRoute,
    'route.liquidityRoute',
  );
  if (!['OPERATING', 'GATEWAY', 'CCTP', 'NONE'].includes(liquidityRoute)) {
    throw new BadRequestException('route.liquidityRoute is invalid');
  }
  const environment = requireText(route.environment, 'route.environment');
  const chainId = route.chainId;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new BadRequestException('route.chainId must be a positive integer');
  }
  const assetSymbol = requireText(
    route.assetSymbol,
    'route.assetSymbol',
  ).toUpperCase();
  return {
    liquidityRoute,
    environment,
    chainId,
    assetSymbol,
  } as EvaluateInvoiceDecisionRequest['route'];
}

function validateAction(value: string): DecisionAction {
  if (!['PAY', 'DELAY', 'ESCALATE', 'REJECT'].includes(value)) {
    throw new BadRequestException('modelAction is invalid');
  }
  return value as DecisionAction;
}

function validateFutureTimestamp(value: string): string {
  const text = requireText(value, 'expiresAt');
  const time = Date.parse(text);
  if (!Number.isFinite(time)) {
    throw new BadRequestException('expiresAt must be an ISO timestamp');
  }
  if (time <= Date.now()) {
    throw new BadRequestException('expiresAt must be in the future');
  }
  return new Date(time).toISOString();
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

function mapDecision(row: DecisionRow): PaymentDecisionResponse {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    decisionVersion: row.decision_version,
    paymentMode: row.payment_mode,
    modelAction: row.model_action,
    derivedAction: row.derived_action,
    liquidityRoute: row.liquidity_route,
    routeEnvironment: row.route_environment,
    routeChainId: row.route_chain_id,
    routeAssetSymbol: row.route_asset_symbol,
    amountAtomic: row.amount_atomic,
    destinationAddress: row.destination_address,
    evidenceBundleHash: row.evidence_bundle_hash,
    policySnapshotHash: row.policy_snapshot_hash,
    contextHash: row.context_hash,
    decisionHash: row.decision_hash,
    checks: row.checks,
    expiresAt: row.expires_at.toISOString(),
  };
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (row === undefined) {
    throw new NotFoundException(`${name} not found`);
  }
  return row;
}
