import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService, TenantDatabase } from './database.service';
import {
  ChainRoutePoint,
  evaluateLiquidityAction,
  supportedNetworks,
} from './liquidity-policy';
import { loadRuntimeConfig } from './runtime.config';
import { TenantContext } from './tenant-context';

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
  failure_reason: string | null;
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
    if (!liquiditySandboxEnabled()) {
      throw new ConflictException(
        'Liquidity provider adapter is not configured',
      );
    }

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

      const providerReference = `sim_${requestHash.slice(0, 24)}`;
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
            $1, $2, $3, $4, 'sandbox', true, 'PLANNED', $5, $6, $7,
            $8, $9, $10, $11, 0, $12, $13, $14::jsonb, $15
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
            failure_reason
        `,
        [
          context.organizationId,
          action.actionType,
          action.idempotencyKey,
          requestHash,
          action.source.environment,
          action.source.chainId,
          action.source.assetSymbol,
          action.destination.environment,
          action.destination.chainId,
          action.destination.assetSymbol,
          action.amountAtomic,
          action.quoteExpiresAt,
          providerReference,
          JSON.stringify({ capabilityReason: capability.reason }),
          context.membershipId,
        ],
      );

      return mapAction(requireRow(inserted.rows[0], 'liquidity action'));
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

function liquiditySandboxEnabled(): boolean {
  if (loadRuntimeConfig().environment === 'production') {
    return false;
  }
  return process.env.OPES_LIQUIDITY_SANDBOX === 'true';
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
