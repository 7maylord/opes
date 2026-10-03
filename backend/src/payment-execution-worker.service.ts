import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';

interface OutboxEventRow {
  id: string;
  organization_id: string;
  aggregate_id: string;
}

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

      await this.failUnconfiguredPaymentExecution(event);
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

  private async failUnconfiguredPaymentExecution(
    event: OutboxEventRow,
  ): Promise<void> {
    const reason = 'Payment signer adapter is not configured';

    await this.database.withWorker(async (database) => {
      await markExecutionFailed(database, event, reason);
      await markOutboxFailed(database, event.id, reason);
    });

    this.logger.warn(`payment execution job ${event.id} failed: ${reason}`);
  }
}

async function markExecutionFailed(
  database: TenantDatabase,
  event: OutboxEventRow,
  reason: string,
): Promise<void> {
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
