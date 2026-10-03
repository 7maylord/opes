import { AgentService } from './agent.service';
import { DatabaseService, TenantDatabase } from './database.service';
import { TenantContext } from './tenant-context';

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

describe('AgentService', () => {
  it('gets the primary agent and resource bindings through tenant scope', async () => {
    const context: TenantContext = {
      organizationId: 'organization-1',
      userId: 'user-1',
      membershipId: 'membership-1',
      role: 'OWNER',
      agentId: 'agent-1',
      requestId: 'request-1',
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'agent-1',
            lifecycle_status: 'PROVISIONING',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'binding-1',
            environment: 'testnet',
            chain_id: 50426,
            provider: 'circle',
            resource_type: 'wallet',
            resource_id: 'wallet-1',
            address: '0x123',
            status: 'PENDING',
            metadata: { chain: 'arc-testnet' },
          },
        ],
      });
    const withTenant = jest.fn(
      (
        _context: TenantContext,
        work: (database: TenantDatabase) => Promise<unknown>,
      ) => work({ query }),
    );
    const service = new AgentService(
      {
        withTenant,
      } as unknown as DatabaseService,
      factoryManifests,
    );

    await expect(service.getPrimaryAgent(context)).resolves.toEqual({
      id: 'agent-1',
      lifecycleStatus: 'PROVISIONING',
      arcTestnetFactory: {
        environment: 'arc-testnet',
        chainId: 5042002,
        factoryAddress: '0xfactory',
        vaultDeployerAddress: '0xdeployer',
        verification: 'fully_verified',
        explorerUrl: 'https://explorer.testnet.arc.io/address/0xfactory',
        checkedAt: '2026-10-02T09:05:47.854Z',
      },
      resourceBindings: [
        {
          id: 'binding-1',
          environment: 'testnet',
          chainId: 50426,
          provider: 'circle',
          resourceType: 'wallet',
          resourceId: 'wallet-1',
          address: '0x123',
          status: 'PENDING',
          metadata: { chain: 'arc-testnet' },
        },
      ],
    });
    expect(withTenant).toHaveBeenCalledWith(context, expect.any(Function));
  });

  it('creates a pending Arc factory provisioning binding once', async () => {
    const context: TenantContext = {
      organizationId: 'organization-1',
      userId: 'user-1',
      membershipId: 'membership-1',
      role: 'OWNER',
      agentId: 'agent-1',
      requestId: 'request-1',
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'binding-1',
            environment: 'arc-testnet',
            chain_id: 5042002,
            provider: 'arc',
            resource_type: 'factory_provisioning',
            resource_id: 'organization-1',
            address: null,
            status: 'PENDING',
            metadata: {
              factoryAddress: '0xfactory',
              vaultDeployerAddress: '0xdeployer',
              verification: 'fully_verified',
              checkedAt: '2026-10-02T09:05:47.854Z',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const withTenant = jest.fn(
      (
        _context: TenantContext,
        work: (database: TenantDatabase) => Promise<unknown>,
      ) => work({ query }),
    );
    const service = new AgentService(
      {
        withTenant,
      } as unknown as DatabaseService,
      factoryManifests,
    );

    await expect(
      service.requestArcTestnetProvisioning(context),
    ).resolves.toEqual({
      id: 'binding-1',
      environment: 'arc-testnet',
      chainId: 5042002,
      provider: 'arc',
      resourceType: 'factory_provisioning',
      resourceId: 'organization-1',
      address: null,
      status: 'PENDING',
      metadata: {
        factoryAddress: '0xfactory',
        vaultDeployerAddress: '0xdeployer',
        verification: 'fully_verified',
        checkedAt: '2026-10-02T09:05:47.854Z',
      },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO opes.tenant_resource_bindings'),
      [
        'organization-1',
        'arc-testnet',
        5042002,
        'organization-1',
        JSON.stringify({
          factoryAddress: '0xfactory',
          vaultDeployerAddress: '0xdeployer',
          verification: 'fully_verified',
          checkedAt: '2026-10-02T09:05:47.854Z',
        }),
      ],
    );
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('agent.provision.arc_testnet'),
      ['organization-1', 'binding-1'],
    );
  });
});
