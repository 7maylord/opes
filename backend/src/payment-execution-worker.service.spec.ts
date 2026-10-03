import { DatabaseService, TenantDatabase } from './database.service';
import { PaymentExecutionWorkerService } from './payment-execution-worker.service';

function serviceWithWorker(query: TenantDatabase['query']): {
  service: PaymentExecutionWorkerService;
  withWorker: jest.Mock;
} {
  const withWorker = jest.fn(
    (work: (database: TenantDatabase) => Promise<unknown>) => work({ query }),
  );
  return {
    service: new PaymentExecutionWorkerService({
      withWorker,
    } as unknown as DatabaseService),
    withWorker,
  };
}

describe('PaymentExecutionWorkerService', () => {
  it('marks unconfigured payment execution as failed and visible', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = jest
      .fn()
      .mockImplementation((text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });

        if (text.includes('RETURNING id, organization_id, aggregate_id')) {
          return Promise.resolve({
            rows: [
              {
                id: 'event-1',
                organization_id: 'organization-1',
                aggregate_id: 'execution-1',
              },
            ],
          });
        }

        return Promise.resolve({ rows: [] });
      });
    const { service, withWorker } = serviceWithWorker(query);

    await expect(service.processDuePaymentExecutions(1)).resolves.toBe(1);
    expect(withWorker).toHaveBeenCalledTimes(2);
    expect(queries[1]?.text).toContain("SET status = 'FAILED'");
    expect(queries[1]?.values).toEqual([
      'organization-1',
      'execution-1',
      'Payment signer adapter is not configured',
    ]);
    expect(queries[2]?.text).toContain(
      "payload = payload || jsonb_build_object('failureReason'",
    );
    expect(queries[2]?.values).toEqual([
      'event-1',
      'Payment signer adapter is not configured',
    ]);
  });

  it('stops when no execution event is ready', async () => {
    const query = jest.fn(() => Promise.resolve({ rows: [] }));
    const { service, withWorker } = serviceWithWorker(query);

    await expect(service.processDuePaymentExecutions()).resolves.toBe(0);
    expect(withWorker).toHaveBeenCalledTimes(1);
  });
});
