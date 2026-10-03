import { DatabaseService, TenantDatabase } from './database.service';
import { ProvisioningWorkerService } from './provisioning-worker.service';

describe('ProvisioningWorkerService', () => {
  it('marks unconfigured Arc provisioning as failed and visible', async () => {
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
                aggregate_id: 'binding-1',
              },
            ],
          });
        }

        return Promise.resolve({ rows: [] });
      });
    const withWorker = jest.fn(
      (work: (database: TenantDatabase) => Promise<unknown>) => work({ query }),
    );
    const service = new ProvisioningWorkerService({
      withWorker,
    } as unknown as DatabaseService);

    await expect(service.processDueArcProvisioning(1)).resolves.toBe(1);
    expect(withWorker).toHaveBeenCalledTimes(2);
    expect(queries[1]?.text).toContain("SET status = 'FAILED'");
    expect(queries[1]?.values).toEqual([
      'organization-1',
      'binding-1',
      'Arc provisioning provider is not configured',
    ]);
    expect(queries[2]?.text).toContain(
      "payload = payload || jsonb_build_object('failureReason'",
    );
    expect(queries[2]?.values).toEqual([
      'event-1',
      'Arc provisioning provider is not configured',
    ]);
  });

  it('stops when no Arc provisioning event is ready', async () => {
    const query = jest.fn(() => Promise.resolve({ rows: [] }));
    const withWorker = jest.fn(
      (work: (database: TenantDatabase) => Promise<unknown>) => work({ query }),
    );
    const service = new ProvisioningWorkerService({
      withWorker,
    } as unknown as DatabaseService);

    await expect(service.processDueArcProvisioning()).resolves.toBe(0);
    expect(withWorker).toHaveBeenCalledTimes(1);
  });
});
