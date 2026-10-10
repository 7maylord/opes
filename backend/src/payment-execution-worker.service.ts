import { Injectable, Logger } from '@nestjs/common';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createHash } from 'node:crypto';
import { CircleWalletService } from './circle-wallet.service';
import { DatabaseService, TenantDatabase } from './database.service';
import { buildExecuteDirectPaymentCalldata } from './evm-calldata';
import { isEvmAddress } from './evm-decision-hash';
import { FactoryManifestService } from './factory-manifest.service';
import { projectPaymentSettlementInDatabase } from './ledger.service';

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
  vault_address: string;
  expires_at: Date | null;
  wallet_id: string | null;
  wallet_address: string | null;
  attempt_id: string | null;
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
             WHERE event_type = 'payment.execute.direct.arc_testnet'
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

    const callData = buildExecuteDirectPaymentCalldata({
      decisionHash: execution.decision_hash,
      obligationKey: execution.idempotency_key,
      contextHash: execution.context_hash,
      idempotencyKey: execution.idempotency_key,
      vendor: execution.destination_address,
      amount: execution.amount_atomic,
      expiresAt: execution.expires_at.toISOString(),
    });
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
    const request: SignerRequest = {
      provider: 'circle',
      chainId: execution.route_chain_id,
      from: execution.wallet_address,
      to: execution.vault_address,
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
        const submitted = await this.circle.createDirectPaymentTransaction({
          walletId: execution.wallet_id,
          vaultAddress: execution.vault_address,
          callData,
          executionId: execution.id,
        });
        providerTransactionId = submitted.id;
        await this.recordProviderSubmission(event, attemptId, submitted.id);
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message
            : 'Circle payment submission failed';
        if (submissionMayHaveSucceeded(error))
          await this.retry(event, attemptId, reason);
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
        rpc<RpcTransaction | null>('eth_getTransactionByHash', [
          transactionHash,
        ]),
        rpc<RpcReceipt | null>('eth_getTransactionReceipt', [transactionHash]),
      ]);
      if (chainTransaction === null || receipt === null) {
        await this.retry(event, attemptId, 'Arc transaction is not yet final');
        return;
      }
      verifyChainEvidence(
        execution,
        callData,
        transactionHash,
        chainTransaction,
        receipt,
        this.factoryManifests.getArcTestnetFactory().tokenAddress,
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
          'attempt_id' | 'provider_transaction_id' | 'call_data'
        >
      >(
        `UPDATE opes.payment_executions AS execution
            SET status = CASE WHEN execution.status = 'PENDING' THEN 'PROCESSING' ELSE execution.status END,
                failure_reason = NULL, updated_at = now()
           FROM opes.tenant_resource_bindings AS wallet
          WHERE execution.organization_id = $1 AND execution.id = $2
            AND execution.status IN ('PENDING', 'PROCESSING', 'SUBMITTED', 'UNKNOWN')
            AND wallet.organization_id = execution.organization_id
            AND wallet.provider = 'circle' AND wallet.environment = 'arc-testnet'
            AND wallet.resource_type = 'operator_wallet' AND wallet.status = 'ACTIVE'
          RETURNING execution.id, execution.organization_id, execution.decision_hash,
            execution.idempotency_key, execution.context_hash, execution.amount_atomic::text AS amount_atomic,
            execution.destination_address, execution.route_chain_id, execution.route_environment,
            execution.route_asset_symbol, execution.vault_address, execution.expires_at,
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
            expires_at: null,
            wallet_id: null,
            wallet_address: null,
            attempt_id: null,
            provider_transaction_id: null,
            call_data: null,
          };
        }
        await markOutboxProcessed(database, event.id);
        return null;
      }
      const attempt = await database.query<{
        id: string;
        provider_transaction_id: string | null;
        call_data: string;
      }>(
        `SELECT id, provider_transaction_id, call_data FROM opes.payment_execution_attempts
          WHERE organization_id = $1 AND execution_id = $2 ORDER BY attempt_number DESC LIMIT 1`,
        [event.organization_id, event.aggregate_id],
      );
      return {
        ...row,
        attempt_id: attempt.rows[0]?.id ?? null,
        provider_transaction_id:
          attempt.rows[0]?.provider_transaction_id ?? null,
        call_data: attempt.rows[0]?.call_data ?? null,
      };
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

  private async confirm(
    event: OutboxEventRow,
    attemptId: string,
    transactionHash: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
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
      await markOutboxFailed(database, event.id, reason);
    });
    this.logger.warn(`payment execution job ${event.id} failed: ${reason}`);
  }
}

function assertSignerRequest(
  execution: ExecutionWorkRow,
  request: SignerRequest,
  callData: string,
): void {
  if (
    request.provider !== 'circle' ||
    request.chainId !== 5042002 ||
    request.chainId !== execution.route_chain_id ||
    execution.route_environment !== 'arc-testnet' ||
    execution.route_asset_symbol !== 'USDC' ||
    request.to.toLowerCase() !== execution.vault_address.toLowerCase() ||
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
  if (
    transaction.blockchain !== 'ARC-TESTNET' ||
    transaction.walletId !== execution.wallet_id ||
    transaction.sourceAddress?.toLowerCase() !==
      execution.wallet_address?.toLowerCase() ||
    transaction.contractAddress?.toLowerCase() !==
      execution.vault_address.toLowerCase()
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
  if (
    receipt.status !== '0x1' ||
    receipt.transactionHash.toLowerCase() !== transactionHash ||
    transaction.from.toLowerCase() !==
      execution.wallet_address?.toLowerCase() ||
    transaction.to?.toLowerCase() !== execution.vault_address.toLowerCase() ||
    transaction.input.toLowerCase() !== callData.toLowerCase()
  ) {
    throw new Error('Arc transaction does not match the authorized payment');
  }
  const vendorTopic = addressTopic(execution.destination_address);
  const payment = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === execution.vault_address.toLowerCase() &&
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
      log.topics[1]?.toLowerCase() === addressTopic(execution.vault_address) &&
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

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = process.env.OPES_RPC_ARC_TESTNET?.trim();
  if (!url) throw new Error('OPES_RPC_ARC_TESTNET is not configured');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new TransientError(`Arc RPC returned HTTP ${response.status}`);
  const body = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (body.error)
    throw new TransientError(
      `Arc RPC failed: ${body.error.message ?? 'unknown error'}`,
    );
  if (body.result === undefined)
    throw new TransientError('Arc RPC returned no result');
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
