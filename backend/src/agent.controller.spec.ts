import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

describe('AgentController', () => {
  it('gets the tenant primary agent through resolved context', async () => {
    const agent = {
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
      resourceBindings: [],
    };
    const getPrimaryAgent = jest.fn(() => Promise.resolve(agent));
    const resolveUser = jest.fn(() =>
      Promise.resolve({
        id: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
      }),
    );
    const context = {
      organizationId: 'organization-1',
      userId: 'user-1',
      membershipId: 'membership-1',
      role: 'OWNER' as const,
      agentId: 'agent-1',
      requestId: 'request-1',
    };
    const resolve = jest.fn(() => Promise.resolve(context));
    const controller = new AgentController(
      { getPrimaryAgent } as unknown as AgentService,
      { resolveUser } as unknown as SessionService,
      { resolve } as unknown as TenantContextService,
    );

    await expect(
      controller.getAgent('organization-1', 'Bearer token-1', 'request-1'),
    ).resolves.toEqual(agent);
    expect(resolve).toHaveBeenCalledWith({
      organizationId: 'organization-1',
      userId: 'user-1',
      requestId: 'request-1',
    });
    expect(getPrimaryAgent).toHaveBeenCalledWith(context);
  });

  it('requests Arc testnet provisioning through resolved context', async () => {
    const binding = {
      id: 'binding-1',
      environment: 'arc-testnet',
      chainId: 5042002,
      provider: 'arc',
      resourceType: 'factory_provisioning',
      resourceId: 'organization-1',
      address: null,
      status: 'PENDING',
      metadata: { verification: 'fully_verified' },
    };
    const requestArcTestnetProvisioning = jest.fn(() =>
      Promise.resolve(binding),
    );
    const resolveUser = jest.fn(() =>
      Promise.resolve({
        id: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
      }),
    );
    const context = {
      organizationId: 'organization-1',
      userId: 'user-1',
      membershipId: 'membership-1',
      role: 'OWNER' as const,
      agentId: 'agent-1',
      requestId: 'request-1',
    };
    const resolve = jest.fn(() => Promise.resolve(context));
    const controller = new AgentController(
      { requestArcTestnetProvisioning } as unknown as AgentService,
      { resolveUser } as unknown as SessionService,
      { resolve } as unknown as TenantContextService,
    );

    await expect(
      controller.requestArcTestnetProvisioning(
        'organization-1',
        'Bearer token-1',
        'request-1',
      ),
    ).resolves.toEqual(binding);
    expect(resolve).toHaveBeenCalledWith({
      organizationId: 'organization-1',
      userId: 'user-1',
      requestId: 'request-1',
    });
    expect(requestArcTestnetProvisioning).toHaveBeenCalledWith(context);
  });
});
