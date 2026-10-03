import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

describe('AgentController', () => {
  it('gets the tenant primary agent through resolved context', async () => {
    const agent = {
      id: 'agent-1',
      lifecycleStatus: 'PROVISIONING',
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
});
