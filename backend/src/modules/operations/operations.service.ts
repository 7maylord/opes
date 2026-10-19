import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';

export interface OutboxQueueSummary {
  eventType: string;
  pending: number;
  processing: number;
  staleProcessing: number;
  failed: number;
  oldestPendingSeconds: number | null;
  newestFailureAt: string | null;
}

interface OutboxQueueSummaryRow {
  event_type: string;
  pending: string;
  processing: string;
  stale_processing: string;
  failed: string;
  oldest_pending_seconds: string | null;
  newest_failure_at: Date | null;
}

@Injectable()
export class OperationsService {
  constructor(private readonly database: DatabaseService) {}

  async getOutboxSummary(): Promise<OutboxQueueSummary[]> {
    return this.database.withWorker(async (database) => {
      const result = await database.query<OutboxQueueSummaryRow>(
        `
          SELECT
            event_type,
            COUNT(*) FILTER (WHERE status = 'PENDING')::text AS pending,
            COUNT(*) FILTER (WHERE status = 'PROCESSING')::text AS processing,
            COUNT(*) FILTER (
              WHERE status = 'PROCESSING'
                AND updated_at < now() - interval '5 minutes'
            )::text AS stale_processing,
            COUNT(*) FILTER (WHERE status = 'FAILED')::text AS failed,
            FLOOR(EXTRACT(EPOCH FROM now() - MIN(created_at) FILTER (WHERE status = 'PENDING')))::text
              AS oldest_pending_seconds,
            MAX(processed_at) FILTER (WHERE status = 'FAILED') AS newest_failure_at
          FROM opes.outbox_events
          WHERE status IN ('PENDING', 'PROCESSING', 'FAILED')
          GROUP BY event_type
          ORDER BY event_type ASC
        `,
      );

      return result.rows.map((row) => ({
        eventType: row.event_type,
        pending: Number(row.pending),
        processing: Number(row.processing),
        staleProcessing: Number(row.stale_processing),
        failed: Number(row.failed),
        oldestPendingSeconds:
          row.oldest_pending_seconds === null
            ? null
            : Number(row.oldest_pending_seconds),
        newestFailureAt: row.newest_failure_at?.toISOString() ?? null,
      }));
    });
  }
}
