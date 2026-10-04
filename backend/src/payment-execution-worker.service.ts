import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { buildExecuteDirectPaymentCalldata } from './evm-calldata';
import { isEvmAddress } from './evm-decision-hash';
import { DatabaseService, TenantDatabase } from './database.service';

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
  vault_address: string;
  expires_at: Date | null;
  wallet_address: string | null;
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

class SignerUnavailableError extends Error {}
class UnknownSubmissionError extends Error {}

@Injectable()
export class PaymentExecutionWorkerService {
  private readonly logger = new Logger(PaymentExecutionWorkerService.name);

  constructor(private readonly database: DatabaseService) {}

  async processDuePaymentExecutions(limit = 10): Promise<number> {
    let processed = 0;

    while (processed < limit) {
      const event = await this.claimNextPaymentExecutionEvent();
      if (event === undefined) {
        return processed;
      }

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
        `
          UPDATE opes.outbox_events
             SET status = 'PROCESSING',
                 updated_at = now()
           WHERE id = (
             SELECT id
               FROM opes.outbox_events
              WHERE event_type = 'payment.execute.direct.arc_testnet'
                AND (
                      (status = 'PENDING' AND available_at <= now())
                   OR (status = 'PROCESSING' AND updated_at < now() - interval '5 minutes')
                    )
              ORDER BY created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
           RETURNING id, organization_id, aggregate_id
        `,
      );

      return result.rows[0];
    });
  }

  private async processPaymentExecution(event: OutboxEventRow): Promise<void> {
    const execution = await this.prepareExecution(event);
    if (execution === null) {
      return;
    }

    if (!isEvmAddress(execution.wallet_address)) {
      await this.failPaymentExecution(
        event,
        'Active operator wallet binding is missing',
      );
      return;
    }
    if (execution.expires_at === null) {
      await this.failPaymentExecution(
        event,
        'Payment execution is missing expiry',
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
    const requestHash = hashStable(request);
    const attemptId = await this.recordPreparedAttempt(
      execution,
      request,
      requestHash,
    );

    try {
      const transactionHash = await submitSignerRequest(request);
      await this.recordSubmittedAttempt(event, attemptId, transactionHash);
    } catch (error) {
      if (error instanceof UnknownSubmissionError) {
        await this.recordUnknownAttempt(
          event,
          attemptId,
          'Payment signer submission status is unknown',
        );
        return;
      }

      const reason =
        error instanceof Error ? error.message : 'Payment signer failed';
      await this.recordFailedAttempt(event, attemptId, reason);
    }
  }

  private async prepareExecution(
    event: OutboxEventRow,
  ): Promise<ExecutionWorkRow | null> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<ExecutionWorkRow>(
        `
          UPDATE opes.payment_executions AS execution
             SET status = 'PROCESSING',
                 failure_reason = NULL,
                 updated_at = now()
            FROM opes.tenant_resource_bindings AS wallet
           WHERE execution.organization_id = $1
             AND execution.id = $2
             AND (
                   execution.status = 'PENDING'
                OR (execution.status = 'PROCESSING' AND execution.updated_at < now() - interval '5 minutes')
             )
             AND wallet.organization_id = execution.organization_id
             AND wallet.provider = 'circle'
             AND wallet.environment = 'arc-testnet'
             AND wallet.resource_type = 'operator_wallet'
             AND wallet.status = 'ACTIVE'
           RETURNING
             execution.id,
             execution.organization_id,
             execution.decision_hash,
             execution.idempotency_key,
             execution.context_hash,
             execution.amount_atomic::text AS amount_atomic,
             execution.destination_address,
             execution.route_chain_id,
             execution.vault_address,
             execution.expires_at,
             wallet.address AS wallet_address
        `,
        [event.organization_id, event.aggregate_id],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return row;
      }

      const missingWallet = await database.query<{ id: string }>(
        `
          SELECT id
            FROM opes.payment_executions
           WHERE organization_id = $1
             AND id = $2
             AND status = 'PENDING'
           LIMIT 1
        `,
        [event.organization_id, event.aggregate_id],
      );
      if (missingWallet.rows[0] !== undefined) {
        return {
          id: event.aggregate_id,
          organization_id: event.organization_id,
          decision_hash: `0x${'0'.repeat(64)}`,
          idempotency_key: '0'.repeat(64),
          context_hash: '0'.repeat(64),
          amount_atomic: '1',
          destination_address: '0x0000000000000000000000000000000000000000',
          route_chain_id: 5042002,
          vault_address: '0x0000000000000000000000000000000000000000',
          expires_at: null,
          wallet_address: null,
        };
      }

      await markOutboxProcessed(database, event.id);
      return null;
    });
  }

  private async recordPreparedAttempt(
    execution: ExecutionWorkRow,
    request: SignerRequest,
    requestHash: string,
  ): Promise<string> {
    const result = await this.database.withWorker((database) =>
      database.query<{ id: string }>(
        `
          INSERT INTO opes.payment_execution_attempts (
            organization_id,
            execution_id,
            attempt_number,
            provider,
            chain_id,
            to_address,
            call_data,
            request_hash
          )
          VALUES (
            $1,
            $2,
            (
              SELECT COALESCE(MAX(attempt_number), 0) + 1
                FROM opes.payment_execution_attempts
               WHERE organization_id = $1
                 AND execution_id = $2
            ),
            $3,
            $4,
            $5,
            $6,
            $7
          )
          RETURNING id
        `,
        [
          execution.organization_id,
          execution.id,
          request.provider,
          request.chainId,
          request.to,
          request.data,
          requestHash,
        ],
      ),
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('Expected payment execution attempt row');
    }
    return row.id;
  }

  private async recordSubmittedAttempt(
    event: OutboxEventRow,
    attemptId: string,
    transactionHash: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.payment_execution_attempts
             SET status = 'SUBMITTED',
                 transaction_hash = $3,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, attemptId, transactionHash],
      );
      await database.query(
        `
          UPDATE opes.payment_executions
             SET status = 'SUBMITTED',
                 call_data = attempt.call_data,
                 transaction_hash = $3,
                 submitted_at = now(),
                 updated_at = now()
            FROM opes.payment_execution_attempts AS attempt
           WHERE opes.payment_executions.organization_id = $1
             AND opes.payment_executions.id = $2
             AND attempt.organization_id = opes.payment_executions.organization_id
             AND attempt.id = $4
        `,
        [event.organization_id, event.aggregate_id, transactionHash, attemptId],
      );
      await markOutboxProcessed(database, event.id);
    });
  }

  private async recordUnknownAttempt(
    event: OutboxEventRow,
    attemptId: string,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.payment_execution_attempts
             SET status = 'UNKNOWN',
                 failure_reason = $3,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, attemptId, reason],
      );
      await database.query(
        `
          UPDATE opes.payment_executions
             SET status = 'UNKNOWN',
                 call_data = attempt.call_data,
                 failure_reason = $3,
                 updated_at = now()
            FROM opes.payment_execution_attempts AS attempt
           WHERE opes.payment_executions.organization_id = $1
             AND opes.payment_executions.id = $2
             AND attempt.organization_id = opes.payment_executions.organization_id
             AND attempt.id = $4
        `,
        [event.organization_id, event.aggregate_id, reason, attemptId],
      );
      await markOutboxFailed(database, event.id, reason);
    });
  }

  private async recordFailedAttempt(
    event: OutboxEventRow,
    attemptId: string,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.payment_execution_attempts
             SET status = 'FAILED',
                 failure_reason = $3,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, attemptId, reason],
      );
      await database.query(
        `
          UPDATE opes.payment_executions
             SET status = 'FAILED',
                 failure_reason = $3,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, event.aggregate_id, reason],
      );
      await markOutboxFailed(database, event.id, reason);
    });

    this.logger.warn(`payment execution job ${event.id} failed: ${reason}`);
  }

  private async failPaymentExecution(
    event: OutboxEventRow,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.payment_executions
             SET status = 'FAILED',
                 failure_reason = $3,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
             AND status IN ('PENDING', 'PROCESSING', 'FAILED')
        `,
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
    request.to.toLowerCase() !== execution.vault_address.toLowerCase() ||
    request.data !== callData ||
    request.value !== '0' ||
    request.executionId !== execution.id ||
    request.idempotencyKey !== execution.id ||
    !isEvmAddress(request.from)
  ) {
    throw new Error('Payment signer request violates execution policy');
  }
}

async function submitSignerRequest(request: SignerRequest): Promise<string> {
  const url = process.env.OPES_PAYMENT_SIGNER_URL;
  if (url === undefined || url.trim() === '') {
    throw new SignerUnavailableError(
      'Payment signer adapter is not configured',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.OPES_PAYMENT_SIGNER_TOKEN === undefined
          ? {}
          : {
              authorization: `Bearer ${process.env.OPES_PAYMENT_SIGNER_TOKEN}`,
            }),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Payment signer returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as { transactionHash?: unknown };
    if (
      typeof body.transactionHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(body.transactionHash)
    ) {
      throw new Error('Payment signer returned an invalid transaction hash');
    }
    return body.transactionHash.toLowerCase();
  } catch (error) {
    if (error instanceof SignerUnavailableError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new UnknownSubmissionError('Payment signer request timed out');
    }
    if (error instanceof TypeError) {
      throw new UnknownSubmissionError('Payment signer submission is unknown');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function markOutboxProcessed(
  database: TenantDatabase,
  eventId: string,
): Promise<void> {
  await database.query(
    `
      UPDATE opes.outbox_events
         SET status = 'PROCESSED',
             processed_at = now(),
             updated_at = now()
       WHERE id = $1
    `,
    [eventId],
  );
}

async function markOutboxFailed(
  database: TenantDatabase,
  eventId: string,
  reason: string,
): Promise<void> {
  await database.query(
    `
      UPDATE opes.outbox_events
         SET status = 'FAILED',
             payload = payload || jsonb_build_object('failureReason', $2::text),
             processed_at = now(),
             updated_at = now()
       WHERE id = $1
    `,
    [eventId, reason],
  );
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
