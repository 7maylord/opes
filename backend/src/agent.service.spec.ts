import { AgentService } from './agent.service';
import { DatabaseService, TenantDatabase } from './database.service';
import { TenantContext } from './tenant-context';

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
    const service = new AgentService({
      withTenant,
    } as unknown as DatabaseService);

    await expect(service.getPrimaryAgent(context)).resolves.toEqual({
      id: 'agent-1',
      lifecycleStatus: 'PROVISIONING',
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
});
