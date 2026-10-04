import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { isEvmAddress } from './evm-decision-hash';

interface OutboxEventRow {
  id: string;
  organization_id: string;
  aggregate_id: string;
}

interface LiquidityWorkRow {
  id: string;
  organization_id: string;
  source_chain_id: number;
  provider_payload: Record<string, unknown>;
}

interface SignerRequest {
  provider: 'circle';
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: '0';
  idempotencyKey: string;
  liquidityActionId: string;
}

class SignerUnavailableError extends Error {}
class UnknownSubmissionError extends Error {}

@Injectable()
export class LiquidityExecutionWorkerService {
  private readonly logger = new Logger(LiquidityExecutionWorkerService.name);

  constructor(private readonly database: DatabaseService) {}

  async processDueLiquidityActions(limit = 10): Promise<number> {
    let processed = 0;

    while (processed < limit) {
      const event = await this.claimNextLiquidityActionEvent();
      if (event === undefined) {
        return processed;
      }

      await this.processLiquidityAction(event);
      processed += 1;
    }

    return processed;
  }

  private async claimNextLiquidityActionEvent(): Promise<
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
              WHERE event_type = 'liquidity.execute.cctp'
                AND status = 'PENDING'
                AND available_at <= now()
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

  private async processLiquidityAction(event: OutboxEventRow): Promise<void> {
    const action = await this.prepareLiquidityAction(event);
    if (action === null) {
      return;
    }

    let request: SignerRequest;
    try {
      request = buildSignerRequest(action);
    } catch (error) {
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'Liquidity action is invalid',
      );
      return;
    }

    try {
      const transactionHash = await submitSignerRequest(request);
      await this.recordSubmitted(event, transactionHash);
    } catch (error) {
      if (error instanceof UnknownSubmissionError) {
        await this.recordUnknown(
          event,
          'Liquidity signer submission is unknown',
        );
        return;
      }
      await this.failLiquidityAction(
        event,
        error instanceof Error ? error.message : 'Liquidity signer failed',
      );
    }
  }

  private async prepareLiquidityAction(
    event: OutboxEventRow,
  ): Promise<LiquidityWorkRow | null> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<LiquidityWorkRow>(
        `
          UPDATE opes.liquidity_actions
             SET status = 'PLANNED',
                 failure_reason = NULL,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
             AND action_type = 'CCTP_TRANSFER'
             AND status = 'PLANNED'
           RETURNING
             id,
             organization_id,
             source_chain_id,
             provider_payload
        `,
        [event.organization_id, event.aggregate_id],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return row;
      }

      await markOutboxProcessed(database, event.id);
      return null;
    });
  }

  private async recordSubmitted(
    event: OutboxEventRow,
    transactionHash: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.liquidity_actions
             SET status = 'SUBMITTED',
                 provider_reference = $3,
                 provider_payload = provider_payload || jsonb_build_object(
                   'sourceBurnTransactionHash', $3::text
                 ),
                 submitted_at = now(),
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, event.aggregate_id, transactionHash],
      );
      await markOutboxProcessed(database, event.id);
    });
  }

  private async recordUnknown(
    event: OutboxEventRow,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.liquidity_actions
             SET status = 'UNKNOWN',
                 failure_reason = $3,
                 updated_at = now()
           WHERE organization_id = $1
             AND id = $2
        `,
        [event.organization_id, event.aggregate_id, reason],
      );
      await markOutboxFailed(database, event.id, reason);
    });
  }

  private async failLiquidityAction(
    event: OutboxEventRow,
    reason: string,
  ): Promise<void> {
    await this.database.withWorker(async (database) => {
      await database.query(
        `
          UPDATE opes.liquidity_actions
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

    this.logger.warn(`liquidity action job ${event.id} failed: ${reason}`);
  }
}

function buildSignerRequest(action: LiquidityWorkRow): SignerRequest {
  const request = (action.provider_payload as { signerRequest?: unknown })
    .signerRequest;
  if (request === null || typeof request !== 'object') {
    throw new Error('Liquidity action is missing signer request');
  }
  const value = request as Record<string, unknown>;
  const signerRequest: SignerRequest = {
    provider: 'circle',
    chainId: requireNumber(value.chainId, 'signerRequest.chainId'),
    from: requireAddress(value.from, 'signerRequest.from'),
    to: requireAddress(value.to, 'signerRequest.to'),
    data: requireHex(value.data, 'signerRequest.data'),
    value: '0',
    idempotencyKey: action.id,
    liquidityActionId: action.id,
  };

  if (
    signerRequest.chainId !== action.source_chain_id ||
    value.provider !== 'circle' ||
    value.value !== '0' ||
    !signerRequest.data.startsWith('0x8e0250ee')
  ) {
    throw new Error('Liquidity signer request violates CCTP policy');
  }

  return signerRequest;
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

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireAddress(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isEvmAddress(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireHex(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value.toLowerCase();
}
