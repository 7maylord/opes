import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';

export interface PaymentExecutionResponse {
  id: string;
  decisionId: string;
  approvalId: string | null;
  sourceVersionId: string;
  decisionHash: string;
  idempotencyKey: string;
  contextHash: string;
  amountAtomic: string;
  destinationAddress: string;
  routeEnvironment: string;
  routeChainId: number;
  routeAssetSymbol: string;
  vaultAddress: string | null;
  executionMode: string;
  liquidityActionId: string | null;
  tokenAddress: string | null;
  maxSourceDebitAtomic: string | null;
  refundAddress: string | null;
  status: string;
  failureReason: string | null;
  transactionHash?: string | null;
}

interface ExecutionCandidateRow {
  decision_id: string;
  approval_id: string | null;
  source_version_id: string;
  derived_action: string;
  route_environment: string;
  route_chain_id: number;
  route_asset_symbol: string;
  amount_atomic: string;
  destination_address: string;
  decision_context_hash: string;
  approval_context_hash: string | null;
  approval_amount_atomic: string | null;
  approval_destination_address: string | null;
  decision_hash: string | null;
  obligation_key: string;
  obligation_status: string;
  source_version_status: string;
  has_evidence_match: boolean;
  reservation_status: string;
  checks: Array<{ status: string }>;
  decision_expires_at: Date;
  approval_expires_at: Date | null;
  policy_is_active: boolean;
  vault_address: string | null;
  destination_wallet_id: string | null;
  destination_wallet_address: string | null;
  liquidity_action_id: string | null;
  max_source_debit_atomic: string | null;
}

interface ExecutionRow {
  id: string;
  decision_id: string;
  approval_id: string | null;
  source_version_id: string;
  decision_hash: string;
  idempotency_key: string;
  context_hash: string;
  amount_atomic: string;
  destination_address: string;
  route_environment: string;
  route_chain_id: number;
  route_asset_symbol: string;
  vault_address: string | null;
  execution_mode: string;
  liquidity_action_id: string | null;
  token_address: string | null;
  max_source_debit_atomic: string | null;
  refund_address: string | null;
  status: string;
  failure_reason: string | null;
  transaction_hash?: string | null;
}

@Injectable()
export class PaymentExecutionService {
  constructor(private readonly database: DatabaseService) {}

  async requestDecisionExecution(
    context: TenantContext,
    decisionId: string,
  ): Promise<PaymentExecutionResponse> {
    requireExecutionRole(context);

    return this.database.withTenant(context, async (database) => {
      await database.query(
        `SELECT organization_id FROM opes.treasury_settings
         WHERE organization_id=$1 FOR UPDATE`,
        [context.organizationId],
      );
      const candidate = await getExecutionCandidate(
        database,
        context.organizationId,
        decisionId,
      );
      assertExecutable(candidate);

      const execution = await insertExecution(database, context, candidate);
      await database.query(
        `UPDATE opes.treasury_reservations SET status='CONSUMED',updated_at=now()
         WHERE organization_id=$1 AND decision_id=$2 AND status='ACTIVE'`,
        [context.organizationId, candidate.decision_id],
      );
      await enqueueExecution(
        database,
        context.organizationId,
        execution.id,
        execution.execution_mode,
      );

      return mapExecution(execution);
    });
  }
}

async function getExecutionCandidate(
  database: TenantDatabase,
  organizationId: string,
  decisionId: string,
): Promise<ExecutionCandidateRow> {
  const result = await database.query<ExecutionCandidateRow>(
    `
      SELECT
        decision.id AS decision_id,
        approval.id AS approval_id,
        decision.source_version_id,
        decision.derived_action,
        decision.route_environment,
        decision.route_chain_id,
        decision.route_asset_symbol,
        decision.amount_atomic::text AS amount_atomic,
        decision.destination_address,
        decision.context_hash AS decision_context_hash,
        approval.context_hash AS approval_context_hash,
        approval.amount_atomic::text AS approval_amount_atomic,
        approval.destination_address AS approval_destination_address,
        decision.decision_hash,
        obligation.obligation_key,
        obligation.status AS obligation_status,
        source_version.status AS source_version_status,
        EXISTS (
          SELECT 1 FROM opes.payable_evidence_matches evidence_match
          WHERE evidence_match.organization_id=decision.organization_id
            AND evidence_match.invoice_version_id=decision.source_version_id
            AND evidence_match.status='PASS'
        ) AS has_evidence_match,
        decision.checks,
        reservation.status AS reservation_status,
        decision.expires_at AS decision_expires_at,
        approval.expires_at AS approval_expires_at,
        policy.status='ACTIVE' AS policy_is_active,
        vault.address AS vault_address
        , wallet.resource_id AS destination_wallet_id
        , wallet.address AS destination_wallet_address
        , liquidity.id AS liquidity_action_id
        , liquidity.max_source_debit_atomic
      FROM opes.payment_decisions AS decision
      LEFT JOIN opes.payment_decision_approvals AS approval
        ON approval.organization_id = decision.organization_id
       AND approval.decision_id = decision.id
       AND approval.status = 'ACTIVE'
      JOIN opes.payment_policy_versions AS policy
        ON policy.organization_id=decision.organization_id
       AND policy.id=decision.policy_version_id
      JOIN opes.payable_obligations AS obligation
        ON obligation.organization_id = decision.organization_id
       AND obligation.id = decision.source_id
      JOIN opes.payable_obligation_versions AS source_version
        ON source_version.organization_id = decision.organization_id
       AND source_version.id = decision.source_version_id
      JOIN opes.treasury_reservations AS reservation
        ON reservation.organization_id=decision.organization_id
       AND reservation.decision_id=decision.id
       AND reservation.status='ACTIVE'
       AND reservation.expires_at>now()
      LEFT JOIN opes.tenant_resource_bindings AS vault
        ON vault.organization_id = decision.organization_id
       AND vault.provider = 'arc'
       AND vault.environment = 'arc-testnet'
       AND vault.resource_type = 'business_policy_vault_contract'
       AND vault.status = 'ACTIVE'
      LEFT JOIN opes.tenant_resource_bindings AS wallet
        ON wallet.organization_id = decision.organization_id
       AND wallet.provider = 'circle'
       AND wallet.environment = decision.route_environment
       AND wallet.resource_type = 'operator_wallet'
       AND wallet.status = 'ACTIVE'
      LEFT JOIN LATERAL (
        SELECT action.id,
               (action.amount_atomic + action.fee_atomic)::text AS max_source_debit_atomic
          FROM opes.liquidity_actions AS action
         WHERE action.organization_id = decision.organization_id
           AND action.status = 'CONFIRMED'
           AND action.destination_environment = decision.route_environment
           AND action.destination_chain_id = decision.route_chain_id
           AND action.destination_asset_symbol = decision.route_asset_symbol
           AND action.amount_atomic >= decision.amount_atomic
           AND NOT EXISTS (
             SELECT 1 FROM opes.payment_executions AS used
              WHERE used.organization_id = action.organization_id
                AND used.liquidity_action_id = action.id
           )
         ORDER BY action.confirmed_at ASC
         LIMIT 1
      ) AS liquidity ON true
      WHERE decision.organization_id = $1
        AND decision.id = $2
      LIMIT 1
    `,
    [organizationId, decisionId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new NotFoundException('Executable payment decision not found');
  }
  return row;
}

function assertExecutable(candidate: ExecutionCandidateRow): void {
  if (
    candidate.obligation_status !== 'ACCEPTED' ||
    candidate.source_version_status !== 'ACCEPTED' ||
    !candidate.has_evidence_match
  ) {
    throw new ConflictException('Payable evidence is no longer authorized');
  }
  if (candidate.reservation_status !== 'ACTIVE')
    throw new ConflictException('Treasury reservation is not active');
  if (!candidate.policy_is_active)
    throw new ConflictException('Decision policy is no longer active');
  const requiresApproval = candidate.derived_action === 'ESCALATE';
  if (candidate.derived_action !== 'PAY' && !requiresApproval)
    throw new ConflictException(
      'Only authorized payment decisions can be executed',
    );
  if (requiresApproval && candidate.approval_id === null)
    throw new ConflictException('Payment decision requires human approval');
  if (candidate.decision_expires_at.getTime() <= Date.now()) {
    throw new ConflictException('Payment decision is expired');
  }
  if (
    candidate.approval_expires_at !== null &&
    candidate.approval_expires_at.getTime() <= Date.now()
  ) {
    throw new ConflictException('Payment approval is expired');
  }
  if (candidate.checks.some((item) => item.status === 'BLOCK')) {
    throw new ConflictException('Blocked decisions cannot be executed');
  }
  if (candidate.decision_hash === null) {
    throw new ConflictException('Payment decision is missing contract hash');
  }
  const direct =
    candidate.route_environment === 'arc-testnet' &&
    candidate.route_chain_id === 5042002;
  const crosschain =
    candidate.route_environment === 'base-sepolia' &&
    candidate.route_chain_id === 84532;
  if ((!direct && !crosschain) || candidate.route_asset_symbol !== 'USDC') {
    throw new ConflictException('Payment route is not executable');
  }
  if (
    candidate.approval_id !== null &&
    (candidate.approval_context_hash !== candidate.decision_context_hash ||
      candidate.approval_amount_atomic !== candidate.amount_atomic ||
      candidate.approval_destination_address?.toLowerCase() !==
        candidate.destination_address.toLowerCase())
  ) {
    throw new ConflictException('Payment approval no longer matches decision');
  }
  if (direct && candidate.vault_address === null) {
    throw new ConflictException('Active payment vault binding is missing');
  }
  if (
    crosschain &&
    (candidate.destination_wallet_id === null ||
      candidate.destination_wallet_address === null ||
      candidate.liquidity_action_id === null ||
      candidate.max_source_debit_atomic === null)
  )
    throw new ConflictException(
      'Confirmed destination liquidity is unavailable',
    );
}

async function insertExecution(
  database: TenantDatabase,
  context: TenantContext,
  candidate: ExecutionCandidateRow,
): Promise<ExecutionRow> {
  const crosschain = candidate.route_environment === 'base-sepolia';
  const result = await database.query<ExecutionRow>(
    `
      INSERT INTO opes.payment_executions (
        organization_id,
        decision_id,
        approval_id,
        source_version_id,
        decision_hash,
        idempotency_key,
        context_hash,
        amount_atomic,
        destination_address,
        route_environment,
        route_chain_id,
        route_asset_symbol,
        vault_address,
        expires_at,
        requested_by_membership_id
        , execution_mode, liquidity_action_id, token_address,
        max_source_debit_atomic, refund_address
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20)
      ON CONFLICT (organization_id, decision_id)
      DO UPDATE SET updated_at = opes.payment_executions.updated_at
      RETURNING
        id,
        decision_id,
        approval_id,
        source_version_id,
        decision_hash,
        idempotency_key,
        context_hash,
        amount_atomic::text AS amount_atomic,
        destination_address,
        route_environment,
        route_chain_id,
        route_asset_symbol,
        vault_address,
        status,
        failure_reason,
        transaction_hash
        , execution_mode, liquidity_action_id, token_address,
        max_source_debit_atomic::text AS max_source_debit_atomic,
        refund_address
    `,
    [
      context.organizationId,
      candidate.decision_id,
      candidate.approval_id,
      candidate.source_version_id,
      candidate.decision_hash,
      candidate.obligation_key,
      candidate.decision_context_hash,
      candidate.amount_atomic,
      candidate.destination_address,
      candidate.route_environment,
      candidate.route_chain_id,
      candidate.route_asset_symbol,
      candidate.vault_address,
      candidate.decision_expires_at.toISOString(),
      context.membershipId,
      crosschain ? 'CROSSCHAIN_WALLET' : 'DIRECT_VAULT',
      crosschain ? candidate.liquidity_action_id : null,
      !crosschain ? null : '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      crosschain ? candidate.max_source_debit_atomic : null,
      !crosschain ? null : candidate.destination_wallet_address,
    ],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Expected payment execution row');
  }
  return row;
}

async function enqueueExecution(
  database: TenantDatabase,
  organizationId: string,
  executionId: string,
  executionMode: string,
): Promise<void> {
  const eventType =
    executionMode === 'CROSSCHAIN_WALLET'
      ? 'payment.execute.crosschain'
      : 'payment.execute.direct.arc_testnet';
  await database.query(
    `
      INSERT INTO opes.outbox_events (
        organization_id,
        event_type,
        aggregate_type,
        aggregate_id,
        payload
      )
      SELECT $1, $3, 'payment_execution', $2, '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1
          FROM opes.outbox_events
         WHERE organization_id = $1
           AND event_type = $3
           AND aggregate_type = 'payment_execution'
           AND aggregate_id = $2
           AND status IN ('PENDING', 'PROCESSING')
      )
    `,
    [organizationId, executionId, eventType],
  );
}

function requireExecutionRole(context: TenantContext): void {
  if (
    context.role !== 'OWNER' &&
    context.role !== 'ADMIN' &&
    context.role !== 'APPROVER'
  ) {
    throw new ForbiddenException(
      'Only owners, admins and approvers can request payment execution',
    );
  }
}

function mapExecution(row: ExecutionRow): PaymentExecutionResponse {
  return {
    id: row.id,
    decisionId: row.decision_id,
    approvalId: row.approval_id,
    sourceVersionId: row.source_version_id,
    decisionHash: row.decision_hash,
    idempotencyKey: row.idempotency_key,
    contextHash: row.context_hash,
    amountAtomic: row.amount_atomic,
    destinationAddress: row.destination_address,
    routeEnvironment: row.route_environment,
    routeChainId: row.route_chain_id,
    routeAssetSymbol: row.route_asset_symbol,
    vaultAddress: row.vault_address,
    status: row.status,
    failureReason: row.failure_reason,
    transactionHash: row.transaction_hash ?? null,
    executionMode: row.execution_mode,
    liquidityActionId: row.liquidity_action_id,
    tokenAddress: row.token_address ?? null,
    maxSourceDebitAtomic: row.max_source_debit_atomic ?? null,
    refundAddress: row.refund_address ?? null,
  };
}
