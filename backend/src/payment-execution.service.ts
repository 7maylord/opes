import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { TenantContext } from './tenant-context';

export interface PaymentExecutionResponse {
  id: string;
  decisionId: string;
  approvalId: string;
  sourceVersionId: string;
  decisionHash: string;
  idempotencyKey: string;
  contextHash: string;
  amountAtomic: string;
  destinationAddress: string;
  routeEnvironment: string;
  routeChainId: number;
  routeAssetSymbol: string;
  vaultAddress: string;
  status: string;
  failureReason: string | null;
}

interface ExecutionCandidateRow {
  decision_id: string;
  approval_id: string;
  source_version_id: string;
  derived_action: string;
  route_environment: string;
  route_chain_id: number;
  route_asset_symbol: string;
  amount_atomic: string;
  destination_address: string;
  decision_context_hash: string;
  approval_context_hash: string;
  approval_amount_atomic: string;
  approval_destination_address: string;
  decision_hash: string | null;
  obligation_key: string;
  checks: Array<{ status: string }>;
  decision_expires_at: Date;
  approval_expires_at: Date;
  vault_address: string | null;
}

interface ExecutionRow {
  id: string;
  decision_id: string;
  approval_id: string;
  source_version_id: string;
  decision_hash: string;
  idempotency_key: string;
  context_hash: string;
  amount_atomic: string;
  destination_address: string;
  route_environment: string;
  route_chain_id: number;
  route_asset_symbol: string;
  vault_address: string;
  status: string;
  failure_reason: string | null;
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
      const candidate = await getExecutionCandidate(
        database,
        context.organizationId,
        decisionId,
      );
      assertExecutable(candidate);

      const execution = await insertExecution(database, context, candidate);
      await enqueueExecution(database, context.organizationId, execution.id);

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
        decision.checks,
        decision.expires_at AS decision_expires_at,
        approval.expires_at AS approval_expires_at,
        vault.address AS vault_address
      FROM opes.payment_decisions AS decision
      JOIN opes.payment_decision_approvals AS approval
        ON approval.organization_id = decision.organization_id
       AND approval.decision_id = decision.id
       AND approval.status = 'ACTIVE'
      JOIN opes.payable_obligations AS obligation
        ON obligation.organization_id = decision.organization_id
       AND obligation.id = decision.source_id
      LEFT JOIN opes.tenant_resource_bindings AS vault
        ON vault.organization_id = decision.organization_id
       AND vault.provider = 'arc'
       AND vault.environment = 'arc-testnet'
       AND vault.resource_type = 'business_policy_vault_contract'
       AND vault.status = 'ACTIVE'
      WHERE decision.organization_id = $1
        AND decision.id = $2
      LIMIT 1
    `,
    [organizationId, decisionId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new NotFoundException('Approved payment decision not found');
  }
  return row;
}

function assertExecutable(candidate: ExecutionCandidateRow): void {
  if (candidate.derived_action !== 'PAY') {
    throw new ConflictException('Only payable decisions can be executed');
  }
  if (candidate.decision_expires_at.getTime() <= Date.now()) {
    throw new ConflictException('Payment decision is expired');
  }
  if (candidate.approval_expires_at.getTime() <= Date.now()) {
    throw new ConflictException('Payment approval is expired');
  }
  if (candidate.checks.some((item) => item.status === 'BLOCK')) {
    throw new ConflictException('Blocked decisions cannot be executed');
  }
  if (candidate.decision_hash === null) {
    throw new ConflictException('Payment decision is missing contract hash');
  }
  if (
    candidate.route_environment !== 'arc-testnet' ||
    candidate.route_chain_id !== 5042002 ||
    candidate.route_asset_symbol !== 'USDC'
  ) {
    throw new ConflictException('Payment route is not executable');
  }
  if (
    candidate.approval_context_hash !== candidate.decision_context_hash ||
    candidate.approval_amount_atomic !== candidate.amount_atomic ||
    candidate.approval_destination_address.toLowerCase() !==
      candidate.destination_address.toLowerCase()
  ) {
    throw new ConflictException('Payment approval no longer matches decision');
  }
  if (candidate.vault_address === null) {
    throw new ConflictException('Active payment vault binding is missing');
  }
}

async function insertExecution(
  database: TenantDatabase,
  context: TenantContext,
  candidate: ExecutionCandidateRow,
): Promise<ExecutionRow> {
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
        requested_by_membership_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
        failure_reason
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
      context.membershipId,
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
      SELECT $1, 'payment.execute.direct.arc_testnet', 'payment_execution', $2, '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1
          FROM opes.outbox_events
         WHERE organization_id = $1
           AND event_type = 'payment.execute.direct.arc_testnet'
           AND aggregate_type = 'payment_execution'
           AND aggregate_id = $2
           AND status IN ('PENDING', 'PROCESSING')
      )
    `,
    [organizationId, executionId],
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
  };
}
