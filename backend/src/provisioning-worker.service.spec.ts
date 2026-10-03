import { DatabaseService, TenantDatabase } from './database.service';
import { ProvisioningWorkerService } from './provisioning-worker.service';

const factoryManifests = {
  getArcTestnetFactory: jest.fn(() => ({
    environment: 'arc-testnet',
    chainId: 5042002,
    factoryAddress: '0xfactory',
    vaultDeployerAddress: '0xdeployer',
    verification: 'fully_verified',
    explorerUrl: 'https://explorer.testnet.arc.io/address/0xfactory',
    checkedAt: '2026-10-02T09:05:47.854Z',
  })),
};

function serviceWithWorker(query: TenantDatabase['query']): {
  service: ProvisioningWorkerService;
  withWorker: jest.Mock;
} {
  const withWorker = jest.fn(
    (work: (database: TenantDatabase) => Promise<unknown>) => work({ query }),
  );
  const service = new ProvisioningWorkerService(
    { withWorker } as unknown as DatabaseService,
    factoryManifests,
  );

  return { service, withWorker };
}

describe('ProvisioningWorkerService', () => {
  beforeEach(() => {
    factoryManifests.getArcTestnetFactory.mockClear();
  });

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
    const { service, withWorker } = serviceWithWorker(query);

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
    const { service, withWorker } = serviceWithWorker(query);

    await expect(service.processDueArcProvisioning()).resolves.toBe(0);
    expect(withWorker).toHaveBeenCalledTimes(1);
  });

  it('records verified Arc provisioning results as active tenant bindings', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = jest
      .fn()
      .mockImplementation((text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        return Promise.resolve({ rows: [{ id: 'updated' }] });
      });
    const { service, withWorker } = serviceWithWorker(query);

    await service.recordArcProvisioningSuccess({
      organizationId: '11111111-1111-1111-1111-111111111111',
      provisioningBindingId: '22222222-2222-2222-2222-222222222222',
      vaultAddress: '0x1111111111111111111111111111111111111111',
      escrowAddress: '0x2222222222222222222222222222222222222222',
      transactionHash:
        '0x3333333333333333333333333333333333333333333333333333333333333333',
      blockNumber: 12,
      sourceVerification: 'fully_verified',
    });

    expect(withWorker).toHaveBeenCalledTimes(1);
    expect(queries).toHaveLength(4);
    expect(queries[0]?.text).toContain("SET status = 'ACTIVE'");
    expect(queries[1]?.values?.[1]).toBe('business_policy_vault_contract');
    expect(queries[2]?.values?.[1]).toBe('milestone_escrow_contract');
    expect(queries[3]?.text).toContain("lifecycle_status = 'SETUP_REQUIRED'");
  });

  it('rejects unverified Arc provisioning results before writing', async () => {
    const query = jest.fn(() => Promise.resolve({ rows: [] }));
    const { service, withWorker } = serviceWithWorker(query);

    await expect(
      service.recordArcProvisioningSuccess({
        organizationId: '11111111-1111-1111-1111-111111111111',
        provisioningBindingId: '22222222-2222-2222-2222-222222222222',
        vaultAddress: '0x1111111111111111111111111111111111111111',
        escrowAddress: '0x2222222222222222222222222222222222222222',
        transactionHash:
          '0x3333333333333333333333333333333333333333333333333333333333333333',
        blockNumber: 12,
        sourceVerification: 'unverified',
      }),
    ).rejects.toThrow('Arc tenant contracts are not verified');
    expect(withWorker).not.toHaveBeenCalled();
  });
});
