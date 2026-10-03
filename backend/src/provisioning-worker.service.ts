import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';

interface OutboxEventRow {
  id: string;
  organization_id: string;
  aggregate_id: string;
}

@Injectable()
export class ProvisioningWorkerService {
  private readonly logger = new Logger(ProvisioningWorkerService.name);

  constructor(private readonly database: DatabaseService) {}

  async processDueArcProvisioning(limit = 10): Promise<number> {
    let processed = 0;

    while (processed < limit) {
      const event = await this.claimNextArcProvisioningEvent();
      if (event === undefined) {
        return processed;
      }

      await this.failUnconfiguredArcProvisioning(event);
      processed += 1;
    }

    return processed;
  }

  private async claimNextArcProvisioningEvent(): Promise<
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
              WHERE event_type = 'agent.provision.arc_testnet'
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

  private async failUnconfiguredArcProvisioning(
    event: OutboxEventRow,
  ): Promise<void> {
    const reason = 'Arc provisioning provider is not configured';

    await this.database.withWorker(async (database) => {
      await updateProvisioningBinding(database, event, reason);
      await failOutboxEvent(database, event.id, reason);
    });

    this.logger.warn(`arc provisioning job ${event.id} failed: ${reason}`);
  }
}

async function updateProvisioningBinding(
  database: TenantDatabase,
  event: OutboxEventRow,
  reason: string,
): Promise<void> {
  await database.query(
    `
      UPDATE opes.tenant_resource_bindings
         SET status = 'FAILED',
             metadata = metadata || jsonb_build_object(
               'failureReason', $3::text,
               'failedAt', now()
             ),
             updated_at = now()
       WHERE organization_id = $1
         AND id = $2
         AND provider = 'arc'
         AND environment = 'arc-testnet'
         AND resource_type = 'factory_provisioning'
         AND status IN ('PENDING', 'FAILED')
    `,
    [event.organization_id, event.aggregate_id, reason],
  );
}

async function failOutboxEvent(
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
