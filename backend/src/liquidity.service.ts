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
  baseUsdcToUsdtSwapRouteDetails,
  cctpRouteDetails,
  evaluatePaymentRoute,
  evaluateLiquidityAction,
  gatewayRouteDetails,
  supportedNetworks,
} from './liquidity-policy';
import { loadRuntimeConfig } from './runtime.config';
import { TenantContext } from './tenant-context';
import { calculateAvailableLiquidity } from './treasury-position';

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
  configured: boolean;
  snapshotStatus: 'FRESH' | 'STALE' | 'FAILED' | 'MISSING';
  snapshotObservedAt: string | null;
  authorizationReady: boolean;
  verifiedBalanceAtomic: string;
  restrictedBalanceAtomic: string;
  operatingBalanceAtomic: string;
  reservedAtomic: string;
  committedPayablesAtomic: string;
  approvedUnsettledPaymentAtomic: string;
  plannedIncomingAtomic: string;
  inTransitAtomic: string;
  operatingBufferAtomic: string;
  monthlyBudgetAtomic: string | null;
  monthlyBudgetRemainingAtomic: string | null;
  forecast30DaysAtomic: string;
  forecast90DaysAtomic: string;
  availableLiquidityAtomic: string;
  supportedNetworks: ReturnType<typeof supportedNetworks>;
}

export interface TreasurySettingsRequest {
  operatingBufferAtomic: string;
  monthlyBudgetAtomic?: string | null;
  maxSnapshotAgeSeconds?: number;
}

export interface PaymentPolicyRequest {
  autonomousLimitAtomic: string;
  singlePaymentLimitAtomic: string;
  vendorDailyLimitAtomic: string;
  organizationDailyLimitAtomic: string;
  monthlyBudgetAtomic?: string | null;
  operatingBufferAtomic: string;
  allowedRoutes: Array<{
    liquidityRoute: 'OPERATING' | 'GATEWAY' | 'CCTP';
    environment: string;
    chainId: number;
    assetSymbol: string;
  }>;
  allowedAssets: string[];
}

export interface PaymentPolicyResponse extends PaymentPolicyRequest {
  id: string;
  version: number;
  status: 'ACTIVE';
}

export interface TreasuryAvailability {
  ready: boolean;
  availableAtomic: bigint;
  operatingAvailableAtomic: bigint;
  monthlyBudgetRemainingAtomic: bigint | null;
  operatingBufferAtomic: bigint;
  snapshotStatus: TreasuryPositionResponse['snapshotStatus'];
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
  resource_id: string | null;
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
      const provider =
        mode === 'sandbox'
          ? 'sandbox'
          : action.actionType === 'GATEWAY_TRANSFER'
            ? 'circle-gateway'
            : 'cctp-v2';
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
      await enqueueLiquidityAction(
        database,
        context.organizationId,
        row.id,
        row.action_type,
      );
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
      await enqueueLiquidityAction(
        database,
        context.organizationId,
        row.id,
        row.action_type,
      );
      return mapAction(row);
    });
  }

  async getTreasuryPosition(
    context: TenantContext,
  ): Promise<TreasuryPositionResponse> {
    return this.database.withTenant(context, async (database) => {
      return mapTreasuryPosition(
        await readTreasuryPosition(database, context.organizationId, false),
      );
    });
  }

  async configureTreasury(
    context: TenantContext,
    input: TreasurySettingsRequest,
  ): Promise<TreasuryPositionResponse> {
    if (context.role !== 'OWNER')
      throw new ForbiddenException(
        'Only owners can configure treasury controls',
      );
    const buffer = requireAtomic(input.operatingBufferAtomic, true);
    const budget =
      input.monthlyBudgetAtomic === null ||
      input.monthlyBudgetAtomic === undefined
        ? null
        : requireAtomic(input.monthlyBudgetAtomic, false);
    const maxAge = input.maxSnapshotAgeSeconds ?? 300;
    if (!Number.isInteger(maxAge) || maxAge < 30 || maxAge > 3600)
      throw new BadRequestException(
        'maxSnapshotAgeSeconds must be an integer from 30 to 3600',
      );
    return this.database.withTenant(context, async (database) => {
      await database.query(
        `INSERT INTO opes.treasury_settings
          (organization_id,operating_buffer_atomic,monthly_budget_atomic,
           max_snapshot_age_seconds,updated_by_membership_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(organization_id) DO UPDATE SET
           operating_buffer_atomic=EXCLUDED.operating_buffer_atomic,
           monthly_budget_atomic=EXCLUDED.monthly_budget_atomic,
           max_snapshot_age_seconds=EXCLUDED.max_snapshot_age_seconds,
           updated_by_membership_id=EXCLUDED.updated_by_membership_id,
           updated_at=now()`,
        [
          context.organizationId,
          buffer.toString(),
          budget?.toString() ?? null,
          maxAge,
          context.membershipId,
        ],
      );
      await assertNoSigningExecution(database, context.organizationId);
      await database.query(
        `INSERT INTO opes.payment_policy_versions (
           organization_id,version,autonomous_limit_atomic,
           single_payment_limit_atomic,vendor_daily_limit_atomic,
           organization_daily_limit_atomic,monthly_budget_atomic,
           operating_buffer_atomic,allowed_routes,allowed_assets,
           created_by_membership_id
         )
         SELECT $1,1,1000000000,10000000000,25000000000,100000000000,
                $2,$3,
                '["OPERATING:arc-testnet:5042002:USDC","CCTP:base-sepolia:84532:USDC","GATEWAY:base-sepolia:84532:USDC"]'::jsonb,
                '["USDC"]'::jsonb,$4
         WHERE NOT EXISTS (
           SELECT 1 FROM opes.payment_policy_versions
           WHERE organization_id=$1
         )`,
        [
          context.organizationId,
          budget?.toString() ?? null,
          buffer.toString(),
          context.membershipId,
        ],
      );
      const currentPolicy = await database.query<{
        id: string;
        monthly_budget_atomic: string | null;
        operating_buffer_atomic: string;
      }>(
        `SELECT id,monthly_budget_atomic::text,operating_buffer_atomic::text
         FROM opes.payment_policy_versions
         WHERE organization_id=$1 AND status='ACTIVE'`,
        [context.organizationId],
      );
      const current = requireRow(
        currentPolicy.rows[0],
        'active payment policy',
      );
      if (
        current.monthly_budget_atomic !== (budget?.toString() ?? null) ||
        current.operating_buffer_atomic !== buffer.toString()
      ) {
        await database.query(
          `UPDATE opes.payment_policy_versions SET status='SUPERSEDED'
           WHERE organization_id=$1 AND status='ACTIVE'`,
          [context.organizationId],
        );
        const replacement = await database.query<{ id: string }>(
          `INSERT INTO opes.payment_policy_versions (
             organization_id,version,autonomous_limit_atomic,
             single_payment_limit_atomic,vendor_daily_limit_atomic,
             organization_daily_limit_atomic,monthly_budget_atomic,
             operating_buffer_atomic,allowed_routes,allowed_assets,
             created_by_membership_id
           )
           SELECT organization_id,
                  (SELECT max(version)+1 FROM opes.payment_policy_versions WHERE organization_id=$1),
                  autonomous_limit_atomic,single_payment_limit_atomic,
                  vendor_daily_limit_atomic,organization_daily_limit_atomic,
                  $2,$3,allowed_routes,allowed_assets,$4
           FROM opes.payment_policy_versions WHERE id=$5
           RETURNING id`,
          [
            context.organizationId,
            budget?.toString() ?? null,
            buffer.toString(),
            context.membershipId,
            current.id,
          ],
        );
        await invalidateOldPolicyAuthorizations(
          database,
          context.organizationId,
          requireRow(replacement.rows[0], 'replacement payment policy').id,
        );
      }
      return mapTreasuryPosition(
        await readTreasuryPosition(database, context.organizationId, false),
      );
    });
  }

  async configurePaymentPolicy(
    context: TenantContext,
    input: PaymentPolicyRequest,
  ): Promise<PaymentPolicyResponse> {
    if (context.role !== 'OWNER')
      throw new ForbiddenException('Only owners can configure payment policy');
    const autonomous = requireAtomic(input.autonomousLimitAtomic, false);
    const single = requireAtomic(input.singlePaymentLimitAtomic, false);
    if (autonomous > single)
      throw new BadRequestException(
        'autonomousLimitAtomic cannot exceed singlePaymentLimitAtomic',
      );
    const vendorDaily = requireAtomic(input.vendorDailyLimitAtomic, false);
    const organizationDaily = requireAtomic(
      input.organizationDailyLimitAtomic,
      false,
    );
    const budget =
      input.monthlyBudgetAtomic === null ||
      input.monthlyBudgetAtomic === undefined
        ? null
        : requireAtomic(input.monthlyBudgetAtomic, false);
    const buffer = requireAtomic(input.operatingBufferAtomic, true);
    const routes = validatePolicyRoutes(input.allowedRoutes);
    const assets = validatePolicyAssets(input.allowedAssets);

    return this.database.withTenant(context, async (database) => {
      const locked = await database.query<{ max_snapshot_age_seconds: number }>(
        `SELECT max_snapshot_age_seconds FROM opes.treasury_settings
         WHERE organization_id=$1 FOR UPDATE`,
        [context.organizationId],
      );
      if (locked.rows[0] === undefined)
        throw new ConflictException('Configure treasury settings first');
      await assertNoSigningExecution(database, context.organizationId);
      const version = await database.query<{ version: number }>(
        `SELECT COALESCE(MAX(version),0)+1 AS version
         FROM opes.payment_policy_versions WHERE organization_id=$1`,
        [context.organizationId],
      );
      await database.query(
        `UPDATE opes.payment_policy_versions SET status='SUPERSEDED'
         WHERE organization_id=$1 AND status='ACTIVE'`,
        [context.organizationId],
      );
      const inserted = await database.query<{
        id: string;
        version: number;
        status: 'ACTIVE';
      }>(
        `INSERT INTO opes.payment_policy_versions (
           organization_id,version,autonomous_limit_atomic,
           single_payment_limit_atomic,vendor_daily_limit_atomic,
           organization_daily_limit_atomic,monthly_budget_atomic,
           operating_buffer_atomic,allowed_routes,allowed_assets,
           created_by_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
         RETURNING id,version,status`,
        [
          context.organizationId,
          version.rows[0]?.version ?? 1,
          autonomous.toString(),
          single.toString(),
          vendorDaily.toString(),
          organizationDaily.toString(),
          budget?.toString() ?? null,
          buffer.toString(),
          JSON.stringify(routes),
          JSON.stringify(assets),
          context.membershipId,
        ],
      );
      await database.query(
        `UPDATE opes.treasury_settings SET
           operating_buffer_atomic=$2,monthly_budget_atomic=$3,
           updated_by_membership_id=$4,updated_at=now()
         WHERE organization_id=$1`,
        [
          context.organizationId,
          buffer.toString(),
          budget?.toString() ?? null,
          context.membershipId,
        ],
      );
      const row = requireRow(inserted.rows[0], 'payment policy');
      await invalidateOldPolicyAuthorizations(
        database,
        context.organizationId,
        row.id,
      );
      return {
        id: row.id,
        version: row.version,
        status: row.status,
        autonomousLimitAtomic: autonomous.toString(),
        singlePaymentLimitAtomic: single.toString(),
        vendorDailyLimitAtomic: vendorDaily.toString(),
        organizationDailyLimitAtomic: organizationDaily.toString(),
        monthlyBudgetAtomic: budget?.toString() ?? null,
        operatingBufferAtomic: buffer.toString(),
        allowedRoutes: input.allowedRoutes,
        allowedAssets: assets,
      };
    });
  }
}

async function invalidateOldPolicyAuthorizations(
  database: TenantDatabase,
  organizationId: string,
  activePolicyId: string,
): Promise<void> {
  await database.query(
    `UPDATE opes.payment_decision_approvals approval SET status='REVOKED'
     FROM opes.payment_decisions decision
     WHERE approval.organization_id=$1 AND approval.status='ACTIVE'
       AND decision.organization_id=approval.organization_id
       AND decision.id=approval.decision_id
       AND decision.policy_version_id IS DISTINCT FROM $2`,
    [organizationId, activePolicyId],
  );
  await database.query(
    `UPDATE opes.treasury_reservations reservation
     SET status='RELEASED',updated_at=now()
     FROM opes.payment_decisions decision
     WHERE reservation.organization_id=$1 AND reservation.status='ACTIVE'
       AND decision.organization_id=reservation.organization_id
       AND decision.id=reservation.decision_id
       AND decision.policy_version_id IS DISTINCT FROM $2`,
    [organizationId, activePolicyId],
  );
}

async function assertNoSigningExecution(
  database: TenantDatabase,
  organizationId: string,
): Promise<void> {
  const result = await database.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM opes.payment_executions execution
       JOIN opes.payment_execution_preflights preflight
         ON preflight.organization_id=execution.organization_id
        AND preflight.execution_id=execution.id AND preflight.status='PASS'
       WHERE execution.organization_id=$1
         AND execution.status IN ('PENDING','PROCESSING')
     ) AS exists`,
    [organizationId],
  );
  if (result.rows[0]?.exists)
    throw new ConflictException(
      'Payment policy cannot change while an execution is signing',
    );
}

function validatePolicyRoutes(
  routes: PaymentPolicyRequest['allowedRoutes'],
): string[] {
  if (!Array.isArray(routes) || routes.length === 0)
    throw new BadRequestException('allowedRoutes must not be empty');
  return [
    ...new Set(
      routes.map((route) => {
        if (!evaluatePaymentRoute(route).executable)
          throw new BadRequestException(
            'allowedRoutes contains an unsupported route',
          );
        return `${route.liquidityRoute}:${route.environment}:${route.chainId}:${route.assetSymbol.toUpperCase()}`;
      }),
    ),
  ];
}

function validatePolicyAssets(assets: string[]): string[] {
  if (!Array.isArray(assets) || assets.length === 0)
    throw new BadRequestException('allowedAssets must not be empty');
  return [
    ...new Set(
      assets.map((asset) => requireText(asset, 'allowedAssets').toUpperCase()),
    ),
  ];
}

async function buildProviderPayload(
  database: TenantDatabase,
  organizationId: string,
  action: LiquidityActionRequest,
): Promise<Record<string, unknown>> {
  if (action.actionType !== 'CCTP_TRANSFER') {
    return buildGatewayProviderPayload(database, organizationId, action);
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
      walletId: sourceWallet.resource_id,
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
      walletId: destinationWallet.resource_id,
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

async function buildGatewayProviderPayload(
  database: TenantDatabase,
  organizationId: string,
  action: LiquidityActionRequest,
): Promise<Record<string, unknown>> {
  const route = gatewayRouteDetails(action);
  if (route === null) {
    throw new ConflictException('Gateway route details are unavailable');
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

  const destinationSwap =
    action.destination.assetSymbol === 'USDT'
      ? baseUsdcToUsdtSwapRouteDetails(action.destination)
      : null;
  const destinationSwapPayload =
    destinationSwap === null
      ? null
      : {
          ...destinationSwap,
          inputAmountAtomic: action.amountAtomic,
          minimumOutputAtomic: minimumOutputAtomic(
            action.amountAtomic,
            destinationSwap.minimumOutputBps,
          ),
        };

  return {
    provider: 'circle-gateway',
    mode: 'unified-balance-transfer',
    source: {
      environment: route.source.environment,
      chainId: route.source.chainId,
      domain: route.source.cctpDomain,
      tier: route.source.tier,
      walletAddress: sourceWallet.address,
      walletId: sourceWallet.resource_id,
      usdc: route.source.gatewayContracts?.usdc,
      gatewayWallet: route.source.gatewayContracts?.gatewayWallet,
    },
    destination: {
      environment: route.destination.environment,
      chainId: route.destination.chainId,
      domain: route.destination.cctpDomain,
      tier: route.destination.tier,
      walletAddress: destinationWallet.address,
      walletId: destinationWallet.resource_id,
      requestedAssetSymbol: action.destination.assetSymbol,
      deliveredAssetSymbol: 'USDC',
      usdc: route.destination.gatewayContracts?.usdc,
      gatewayMinter: route.destination.gatewayContracts?.gatewayMinter,
    },
    destinationSwap: destinationSwapPayload,
    gatewayRequest: {
      provider: 'circle-gateway',
      action: 'transferUnifiedUsdc',
      sourceChainId: route.source.chainId,
      destinationChainId: route.destination.chainId,
      sourceDomain: route.source.cctpDomain,
      destinationDomain: route.destination.cctpDomain,
      sourceDepositor: sourceWallet.address,
      destinationRecipient: destinationWallet.address,
      sourceToken: route.source.gatewayContracts?.usdc,
      destinationToken: route.destination.gatewayContracts?.usdc,
      sourceContract: route.source.gatewayContracts?.gatewayWallet,
      destinationContract: route.destination.gatewayContracts?.gatewayMinter,
      amountAtomic: action.amountAtomic,
      quoteExpiresAt: action.quoteExpiresAt,
      gatewayApiUrl: gatewayApiUrl(route.source.tier),
      destinationSwap: destinationSwapPayload,
    },
  };
}

function minimumOutputAtomic(amountAtomic: string, bps: number): string {
  return ((BigInt(amountAtomic) * BigInt(bps)) / 10_000n).toString();
}

async function getActiveWalletBinding(
  database: TenantDatabase,
  organizationId: string,
  environment: string,
): Promise<WalletBindingRow> {
  const result = await database.query<WalletBindingRow>(
    `
      SELECT address, resource_id
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
  return result.rows[0] ?? { resource_id: null, address: null };
}

async function enqueueLiquidityAction(
  database: TenantDatabase,
  organizationId: string,
  actionId: string,
  actionType: string,
): Promise<void> {
  const eventType =
    actionType === 'GATEWAY_TRANSFER'
      ? 'liquidity.execute.gateway'
      : 'liquidity.execute.cctp';
  await database.query(
    `
      INSERT INTO opes.outbox_events (
        organization_id,
        event_type,
        aggregate_type,
        aggregate_id,
        payload
      )
      SELECT $1, $3, 'liquidity_action', $2, '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1
          FROM opes.outbox_events
         WHERE organization_id = $1
           AND event_type = $3
           AND aggregate_type = 'liquidity_action'
           AND aggregate_id = $2
           AND status IN ('PENDING', 'PROCESSING')
      )
    `,
    [organizationId, actionId, eventType],
  );
}

function gatewayApiUrl(tier: 'mainnet' | 'testnet'): string {
  const configured = process.env.OPES_GATEWAY_API_URL?.trim();
  if (configured !== undefined && configured !== '') {
    return configured;
  }
  return tier === 'testnet'
    ? 'https://gateway-api-testnet.circle.com/v1/transfer'
    : 'https://gateway-api.circle.com/v1/transfer';
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

interface TreasuryPositionRow {
  configured: boolean;
  operating_buffer_atomic: string;
  monthly_budget_atomic: string | null;
  max_snapshot_age_seconds: number;
  binding_count: string;
  environment_count: string;
  snapshot_count: string;
  verified_balance_atomic: string;
  restricted_balance_atomic: string;
  snapshot_observed_at: Date | null;
  read_count: string;
  failed_read_count: string;
  committed_payables_atomic: string;
  approved_unsettled_atomic: string;
  reserved_atomic: string;
  monthly_settled_atomic: string;
  planned_incoming_atomic: string;
  in_transit_atomic: string;
  forecast_30_atomic: string;
  forecast_90_atomic: string;
}

export async function readTreasuryAvailability(
  database: TenantDatabase,
  organizationId: string,
  lock: boolean,
): Promise<TreasuryAvailability> {
  const row = await readTreasuryPosition(database, organizationId, lock);
  const position = mapTreasuryPosition(row);
  return {
    ready: position.authorizationReady,
    availableAtomic: BigInt(position.availableLiquidityAtomic),
    operatingAvailableAtomic:
      BigInt(position.operatingBalanceAtomic) -
      BigInt(position.reservedAtomic) -
      BigInt(position.approvedUnsettledPaymentAtomic) -
      BigInt(position.operatingBufferAtomic),
    monthlyBudgetRemainingAtomic:
      position.monthlyBudgetRemainingAtomic === null
        ? null
        : BigInt(position.monthlyBudgetRemainingAtomic),
    operatingBufferAtomic: BigInt(position.operatingBufferAtomic),
    snapshotStatus: position.snapshotStatus,
  };
}

async function readTreasuryPosition(
  database: TenantDatabase,
  organizationId: string,
  lock: boolean,
): Promise<TreasuryPositionRow> {
  if (lock) {
    await database.query(
      `SELECT organization_id FROM opes.treasury_settings
       WHERE organization_id=$1 FOR UPDATE`,
      [organizationId],
    );
  }
  const result = await database.query<TreasuryPositionRow>(
    `WITH settings AS (
       SELECT operating_buffer_atomic,monthly_budget_atomic,max_snapshot_age_seconds
       FROM opes.treasury_settings WHERE organization_id=$1
     ), bindings AS (
       SELECT environment,lower(address) AS address,resource_type
       FROM opes.tenant_resource_bindings
       WHERE organization_id=$1 AND status='ACTIVE' AND address IS NOT NULL
         AND resource_type IN ('operator_wallet','business_policy_vault_contract','milestone_escrow_contract')
     ), balances AS (
       SELECT binding.resource_type,snapshot.balance_atomic,snapshot.created_at
       FROM bindings binding
       LEFT JOIN LATERAL (
         SELECT balance_atomic,created_at FROM opes.treasury_balance_snapshots
         WHERE organization_id=$1 AND environment=binding.environment
           AND lower(address)=binding.address AND asset_symbol='USDC'
         ORDER BY block_number DESC LIMIT 1
       ) snapshot ON true
     ), binding_environments AS (
       SELECT DISTINCT environment FROM bindings
     ), read_health AS (
       SELECT latest.status
       FROM binding_environments binding_environment
       LEFT JOIN LATERAL (
         SELECT status FROM opes.treasury_balance_reads
         WHERE organization_id=$1
           AND environment=binding_environment.environment
         ORDER BY observed_at DESC LIMIT 1
       ) latest ON true
     ), accepted AS (
       SELECT DISTINCT ON (version.obligation_id)
         version.amount_atomic,version.due_at
       FROM opes.payable_obligation_versions version
       JOIN opes.payable_obligations obligation
         ON obligation.organization_id=version.organization_id
        AND obligation.id=version.obligation_id
       WHERE version.organization_id=$1 AND version.status='ACCEPTED'
         AND obligation.status='ACCEPTED'
       ORDER BY version.obligation_id,version.version DESC
     )
     SELECT
       EXISTS(SELECT 1 FROM settings) AS configured,
       COALESCE((SELECT operating_buffer_atomic FROM settings),0)::text AS operating_buffer_atomic,
       (SELECT monthly_budget_atomic::text FROM settings) AS monthly_budget_atomic,
       COALESCE((SELECT max_snapshot_age_seconds FROM settings),300) AS max_snapshot_age_seconds,
       (SELECT count(*) FROM bindings)::text AS binding_count,
       (SELECT count(*) FROM binding_environments)::text AS environment_count,
       (SELECT count(balance_atomic) FROM balances)::text AS snapshot_count,
       COALESCE((SELECT sum(balance_atomic) FROM balances),0)::text AS verified_balance_atomic,
       COALESCE((SELECT sum(balance_atomic) FROM balances WHERE resource_type='milestone_escrow_contract'),0)::text AS restricted_balance_atomic,
       (SELECT min(created_at) FROM balances) AS snapshot_observed_at,
       (SELECT count(status) FROM read_health)::text AS read_count,
       (SELECT count(*) FROM read_health WHERE status='FAILED')::text AS failed_read_count,
       COALESCE((SELECT sum(amount_atomic) FROM accepted),0)::text AS committed_payables_atomic,
       COALESCE((SELECT sum(amount_atomic) FROM opes.payment_executions
         WHERE organization_id=$1 AND status IN ('PENDING','PROCESSING','SUBMITTED','UNKNOWN')),0)::text AS approved_unsettled_atomic,
       COALESCE((SELECT sum(amount_atomic) FROM opes.treasury_reservations
         WHERE organization_id=$1 AND status='ACTIVE' AND expires_at>now()),0)::text AS reserved_atomic,
       COALESCE((SELECT sum(amount_atomic) FROM opes.payment_executions
         WHERE organization_id=$1 AND status='CONFIRMED'
           AND updated_at>=date_trunc('month',now())),0)::text AS monthly_settled_atomic,
       COALESCE((SELECT sum(amount_atomic+fee_atomic) FROM opes.liquidity_actions
         WHERE organization_id=$1 AND status='PLANNED'),0)::text AS planned_incoming_atomic,
       COALESCE((SELECT sum(amount_atomic+fee_atomic) FROM opes.liquidity_actions
         WHERE organization_id=$1 AND status IN ('SUBMITTED','ATTESTED','MINTED','SWAP_SUBMITTED','SWAPPED','UNKNOWN')),0)::text AS in_transit_atomic,
       (COALESCE((SELECT sum(amount_atomic) FROM accepted
         WHERE due_at IS NULL OR due_at<=now()+interval '30 days'),0)
        +COALESCE((SELECT sum(amount_atomic) FROM opes.subscription_cycles
          WHERE organization_id=$1 AND status='DUE' AND due_at<=now()+interval '30 days'),0))::text AS forecast_30_atomic,
       (COALESCE((SELECT sum(amount_atomic) FROM accepted
         WHERE due_at IS NULL OR due_at<=now()+interval '90 days'),0)
        +COALESCE((SELECT sum(amount_atomic) FROM opes.subscription_cycles
          WHERE organization_id=$1 AND status='DUE' AND due_at<=now()+interval '90 days'),0))::text AS forecast_90_atomic`,
    [organizationId],
  );
  return requireRow(result.rows[0], 'treasury position');
}

function mapTreasuryPosition(
  row: TreasuryPositionRow,
): TreasuryPositionResponse {
  const observed = row.snapshot_observed_at;
  const complete =
    row.binding_count !== '0' && row.snapshot_count === row.binding_count;
  const age = observed === null ? Infinity : Date.now() - observed.getTime();
  const snapshotStatus =
    row.failed_read_count !== '0'
      ? 'FAILED'
      : !complete || row.read_count !== row.environment_count
        ? 'MISSING'
        : age > row.max_snapshot_age_seconds * 1000
          ? 'STALE'
          : 'FRESH';
  const approved = BigInt(row.approved_unsettled_atomic);
  const reserved = BigInt(row.reserved_atomic);
  const calculated = calculateAvailableLiquidity({
    verified: BigInt(row.verified_balance_atomic),
    restricted: BigInt(row.restricted_balance_atomic),
    reserved,
    approvedUnsettled: approved,
    operatingBuffer: BigInt(row.operating_buffer_atomic),
    monthlyBudget:
      row.monthly_budget_atomic === null
        ? null
        : BigInt(row.monthly_budget_atomic),
    monthlySettled: BigInt(row.monthly_settled_atomic),
    monthlyReserved: reserved + approved,
  });
  const ready = row.configured && snapshotStatus === 'FRESH';
  return {
    assetSymbol: 'USDC',
    configured: row.configured,
    snapshotStatus,
    snapshotObservedAt: observed?.toISOString() ?? null,
    authorizationReady: ready,
    verifiedBalanceAtomic: row.verified_balance_atomic,
    restrictedBalanceAtomic: row.restricted_balance_atomic,
    operatingBalanceAtomic: (
      BigInt(row.verified_balance_atomic) -
      BigInt(row.restricted_balance_atomic)
    ).toString(),
    reservedAtomic: row.reserved_atomic,
    committedPayablesAtomic: row.committed_payables_atomic,
    approvedUnsettledPaymentAtomic: row.approved_unsettled_atomic,
    plannedIncomingAtomic: row.planned_incoming_atomic,
    inTransitAtomic: row.in_transit_atomic,
    operatingBufferAtomic: row.operating_buffer_atomic,
    monthlyBudgetAtomic: row.monthly_budget_atomic,
    monthlyBudgetRemainingAtomic:
      calculated.budgetRemaining?.toString() ?? null,
    forecast30DaysAtomic: row.forecast_30_atomic,
    forecast90DaysAtomic: row.forecast_90_atomic,
    availableLiquidityAtomic: ready ? calculated.available.toString() : '0',
    supportedNetworks: supportedNetworks(),
  };
}

function requireAtomic(value: string, zeroAllowed: boolean): bigint {
  if (!/^\d+$/.test(value))
    throw new BadRequestException('Treasury amount must be atomic digits');
  const parsed = BigInt(value);
  if (zeroAllowed ? parsed < 0n : parsed <= 0n)
    throw new BadRequestException('Treasury amount is out of range');
  return parsed;
}

function liquidityExecutionMode(): 'sandbox' | 'live' {
  if (loadRuntimeConfig().environment !== 'production') {
    if (process.env.OPES_LIQUIDITY_SANDBOX === 'true') {
      return 'sandbox';
    }
  }
  if (
    process.env.CIRCLE_API_KEY?.trim() &&
    process.env.CIRCLE_ENTITY_SECRET?.trim()
  ) {
    return 'live';
  }
  throw new ConflictException('Circle wallets are not configured');
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
