import { Injectable, Logger } from '@nestjs/common';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createHash } from 'node:crypto';
import { CircleWalletService } from './circle-wallet.service';
import { DatabaseService, TenantDatabase } from './database.service';
import {
  buildErc20TransferCalldata,
  buildExecuteDirectPaymentCalldata,
} from './evm-calldata';
import { isEvmAddress } from './evm-decision-hash';
import { FactoryManifestService } from './factory-manifest.service';
import { projectPaymentSettlementInDatabase } from './ledger.service';
import {
  recordNotification,
  recordPaymentSettlementCommunications,
} from './notification.service';

interface OutboxEventRow {
  id: string;
  organization_id: string;
  aggregate_id: string;
}
interface ExecutionWorkRow {
  id: string;
  organization_id: string;
  decision_hash: string;
  idempotency_key: string;
  context_hash: string;
  amount_atomic: string;
  destination_address: string;
  route_chain_id: number;
  route_environment: string;
  route_asset_symbol: string;
  vault_address: string | null;
  execution_mode: 'DIRECT_VAULT' | 'CROSSCHAIN_WALLET';
  token_address: string | null;
  liquidity_action_id: string | null;
  expires_at: Date | null;
  wallet_id: string | null;
  wallet_address: string | null;
  attempt_id: string | null;
  attempt_status: string | null;
  provider_transaction_id: string | null;
  call_data: string | null;
}
interface CircleTransactionEvidence {
  id: string;
  state: string;
  blockchain: string;
  walletId?: string;
  sourceAddress?: string;
  contractAddress?: string;
  txHash?: string;
  errorReason?: string;
  errorDetails?: string;
}
interface RpcTransaction {
  from: string;
  to: string | null;
  input: string;
}
interface RpcLog {
  address: string;
  topics: string[];
  data: string;
}
interface RpcReceipt {
  status: string;
  transactionHash: string;
  logs: RpcLog[];
}
interface SignerRequest {
  provider: 'circle';
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: '0';
  idempotencyKey: string;
  executionId: string;
}
interface PreflightStateRow {
  derived_action: string;
  decision_expires_at: Date;
  policy_status: string;
  organization_status: string;
  agent_status: string;
  vendor_status: string;
  vendor_version: number;
  bound_vendor_version: number;
  address_status: string;
  address_version: number;
  bound_address_version: number;
  payout_address: string;
  source_status: string;
  obligation_status: string;
  has_evidence_match: boolean;
  reservation_status: string | null;
  has_active_approval: boolean;
  single_payment_limit_atomic: string;
  vendor_daily_limit_atomic: string;
  organization_daily_limit_atomic: string;
  monthly_budget_atomic: string | null;
  operating_buffer_atomic: string;
  vendor_daily_committed_atomic: string;
  organization_daily_committed_atomic: string;
  monthly_committed_atomic: string;
  duplicate_execution: boolean;
  max_source_debit_atomic: string | null;
}

const TERMINAL_CIRCLE_FAILURES = new Set(['FAILED', 'DENIED', 'CANCELLED']);
const PAYMENT_EXECUTED_TOPIC = eventTopic(
  'PaymentExecuted(bytes32,bytes32,address,uint256,address)',
);
const TRANSFER_TOPIC = eventTopic('Transfer(address,address,uint256)');

@Injectable()
export class PaymentExecutionWorkerService {
  private readonly logger = new Logger(PaymentExecutionWorkerService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly circle: CircleWalletService,
    private readonly factoryManifests: FactoryManifestService,
  ) {}

  async processDuePaymentExecutions(limit = 10): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const event = await this.claimNextPaymentExecutionEvent();
      if (event === undefined) return processed;
      await this.processPaymentExecution(event);
      processed += 1;
    }
    return processed;
  }

  private async claimNextPaymentExecutionEvent(): Promise<
    OutboxEventRow | undefined
  > {
    return this.database.withWorker(async (database) => {
      const result = await database.query<OutboxEventRow>(
        `UPDATE opes.outbox_events
            SET status = 'PROCESSING', updated_at = now()
          WHERE id = (
            SELECT id FROM opes.outbox_events
             WHERE event_type IN ('payment.execute.direct.arc_testnet', 'payment.execute.crosschain')
               AND ((status = 'PENDING' AND available_at <= now())
                 OR (status = 'PROCESSING' AND updated_at < now() - interval '5 minutes'))
             ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
          )
          RETURNING id, organization_id, aggregate_id`,
      );
      return result.rows[0];
    });
  }

  private async processPaymentExecution(event: OutboxEventRow): Promise<void> {
    const execution = await this.prepareExecution(event);
    if (execution === null) return;
    if (!execution.wallet_id || !isEvmAddress(execution.wallet_address)) {
      await this.fail(
        event,
        execution.attempt_id,
        'Active Circle operator wallet binding is missing',
      );
      return;
    }
    if (execution.expires_at === null) {
      await this.fail(
        event,
        execution.attempt_id,
        'Payment execution is missing expiry',
      );
      return;
    }
    if (execution.expires_at.getTime() <= Date.now()) {
      await this.fail(
        event,
        execution.attempt_id,
        'Payment execution is expired',
      );
      return;
    }

    const callData =
      execution.execution_mode === 'CROSSCHAIN_WALLET'
        ? buildErc20TransferCalldata(
            execution.destination_address,
            execution.amount_atomic,
          )
        : buildExecuteDirectPaymentCalldata({
            decisionHash: execution.decision_hash,
            obligationKey: execution.idempotency_key,
            contextHash: execution.context_hash,
            idempotencyKey: execution.idempotency_key,
            vendor: execution.destination_address,
            amount: execution.amount_atomic,
            expiresAt: execution.expires_at.toISOString(),
          });
    const contractAddress =
      execution.execution_mode === 'CROSSCHAIN_WALLET'
        ? execution.token_address
        : execution.vault_address;
    if (!contractAddress) {
      await this.fail(
        event,
        execution.attempt_id,
        'Payment contract is missing',
      );
      return;
    }
    if (
      execution.call_data !== null &&
      execution.call_data.toLowerCase() !== callData.toLowerCase()
    ) {
      await this.fail(
        event,
        execution.attempt_id,
        'Stored payment call data does not match the approved execution',
      );
      return;
    }
    if (
      execution.provider_transaction_id === null &&
      execution.attempt_status === 'UNKNOWN'
    ) {
      await this.stopUnknown(event);
      return;
    }
    if (execution.provider_transaction_id === null) {
      const blocked = await this.preflight(execution);
      if (blocked !== null) {
        await this.fail(event, execution.attempt_id, blocked);
        return;
      }
    }
    const request: SignerRequest = {
      provider: 'circle',
      chainId: execution.route_chain_id,
      from: execution.wallet_address,
      to: contractAddress,
      data: callData,
      value: '0',
      idempotencyKey: execution.id,
      executionId: execution.id,
    };
    assertSignerRequest(execution, request, callData);

    let attemptId = execution.attempt_id;
    let providerTransactionId = execution.provider_transaction_id;
    if (attemptId === null)
      attemptId = await this.recordPreparedAttempt(execution, request);

    if (providerTransactionId === null) {
      if (!this.circle.isConfigured()) {
        await this.fail(event, attemptId, 'Circle wallets are not configured');
        return;
      }
      try {
        const submitted =
          execution.execution_mode === 'CROSSCHAIN_WALLET'
            ? await this.circle.createCallDataTransaction({
                walletId: execution.wallet_id,
                contractAddress,
                callData,
                idempotencyKey: execution.id,
              })
            : await this.circle.createDirectPaymentTransaction({
                walletId: execution.wallet_id,
                vaultAddress: contractAddress,
                callData,
                executionId: execution.id,
              });
        providerTransactionId = submitted.id;
        await this.recordProviderSubmission(event, attemptId, submitted.id);
      } catch (error) {
        const reason = circleErrorMessage(
          error,
          'Circle payment submission failed',
        );
        if (submissionMayHaveSucceeded(error))
          await this.markSubmissionUnknown(event, attemptId, reason);
        else await this.fail(event, attemptId, reason);
        return;
      }
    }

    try {
      const transaction = (await this.circle.getTransaction(
        providerTransactionId,
      )) as CircleTransactionEvidence;
      assertCircleTransaction(execution, transaction);
      if (TERMINAL_CIRCLE_FAILURES.has(transaction.state)) {
        await this.fail(
          event,
          attemptId,
          transaction.errorDetails ??
            transaction.errorReason ??
            `Circle transaction ${transaction.state}`,
        );
        return;
      }
      if (!transaction.txHash) {
        await this.retry(
          event,
          attemptId,
          `Circle transaction is ${transaction.state}`,
        );
        return;
      }

      const transactionHash = requireTransactionHash(transaction.txHash);
      const [chainTransaction, receipt] = await Promise.all([
        rpc<RpcTransaction | null>(
          execution.route_environment,
          'eth_getTransactionByHash',
          [transactionHash],
        ),
        rpc<RpcReceipt | null>(
          execution.route_environment,
          'eth_getTransactionReceipt',
          [transactionHash],
        ),
      ]);
      if (chainTransaction === null || receipt === null) {
        await this.retry(
          event,
          attemptId,
          'Payment transaction is not yet final',
        );
        return;
      }
      verifyChainEvidence(
        execution,
        callData,
        transactionHash,
        chainTransaction,
        receipt,
        execution.execution_mode === 'CROSSCHAIN_WALLET'
          ? contractAddress
          : this.factoryManifests.getArcTestnetFactory().tokenAddress,
      );
      await this.confirm(event, attemptId, transactionHash);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : 'Payment reconciliation failed';
      if (isTransient(error)) await this.retry(event, attemptId, reason);
      else await this.fail(event, attemptId, reason);
    }
  }

  private async prepareExecution(
    event: OutboxEventRow,
  ): Promise<ExecutionWorkRow | null> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<
        Omit<
          ExecutionWorkRow,
          | 'attempt_id'
          | 'attempt_status'
          | 'provider_transaction_id'
          | 'call_data'
        >
      >(
        `UPDATE opes.payment_executions AS execution
            SET status = CASE WHEN execution.status = 'PENDING' THEN 'PROCESSING' ELSE execution.status END,
                failure_reason = NULL, updated_at = now()
           FROM opes.tenant_resource_bindings AS wallet
          WHERE execution.organization_id = $1 AND execution.id = $2
            AND execution.status IN ('PENDING', 'PROCESSING', 'SUBMITTED', 'UNKNOWN')
            AND wallet.organization_id = execution.organization_id
            AND wallet.provider = 'circle' AND wallet.environment = execution.route_environment
            AND wallet.resource_type = 'operator_wallet' AND wallet.status = 'ACTIVE'
          RETURNING execution.id, execution.organization_id, execution.decision_hash,
            execution.idempotency_key, execution.context_hash, execution.amount_atomic::text AS amount_atomic,
            execution.destination_address, execution.route_chain_id, execution.route_environment,
            execution.route_asset_symbol, execution.vault_address, execution.expires_at,
            execution.execution_mode, execution.token_address, execution.liquidity_action_id,
            wallet.resource_id AS wallet_id,
            wallet.address AS wallet_address`,
        [event.organization_id, event.aggregate_id],
      );
      const row = result.rows[0];
      if (row === undefined) {
        const pending = await database.query<{ id: string }>(
          `SELECT id FROM opes.payment_executions WHERE organization_id = $1 AND id = $2
             AND status IN ('PENDING', 'PROCESSING', 'SUBMITTED', 'UNKNOWN') LIMIT 1`,
          [event.organization_id, event.aggregate_id],
        );
        if (pending.rows[0]) {
          return {
            id: event.aggregate_id,
            organization_id: event.organization_id,
            decision_hash: `0x${'0'.repeat(64)}`,
            idempotency_key: '0'.repeat(64),
            context_hash: '0'.repeat(64),
            amount_atomic: '1',
            destination_address: '0x0000000000000000000000000000000000000000',
            route_chain_id: 5042002,
            route_environment: 'arc-testnet',
            route_asset_symbol: 'USDC',
            vault_address: '0x0000000000000000000000000000000000000000',
            execution_mode: 'DIRECT_VAULT',
            token_address: null,
            liquidity_action_id: null,
            expires_at: null,
            wallet_id: null,
            wallet_address: null,
            attempt_id: null,
            attempt_status: null,
            provider_transaction_id: null,
            call_data: null,
          };
        }
        await markOutboxProcessed(database, event.id);
        return null;
      }
      const attempt = await database.query<{
        id: string;
        status: string;
        provider_transaction_id: string | null;
        call_data: string;
      }>(
        `SELECT id, status, provider_transaction_id, call_data FROM opes.payment_execution_attempts
          WHERE organization_id = $1 AND execution_id = $2 ORDER BY attempt_number DESC LIMIT 1`,
        [event.organization_id, event.aggregate_id],
      );
      return {
        ...row,
        attempt_id: attempt.rows[0]?.id ?? null,
        attempt_status: attempt.rows[0]?.status ?? null,
        provider_transaction_id:
          attempt.rows[0]?.provider_transaction_id ?? null,
        call_data: attempt.rows[0]?.call_data ?? null,
      };
    });
  }

  private async preflight(execution: ExecutionWorkRow): Promise<string | null> {
    return this.database.withWorker(async (database) => {
      await database.query(
        "SELECT set_config('opes.organization_id',$1,true)",
        [execution.organization_id],
      );
      await database.query(
        `SELECT organization_id FROM opes.treasury_settings
         WHERE organization_id=$1 FOR UPDATE`,
        [execution.organization_id],
      );
      const state = (
        await database.query<PreflightStateRow>(
          `SELECT decision.derived_action,decision.expires_at AS decision_expires_at,
             policy.status AS policy_status,organization.lifecycle_status AS organization_status,
             agent.lifecycle_status AS agent_status,vendor.status AS vendor_status,
             vendor.version AS vendor_version,decision.bound_vendor_version,
             address.status AS address_status,address.version AS address_version,
             decision.bound_address_version,address.payout_address,
             source.status AS source_status,obligation.status AS obligation_status,
             EXISTS(SELECT 1 FROM opes.payable_evidence_matches match
               WHERE match.organization_id=decision.organization_id
                 AND match.invoice_version_id=decision.source_version_id
                 AND match.status='PASS') AS has_evidence_match,
             reservation.status AS reservation_status,
             EXISTS(SELECT 1 FROM opes.payment_decision_approvals approval
               WHERE approval.organization_id=decision.organization_id
                 AND approval.decision_id=decision.id AND approval.status='ACTIVE'
                 AND approval.expires_at>now()) AS has_active_approval,
             policy.single_payment_limit_atomic::text,
             policy.vendor_daily_limit_atomic::text,
             policy.organization_daily_limit_atomic::text,
             policy.monthly_budget_atomic::text,policy.operating_buffer_atomic::text,
             COALESCE((SELECT sum(other.amount_atomic) FROM opes.payment_executions other
               JOIN opes.payment_decisions other_decision
                 ON other_decision.organization_id=other.organization_id
                AND other_decision.id=other.decision_id
               WHERE other.organization_id=execution.organization_id
                 AND other_decision.vendor_id=decision.vendor_id
                 AND other.status IN ('PENDING','PROCESSING','SUBMITTED','UNKNOWN','CONFIRMED')
                 AND other.requested_at>=date_trunc('day',now())),0)::text AS vendor_daily_committed_atomic,
             COALESCE((SELECT sum(other.amount_atomic) FROM opes.payment_executions other
               WHERE other.organization_id=execution.organization_id
                 AND other.status IN ('PENDING','PROCESSING','SUBMITTED','UNKNOWN','CONFIRMED')
                 AND other.requested_at>=date_trunc('day',now())),0)::text AS organization_daily_committed_atomic,
             COALESCE((SELECT sum(other.amount_atomic) FROM opes.payment_executions other
               WHERE other.organization_id=execution.organization_id
                 AND other.status IN ('PENDING','PROCESSING','SUBMITTED','UNKNOWN','CONFIRMED')
                 AND other.requested_at>=date_trunc('month',now())),0)::text AS monthly_committed_atomic,
             EXISTS(SELECT 1 FROM opes.payment_executions other
               WHERE other.organization_id=execution.organization_id
                 AND other.source_version_id=execution.source_version_id
                 AND other.id<>execution.id
                 AND other.status IN ('PENDING','PROCESSING','SUBMITTED','UNKNOWN','CONFIRMED')) AS duplicate_execution,
             execution.max_source_debit_atomic::text
           FROM opes.payment_executions execution
           JOIN opes.payment_decisions decision
             ON decision.organization_id=execution.organization_id AND decision.id=execution.decision_id
           JOIN opes.payment_policy_versions policy
             ON policy.organization_id=decision.organization_id AND policy.id=decision.policy_version_id
           JOIN opes.organizations organization ON organization.id=execution.organization_id
           JOIN opes.business_agents agent ON agent.organization_id=execution.organization_id AND agent.is_primary
           JOIN opes.vendors vendor ON vendor.organization_id=decision.organization_id AND vendor.id=decision.vendor_id
           JOIN opes.vendor_payout_addresses address ON address.organization_id=decision.organization_id AND address.id=decision.vendor_address_id
           JOIN opes.payable_obligation_versions source ON source.organization_id=decision.organization_id AND source.id=decision.source_version_id
           JOIN opes.payable_obligations obligation ON obligation.organization_id=decision.organization_id AND obligation.id=decision.source_id
           LEFT JOIN opes.treasury_reservations reservation ON reservation.organization_id=decision.organization_id AND reservation.decision_id=decision.id
           WHERE execution.organization_id=$1 AND execution.id=$2 FOR UPDATE OF execution`,
          [execution.organization_id, execution.id],
        )
      ).rows[0];
      if (!state) return 'Execution preflight state is missing';

      const token =
        execution.execution_mode === 'DIRECT_VAULT'
          ? this.factoryManifests.getArcTestnetFactory().tokenAddress
          : execution.token_address;
      const sourceAddress =
        execution.execution_mode === 'DIRECT_VAULT'
          ? execution.vault_address
          : execution.wallet_address;
      if (!token || !sourceAddress || !execution.wallet_address)
        return 'Execution preflight binding is missing';
      const blockHex = await rpc<string>(
        execution.route_environment,
        'eth_blockNumber',
        [],
      );
      const [balanceHex, nonceHex, pausedHex] = await Promise.all([
        rpc<string>(execution.route_environment, 'eth_call', [
          { to: token, data: balanceOfCalldata(sourceAddress) },
          blockHex,
        ]),
        rpc<string>(execution.route_environment, 'eth_getTransactionCount', [
          execution.wallet_address,
          'pending',
        ]),
        execution.execution_mode === 'DIRECT_VAULT'
          ? rpc<string>(execution.route_environment, 'eth_call', [
              { to: execution.vault_address, data: '0x5c975abb' },
              blockHex,
            ])
          : Promise.resolve('0x0'),
      ]);
      const balance = BigInt(balanceHex);
      const required = BigInt(
        state.max_source_debit_atomic ?? execution.amount_atomic,
      );
      const checks = [
        preflightCheck('policy_current', state.policy_status === 'ACTIVE'),
        preflightCheck(
          'organization_active',
          state.organization_status === 'ACTIVE' &&
            state.agent_status === 'ACTIVE',
        ),
        preflightCheck(
          'vendor_current',
          state.vendor_status === 'VERIFIED' &&
            state.vendor_version === state.bound_vendor_version,
        ),
        preflightCheck(
          'address_current',
          state.address_status === 'VERIFIED_ACTIVE' &&
            state.address_version === state.bound_address_version &&
            state.payout_address.toLowerCase() ===
              execution.destination_address.toLowerCase(),
        ),
        preflightCheck(
          'evidence_current',
          state.source_status === 'ACCEPTED' &&
            state.obligation_status === 'ACCEPTED' &&
            state.has_evidence_match,
        ),
        preflightCheck(
          'reservation_consumed',
          state.reservation_status === 'CONSUMED',
        ),
        preflightCheck(
          'approval_current',
          state.derived_action === 'PAY' || state.has_active_approval,
        ),
        preflightCheck(
          'decision_unexpired',
          state.decision_expires_at.getTime() > Date.now(),
        ),
        preflightCheck(
          'single_limit',
          BigInt(execution.amount_atomic) <=
            BigInt(state.single_payment_limit_atomic),
        ),
        preflightCheck(
          'vendor_daily_limit',
          BigInt(state.vendor_daily_committed_atomic) <=
            BigInt(state.vendor_daily_limit_atomic),
        ),
        preflightCheck(
          'organization_daily_limit',
          BigInt(state.organization_daily_committed_atomic) <=
            BigInt(state.organization_daily_limit_atomic),
        ),
        preflightCheck(
          'monthly_budget',
          state.monthly_budget_atomic === null ||
            BigInt(state.monthly_committed_atomic) <=
              BigInt(state.monthly_budget_atomic),
        ),
        preflightCheck(
          'live_balance_and_buffer',
          balance >= required + BigInt(state.operating_buffer_atomic),
        ),
        preflightCheck('vault_unpaused', BigInt(pausedHex) === 0n),
        preflightCheck('idempotency_clear', !state.duplicate_execution),
        preflightCheck('pending_nonce_observed', BigInt(nonceHex) >= 0n),
      ];
      const status = checks.some((check) => check.status === 'BLOCK')
        ? 'BLOCK'
        : 'PASS';
      await database.query(
        `INSERT INTO opes.payment_execution_preflights
          (organization_id,execution_id,status,checks,observed_block_number,
           observed_balance_atomic,observed_pending_nonce)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
         ON CONFLICT(organization_id,execution_id) DO NOTHING`,
        [
          execution.organization_id,
          execution.id,
          status,
          JSON.stringify(checks),
          BigInt(blockHex).toString(),
          balance.toString(),
          BigInt(nonceHex).toString(),
        ],
      );
      const firstBlock = checks.find((check) => check.status === 'BLOCK');
      return firstBlock
        ? `Execution preflight blocked: ${firstBlock.code}`
        : null;
    });
  }

  private async recordPreparedAttempt(
    execution: ExecutionWorkRow,
    request: SignerRequest,
  ): Promise<string> {
    const requestHash = hashStable(request);
    return this.database.withWorker(async (database) => {
      const result = await database.query<{ id: string }>(
        `INSERT INTO opes.payment_execution_attempts (
           organization_id, execution_id, attempt_number, provider, chain_id, to_address, call_data, request_hash
         ) VALUES ($1, $2, (
           SELECT COALESCE(MAX(attempt_number), 0) + 1
             FROM opes.payment_execution_attempts
            WHERE organization_id = $1 AND execution_id = $2
         ), $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, execution_id, request_hash)
         DO UPDATE SET updated_at = opes.payment_execution_attempts.updated_at RETURNING id`,
        [
          execution.organization_id,
          execution.id,
          request.provider,
          request.chainId,
          request.to,
          request.data,
          requestHash,
        ],
      );
      if (!result.rows[0])
        throw new Error('Expected payment execution attempt row');
      return result.rows[0].id;
    });
  }

  private async recordProviderSubmission(
    event: OutboxEventRow,
    attemptId: string,
    providerId: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `UPDATE opes.payment_execution_attempts SET status = 'SUBMITTED', provider_transaction_id = $3,
           failure_reason = NULL, updated_at = now() WHERE organization_id = $1 AND id = $2`,
        [event.organization_id, attemptId, providerId],
      );
      await database.query(
        `UPDATE opes.payment_executions AS execution SET status = 'SUBMITTED', call_data = attempt.call_data,
           submitted_at = COALESCE(execution.submitted_at, now()), failure_reason = NULL, updated_at = now()
         FROM opes.payment_execution_attempts AS attempt
         WHERE execution.organization_id = $1 AND execution.id = $2
           AND attempt.organization_id = execution.organization_id AND attempt.id = $3`,
        [event.organization_id, event.aggregate_id, attemptId],
      );
      await requeueOutbox(database, event.id);
    });
  }

  private async retry(
    event: OutboxEventRow,
    attemptId: string,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `UPDATE opes.payment_execution_attempts SET failure_reason = $3, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [event.organization_id, attemptId, reason],
      );
      await database.query(
        `UPDATE opes.payment_executions SET failure_reason = $3, last_reconciled_at = now(), updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [event.organization_id, event.aggregate_id, reason],
      );
      await requeueOutbox(database, event.id);
    });
  }

  private async markSubmissionUnknown(
    event: OutboxEventRow,
    attemptId: string,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `UPDATE opes.payment_execution_attempts
         SET status='UNKNOWN',failure_reason=$3,updated_at=now()
         WHERE organization_id=$1 AND id=$2`,
        [event.organization_id, attemptId, reason],
      );
      await database.query(
        `UPDATE opes.payment_executions
         SET status='UNKNOWN',failure_reason=$3,last_reconciled_at=now(),updated_at=now()
         WHERE organization_id=$1 AND id=$2`,
        [event.organization_id, event.aggregate_id, reason],
      );
      await markOutboxProcessed(database, event.id);
    });
  }

  private async stopUnknown(event: OutboxEventRow): Promise<void> {
    await this.database.withWorker((database) =>
      markOutboxProcessed(database, event.id),
    );
  }

  private async confirm(
    event: OutboxEventRow,
    attemptId: string,
    transactionHash: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        "SELECT set_config('opes.organization_id', $1, true)",
        [event.organization_id],
      );
      await database.query(
        `UPDATE opes.payment_execution_attempts SET status = 'CONFIRMED', transaction_hash = $3,
           failure_reason = NULL, updated_at = now() WHERE organization_id = $1 AND id = $2`,
        [event.organization_id, attemptId, transactionHash],
      );
      await database.query(
        `UPDATE opes.payment_executions SET status = 'CONFIRMED', transaction_hash = $3,
           failure_reason = NULL, confirmed_at = now(), last_reconciled_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [event.organization_id, event.aggregate_id, transactionHash],
      );
      await projectPaymentSettlementInDatabase(
        database,
        event.organization_id,
        event.aggregate_id,
      );
      await recordPaymentSettlementCommunications(
        database,
        event.organization_id,
        event.aggregate_id,
      );
      await markOutboxProcessed(database, event.id);
    });
  }

  private async fail(
    event: OutboxEventRow,
    attemptId: string | null,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      if (attemptId)
        await database.query(
          `UPDATE opes.payment_execution_attempts SET status = 'FAILED', failure_reason = $3, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
          [event.organization_id, attemptId, reason],
        );
      await database.query(
        `UPDATE opes.payment_executions SET status = 'FAILED', failure_reason = $3, updated_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [event.organization_id, event.aggregate_id, reason],
      );
      await recordNotification(database, {
        organizationId: event.organization_id,
        type: 'PAYMENT_FAILED',
        priority: 'WARNING',
        title: 'Payment execution failed',
        body: reason.slice(0, 500),
        subjectType: 'payment_execution',
        subjectId: event.aggregate_id,
        actionView: 'invoices',
        dedupeKey: `payment-failed:${event.aggregate_id}`,
      });
      await markOutboxFailed(database, event.id, reason);
    });
    this.logger.warn(`payment execution job ${event.id} failed: ${reason}`);
  }
}

function preflightCheck(code: string, passes: boolean) {
  return { code, status: passes ? ('PASS' as const) : ('BLOCK' as const) };
}

function circleErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const response = (error as { error?: { response?: { data?: unknown } } })
    .error?.response?.data;
  const detail =
    response !== null && typeof response === 'object' && 'data' in response
      ? (response as { data?: unknown }).data
      : response;
  const provider =
    detail !== null && typeof detail === 'object'
      ? (detail as { code?: unknown; message?: unknown })
      : undefined;
  const code = provider?.code ?? (error as { code?: unknown }).code;
  const message =
    typeof provider?.message === 'string' ? provider.message : error.message;
  return typeof code === 'number' && code !== 400
    ? `${message} (Circle code ${code})`
    : message;
}

function balanceOfCalldata(address: string): string {
  return `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function assertSignerRequest(
  execution: ExecutionWorkRow,
  request: SignerRequest,
  callData: string,
): void {
  const expectedContract =
    execution.execution_mode === 'CROSSCHAIN_WALLET'
      ? execution.token_address
      : execution.vault_address;
  if (
    request.provider !== 'circle' ||
    request.chainId !== execution.route_chain_id ||
    execution.route_asset_symbol !== 'USDC' ||
    expectedContract === null ||
    request.to.toLowerCase() !== expectedContract.toLowerCase() ||
    request.data !== callData ||
    request.value !== '0' ||
    request.executionId !== execution.id ||
    request.idempotencyKey !== execution.id ||
    !isEvmAddress(request.from)
  )
    throw new Error('Payment signer request violates execution policy');
}

function assertCircleTransaction(
  execution: ExecutionWorkRow,
  transaction: CircleTransactionEvidence,
): void {
  const expectedBlockchain =
    execution.route_environment === 'base-sepolia'
      ? 'BASE-SEPOLIA'
      : 'ARC-TESTNET';
  const expectedContract =
    execution.execution_mode === 'CROSSCHAIN_WALLET'
      ? execution.token_address
      : execution.vault_address;
  if (
    transaction.blockchain !== expectedBlockchain ||
    transaction.walletId !== execution.wallet_id ||
    transaction.sourceAddress?.toLowerCase() !==
      execution.wallet_address?.toLowerCase() ||
    expectedContract === null ||
    transaction.contractAddress?.toLowerCase() !==
      expectedContract.toLowerCase()
  ) {
    throw new Error('Circle transaction does not match the authorized payment');
  }
}

function verifyChainEvidence(
  execution: ExecutionWorkRow,
  callData: string,
  transactionHash: string,
  transaction: RpcTransaction,
  receipt: RpcReceipt,
  tokenAddress: string,
): void {
  const expectedContract =
    execution.execution_mode === 'CROSSCHAIN_WALLET'
      ? execution.token_address
      : execution.vault_address;
  if (
    receipt.status !== '0x1' ||
    receipt.transactionHash.toLowerCase() !== transactionHash ||
    transaction.from.toLowerCase() !==
      execution.wallet_address?.toLowerCase() ||
    expectedContract === null ||
    transaction.to?.toLowerCase() !== expectedContract.toLowerCase() ||
    transaction.input.toLowerCase() !== callData.toLowerCase()
  ) {
    throw new Error(
      'Payment transaction does not match the authorized payment',
    );
  }
  const vendorTopic = addressTopic(execution.destination_address);
  if (execution.execution_mode === 'CROSSCHAIN_WALLET') {
    const transfer = receipt.logs.find(
      (log) =>
        log.address.toLowerCase() === tokenAddress.toLowerCase() &&
        log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        log.topics[1]?.toLowerCase() ===
          addressTopic(execution.wallet_address ?? '') &&
        log.topics[2]?.toLowerCase() === vendorTopic &&
        decodeAmount(log.data) === BigInt(execution.amount_atomic),
    );
    if (!transfer)
      throw new Error(
        'Destination USDC transfer does not match the authorized payment',
      );
    return;
  }
  if (execution.vault_address === null)
    throw new Error('Payment vault is missing');
  const vaultAddress = execution.vault_address;
  const payment = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === vaultAddress.toLowerCase() &&
      log.topics[0]?.toLowerCase() === PAYMENT_EXECUTED_TOPIC &&
      log.topics[1]?.toLowerCase() === execution.decision_hash.toLowerCase() &&
      log.topics[2]?.toLowerCase() ===
        `0x${execution.idempotency_key.toLowerCase()}` &&
      log.topics[3]?.toLowerCase() === vendorTopic,
  );
  const paymentWords = decodeWords(payment?.data);
  if (
    paymentWords.length !== 2 ||
    BigInt(`0x${paymentWords[0]}`) !== BigInt(execution.amount_atomic) ||
    `0x${paymentWords[1].slice(24)}` !== execution.wallet_address?.toLowerCase()
  ) {
    throw new Error(
      'Arc PaymentExecuted event does not match the authorized payment',
    );
  }
  const transfer = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === tokenAddress.toLowerCase() &&
      log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      log.topics[1]?.toLowerCase() === addressTopic(vaultAddress) &&
      log.topics[2]?.toLowerCase() === vendorTopic &&
      decodeAmount(log.data) === BigInt(execution.amount_atomic),
  );
  if (!transfer)
    throw new Error('Arc USDC transfer does not match the authorized payment');
}

function decodeWords(value: string | undefined): string[] {
  if (!value || !/^0x(?:[0-9a-fA-F]{64})*$/.test(value)) return [];
  return (
    value
      .slice(2)
      .match(/.{64}/g)
      ?.map((word) => word.toLowerCase()) ?? []
  );
}
function decodeAmount(value: string): bigint | undefined {
  const words = decodeWords(value);
  return words.length === 1 ? BigInt(`0x${words[0]}`) : undefined;
}
function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}
function eventTopic(signature: string): string {
  return `0x${Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString('hex')}`;
}
function requireTransactionHash(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error('Circle returned an invalid transaction hash');
  return value.toLowerCase();
}

async function rpc<T>(
  environment: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const name = `OPES_RPC_${environment.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const url = process.env[name]?.trim();
  if (!url) throw new Error(`${name} is not configured`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new TransientError(`Chain RPC returned HTTP ${response.status}`);
  const body = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (body.error)
    throw new TransientError(
      `Chain RPC failed: ${body.error.message ?? 'unknown error'}`,
    );
  if (body.result === undefined)
    throw new TransientError('Chain RPC returned no result');
  return body.result;
}
class TransientError extends Error {}
function isTransient(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    response?: { status?: number };
  };
  const status = candidate.status ?? candidate.response?.status;
  return (
    error instanceof TransientError ||
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === 'TimeoutError') ||
    status === 404 ||
    (status !== undefined && status >= 500)
  );
}
function submissionMayHaveSucceeded(error: unknown): boolean {
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === 'TimeoutError')
  )
    return true;
  const candidate = error as {
    status?: number;
    response?: { status?: number };
  };
  const status = candidate.status ?? candidate.response?.status;
  return status === undefined || status >= 500;
}
function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}
async function requeueOutbox(
  database: TenantDatabase,
  eventId: string,
): Promise<void> {
  await database.query(
    `UPDATE opes.outbox_events SET status = 'PENDING', available_at = now() + interval '5 seconds',
    updated_at = now() WHERE id = $1`,
    [eventId],
  );
}
async function markOutboxProcessed(
  database: TenantDatabase,
  eventId: string,
): Promise<void> {
  await database.query(
    `UPDATE opes.outbox_events SET status = 'PROCESSED', processed_at = now(), updated_at = now()
    WHERE id = $1`,
    [eventId],
  );
}
async function markOutboxFailed(
  database: TenantDatabase,
  eventId: string,
  reason: string,
): Promise<void> {
  await database.query(
    `UPDATE opes.outbox_events SET status = 'FAILED',
    payload = payload || jsonb_build_object('failureReason', $2::text), processed_at = now(), updated_at = now()
    WHERE id = $1`,
    [eventId, reason],
  );
}
