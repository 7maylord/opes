import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { buildCctpDepositForBurnCalldata } from './cctp-calldata';
import { DatabaseService, TenantDatabase } from './database.service';
import { isEvmAddress } from './evm-decision-hash';
import {
  ChainRoutePoint,
  cctpRouteDetails,
  evaluateLiquidityAction,
  supportedNetworks,
} from './liquidity-policy';
import { loadRuntimeConfig } from './runtime.config';
import { TenantContext } from './tenant-context';

export interface CctpSourceMessageRequest {
  sourceMessage: string;
  sourceMessageHash: string;
}

export interface LiquidityActionRequest {
  actionType: 'GATEWAY_TRANSFER' | 'CCTP_TRANSFER';
  idempotencyKey: string;
  source: ChainRoutePoint;
  destination: ChainRoutePoint;
  amountAtomic: string;
  quoteExpiresAt: string;
}

export interface LiquidityActionResponse {
  id: string;
  actionType: string;
  idempotencyKey: string;
  provider: string;
  simulated: boolean;
  status: string;
  source: ChainRoutePoint;
  destination: ChainRoutePoint;
  amountAtomic: string;
  feeAtomic: string;
  quoteExpiresAt: string;
  providerReference: string | null;
  providerPayload: Record<string, unknown>;
  failureReason: string | null;
}

export interface TreasuryPositionResponse {
  assetSymbol: 'USDC';
  committedPayablesAtomic: string;
  approvedUnsettledPaymentAtomic: string;
  plannedLiquidityAtomic: string;
  supportedNetworks: ReturnType<typeof supportedNetworks>;
}

interface LiquidityActionRow {
  id: string;
  action_type: string;
  idempotency_key: string;
  request_hash: string;
  provider: string;
  simulated: boolean;
  status: string;
  source_environment: string;
  source_chain_id: number;
  source_asset_symbol: string;
  destination_environment: string;
  destination_chain_id: number;
  destination_asset_symbol: string;
  amount_atomic: string;
  fee_atomic: string;
  quote_expires_at: Date;
  provider_reference: string | null;
  provider_payload: Record<string, unknown>;
  failure_reason: string | null;
}

interface WalletBindingRow {
  address: string | null;
}

@Injectable()
export class LiquidityService {
  constructor(private readonly database: DatabaseService) {}

  async planLiquidityAction(
    context: TenantContext,
    input: LiquidityActionRequest,
  ): Promise<LiquidityActionResponse> {
    requireLiquidityRole(context);
    const action = validateLiquidityAction(input);
    const capability = evaluateLiquidityAction(action);
    if (!capability.executable) {
      throw new ConflictException(capability.reason);
    }
    const mode = liquidityExecutionMode();

    const requestHash = hashStable(action);
    return this.database.withTenant(context, async (database) => {
      const existing = await getExistingAction(
        database,
        context.organizationId,
        action.idempotencyKey,
      );
      if (existing !== null) {
        if (existing.request_hash !== requestHash) {
          throw new ConflictException(
            'Idempotency key was already used for a different liquidity action',
          );
        }
        return mapAction(existing);
      }

      const providerPayload = await buildProviderPayload(
        database,
        context.organizationId,
        action,
      );
      const provider = mode === 'sandbox' ? 'sandbox' : 'cctp-v2';
      const simulated = mode === 'sandbox';
      const providerReference = simulated
        ? `sim_${requestHash.slice(0, 24)}`
        : null;
      const inserted = await database.query<LiquidityActionRow>(
        `
          INSERT INTO opes.liquidity_actions (
            organization_id,
            action_type,
            idempotency_key,
            request_hash,
            provider,
            simulated,
            status,
            source_environment,
            source_chain_id,
            source_asset_symbol,
            destination_environment,
            destination_chain_id,
            destination_asset_symbol,
            amount_atomic,
            fee_atomic,
            quote_expires_at,
            provider_reference,
            provider_payload,
            requested_by_membership_id
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, 'PLANNED', $7, $8, $9,
            $10, $11, $12, $13, 0, $14, $15, $16::jsonb, $17
          )
          RETURNING
            id,
            action_type,
            idempotency_key,
            request_hash,
            provider,
            simulated,
            status,
            source_environment,
            source_chain_id,
            source_asset_symbol,
            destination_environment,
            destination_chain_id,
            destination_asset_symbol,
            amount_atomic::text AS amount_atomic,
            fee_atomic::text AS fee_atomic,
            quote_expires_at,
            provider_reference,
            provider_payload,
            failure_reason
        `,
        [
          context.organizationId,
          action.actionType,
          action.idempotencyKey,
          requestHash,
          provider,
          simulated,
          action.source.environment,
          action.source.chainId,
          action.source.assetSymbol,
          action.destination.environment,
          action.destination.chainId,
          action.destination.assetSymbol,
          action.amountAtomic,
          action.quoteExpiresAt,
          providerReference,
          JSON.stringify({
            capabilityReason: capability.reason,
            ...providerPayload,
          }),
          context.membershipId,
        ],
      );

      const row = requireRow(inserted.rows[0], 'liquidity action');
      await enqueueLiquidityAction(database, context.organizationId, row.id);
      return mapAction(row);
    });
  }

  async recordCctpSourceMessage(
    context: TenantContext,
    actionId: string,
    input: CctpSourceMessageRequest,
  ): Promise<LiquidityActionResponse> {
    requireLiquidityRole(context);
    const targetActionId = requireUuid(actionId, 'actionId');
    const sourceMessage = requireHexBytes(input.sourceMessage, 'sourceMessage');
    const sourceMessageHash = requireHex32(
      input.sourceMessageHash,
      'sourceMessageHash',
    );
    if (hashHexBytes(sourceMessage) !== sourceMessageHash.toLowerCase()) {
      throw new BadRequestException(
        'sourceMessageHash does not match sourceMessage',
      );
    }

    return this.database.withTenant(context, async (database) => {
      const result = await database.query<LiquidityActionRow>(
        `
          UPDATE opes.liquidity_actions
             SET provider_payload = provider_payload || jsonb_build_object(
                   'sourceMessage', $3::text,
                   'sourceMessageHash', $4::text
                 ),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
             AND action_type = 'CCTP_TRANSFER'
             AND status = 'SUBMITTED'
          RETURNING
            id,
            action_type,
            idempotency_key,
            request_hash,
            provider,
            simulated,
            status,
            source_environment,
            source_chain_id,
            source_asset_symbol,
            destination_environment,
            destination_chain_id,
            destination_asset_symbol,
            amount_atomic::text AS amount_atomic,
            fee_atomic::text AS fee_atomic,
            quote_expires_at,
            provider_reference,
            provider_payload,
            failure_reason
        `,
        [
          context.organizationId,
          targetActionId,
          sourceMessage,
          sourceMessageHash,
        ],
      );
      const row = requireRow(result.rows[0], 'submitted CCTP liquidity action');
      await enqueueLiquidityAction(database, context.organizationId, row.id);
      return mapAction(row);
    });
  }

  async getTreasuryPosition(
    context: TenantContext,
  ): Promise<TreasuryPositionResponse> {
    return this.database.withTenant(context, async (database) => {
      const result = await database.query<{
        committed_payables_atomic: string;
        approved_unsettled_payment_atomic: string;
        planned_liquidity_atomic: string;
      }>(
        `
          SELECT
            COALESCE((
              SELECT SUM(version.amount_atomic)
                FROM opes.payable_obligation_versions AS version
               WHERE version.organization_id = $1
                 AND version.status = 'ACCEPTED'
            ), 0)::text AS committed_payables_atomic,
            COALESCE((
              SELECT SUM(execution.amount_atomic)
                FROM opes.payment_executions AS execution
               WHERE execution.organization_id = $1
                 AND execution.status IN ('PENDING', 'PROCESSING', 'SUBMITTED', 'UNKNOWN')
            ), 0)::text AS approved_unsettled_payment_atomic,
            COALESCE((
              SELECT SUM(action.amount_atomic + action.fee_atomic)
                FROM opes.liquidity_actions AS action
               WHERE action.organization_id = $1
                 AND action.status IN ('PLANNED', 'SUBMITTED')
            ), 0)::text AS planned_liquidity_atomic
        `,
        [context.organizationId],
      );
      const row = requireRow(result.rows[0], 'treasury position');
      return {
        assetSymbol: 'USDC',
        committedPayablesAtomic: row.committed_payables_atomic,
        approvedUnsettledPaymentAtomic: row.approved_unsettled_payment_atomic,
        plannedLiquidityAtomic: row.planned_liquidity_atomic,
        supportedNetworks: supportedNetworks(),
      };
    });
  }
}

async function buildProviderPayload(
  database: TenantDatabase,
  organizationId: string,
  action: LiquidityActionRequest,
): Promise<Record<string, unknown>> {
  if (action.actionType !== 'CCTP_TRANSFER') {
    return { provider: 'gateway', status: 'not_configured' };
  }
  const route = cctpRouteDetails(action);
  if (route === null) {
    throw new ConflictException('CCTP route details are unavailable');
  }
  const sourceWallet = await getActiveWalletBinding(
    database,
    organizationId,
    action.source.environment,
  );
  const destinationWallet = await getActiveWalletBinding(
    database,
    organizationId,
    action.destination.environment,
  );
  if (!isEvmAddress(sourceWallet.address)) {
    throw new ConflictException('Active source wallet binding is missing');
  }
  if (!isEvmAddress(destinationWallet.address)) {
    throw new ConflictException('Active destination wallet binding is missing');
  }

  const calldata = buildCctpDepositForBurnCalldata({
    amount: action.amountAtomic,
    destinationDomain: route.destination.cctpDomain ?? 0,
    mintRecipient: destinationWallet.address,
    burnToken: route.source.cctpContracts?.usdc ?? '',
  });

  return {
    provider: 'cctp-v2',
    mode: 'standard',
    source: {
      environment: route.source.environment,
      chainId: route.source.chainId,
      domain: route.source.cctpDomain,
      tier: route.source.tier,
      walletAddress: sourceWallet.address,
      usdc: route.source.cctpContracts?.usdc,
      tokenMessengerV2: route.source.cctpContracts?.tokenMessengerV2,
      messageTransmitterV2: route.source.cctpContracts?.messageTransmitterV2,
    },
    destination: {
      environment: route.destination.environment,
      chainId: route.destination.chainId,
      domain: route.destination.cctpDomain,
      tier: route.destination.tier,
      walletAddress: destinationWallet.address,
      usdc: route.destination.cctpContracts?.usdc,
      messageTransmitterV2:
        route.destination.cctpContracts?.messageTransmitterV2,
    },
    signerRequest: {
      provider: 'circle',
      chainId: route.source.chainId,
      from: sourceWallet.address,
      to: route.source.cctpContracts?.tokenMessengerV2,
      data: calldata,
      value: '0',
    },
  };
}

async function getActiveWalletBinding(
  database: TenantDatabase,
  organizationId: string,
  environment: string,
): Promise<WalletBindingRow> {
  const result = await database.query<WalletBindingRow>(
    `
      SELECT address
        FROM opes.tenant_resource_bindings
       WHERE organization_id = $1
         AND provider = 'circle'
         AND environment = $2
         AND resource_type = 'operator_wallet'
         AND status = 'ACTIVE'
       LIMIT 1
    `,
    [organizationId, environment],
  );
  return result.rows[0] ?? { address: null };
}

async function enqueueLiquidityAction(
  database: TenantDatabase,
  organizationId: string,
  actionId: string,
): Promise<void> {
  await database.query(
    `
      INSERT INTO opes.outbox_events (
        organization_id,
        event_type,
        aggregate_type,
        aggregate_id,
        payload
      )
      SELECT $1, 'liquidity.execute.cctp', 'liquidity_action', $2, '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1
          FROM opes.outbox_events
         WHERE organization_id = $1
           AND event_type = 'liquidity.execute.cctp'
           AND aggregate_type = 'liquidity_action'
           AND aggregate_id = $2
           AND status IN ('PENDING', 'PROCESSING')
      )
    `,
    [organizationId, actionId],
  );
}

async function getExistingAction(
  database: TenantDatabase,
  organizationId: string,
  idempotencyKey: string,
): Promise<LiquidityActionRow | null> {
  const result = await database.query<LiquidityActionRow>(
    `
      SELECT
        id,
        action_type,
        idempotency_key,
        request_hash,
        provider,
        simulated,
        status,
        source_environment,
        source_chain_id,
        source_asset_symbol,
        destination_environment,
        destination_chain_id,
        destination_asset_symbol,
        amount_atomic::text AS amount_atomic,
        fee_atomic::text AS fee_atomic,
        quote_expires_at,
        provider_reference,
        provider_payload,
        failure_reason
      FROM opes.liquidity_actions
      WHERE organization_id = $1
        AND idempotency_key = $2
      LIMIT 1
    `,
    [organizationId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function requireUuid(value: string, name: string): string {
  const text = requireText(value, name);
  if (!/^[0-9a-fA-F-]{36}$/.test(text)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return text;
}

function requireHex32(value: string, name: string): string {
  const text = requireHexBytes(value, name).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) {
    throw new BadRequestException(`${name} must be 32 bytes`);
  }
  return text;
}

function requireHexBytes(value: string, name: string): string {
  const text = requireText(value, name);
  const hex = text.startsWith('0x') ? text : `0x${text}`;
  if (hex.length % 2 !== 0 || !/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new BadRequestException(`${name} must be hex bytes`);
  }
  return hex.toLowerCase();
}

function hashHexBytes(value: string): string {
  return `0x${Buffer.from(
    keccak_256(Buffer.from(value.slice(2), 'hex')),
  ).toString('hex')}`;
}

function validateLiquidityAction(
  input: LiquidityActionRequest,
): LiquidityActionRequest {
  if (input === null || typeof input !== 'object') {
    throw new BadRequestException('liquidity action body is required');
  }
  if (!['GATEWAY_TRANSFER', 'CCTP_TRANSFER'].includes(input.actionType)) {
    throw new BadRequestException('actionType is invalid');
  }
  const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
  if (!/^[0-9a-f]{64}$/.test(idempotencyKey)) {
    throw new BadRequestException(
      'idempotencyKey must be 64 lowercase hex characters',
    );
  }
  const amountAtomic = requireText(input.amountAtomic, 'amountAtomic');
  if (!/^[1-9][0-9]*$/.test(amountAtomic)) {
    throw new BadRequestException(
      'amountAtomic must be a positive integer string',
    );
  }
  return {
    actionType: input.actionType,
    idempotencyKey,
    source: validatePoint(input.source, 'source'),
    destination: validatePoint(input.destination, 'destination'),
    amountAtomic,
    quoteExpiresAt: validateFutureTimestamp(input.quoteExpiresAt),
  };
}

function validatePoint(value: ChainRoutePoint, name: string): ChainRoutePoint {
  if (value === null || typeof value !== 'object') {
    throw new BadRequestException(`${name} is required`);
  }
  const environment = requireText(value.environment, `${name}.environment`);
  const chainId = value.chainId;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new BadRequestException(`${name}.chainId must be a positive integer`);
  }
  return {
    environment,
    chainId,
    assetSymbol: requireText(
      value.assetSymbol,
      `${name}.assetSymbol`,
    ).toUpperCase(),
  };
}

function validateFutureTimestamp(value: string): string {
  const raw = requireText(value, 'quoteExpiresAt');
  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) {
    throw new BadRequestException('quoteExpiresAt must be a valid timestamp');
  }
  if (timestamp.getTime() <= Date.now()) {
    throw new BadRequestException('quoteExpiresAt must be in the future');
  }
  return timestamp.toISOString();
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${name} is required`);
  }
  return value.trim();
}

function requireLiquidityRole(context: TenantContext): void {
  if (
    context.role !== 'OWNER' &&
    context.role !== 'ADMIN' &&
    context.role !== 'APPROVER'
  ) {
    throw new ForbiddenException(
      'Only owners, admins and approvers can plan liquidity actions',
    );
  }
}

function liquidityExecutionMode(): 'sandbox' | 'live' {
  if (loadRuntimeConfig().environment !== 'production') {
    if (process.env.OPES_LIQUIDITY_SANDBOX === 'true') {
      return 'sandbox';
    }
  }
  if (process.env.OPES_PAYMENT_SIGNER_URL?.trim()) {
    return 'live';
  }
  throw new ConflictException('Liquidity provider adapter is not configured');
}

function mapAction(row: LiquidityActionRow): LiquidityActionResponse {
  return {
    id: row.id,
    actionType: row.action_type,
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    simulated: row.simulated,
    status: row.status,
    source: {
      environment: row.source_environment,
      chainId: row.source_chain_id,
      assetSymbol: row.source_asset_symbol,
    },
    destination: {
      environment: row.destination_environment,
      chainId: row.destination_chain_id,
      assetSymbol: row.destination_asset_symbol,
    },
    amountAtomic: row.amount_atomic,
    feeAtomic: row.fee_atomic,
    quoteExpiresAt: row.quote_expires_at.toISOString(),
    providerReference: row.provider_reference,
    providerPayload: row.provider_payload,
    failureReason: row.failure_reason,
  };
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
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function requireRow<T>(row: T | undefined, name: string): T {
  if (row === undefined) {
    throw new Error(`${name} not found`);
  }
  return row;
}
