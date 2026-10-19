import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { OperationsService } from './operations.service';

function serviceWithWorker(query: TenantDatabase['query']): OperationsService {
  const withWorker = jest.fn(
    (work: (database: TenantDatabase) => Promise<unknown>) => work({ query }),
  );
  return new OperationsService({ withWorker } as unknown as DatabaseService);
}

describe('OperationsService', () => {
  it('summarizes outbox dead letters and stale processing jobs', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          event_type: 'liquidity.execute.gateway',
          pending: '2',
          processing: '1',
          stale_processing: '1',
          failed: '3',
          oldest_pending_seconds: '42',
          newest_failure_at: new Date('2030-01-01T00:00:00.000Z'),
        },
      ],
    });
    const service = serviceWithWorker(query);

    await expect(service.getOutboxSummary()).resolves.toEqual([
      {
        eventType: 'liquidity.execute.gateway',
        pending: 2,
        processing: 1,
        staleProcessing: 1,
        failed: 3,
        oldestPendingSeconds: 42,
        newestFailureAt: '2030-01-01T00:00:00.000Z',
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('stale_processing'),
    );
  });
});
