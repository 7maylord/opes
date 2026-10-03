import { DatabaseService, TenantDatabase } from './database.service';
import { OrganizationService } from './organization.service';
import { TenantContext } from './tenant-context';

describe('OrganizationService', () => {
  it('lists active organizations for a user', async () => {
    const query = jest.fn(() =>
      Promise.resolve({
        rows: [
          {
            id: 'organization-1',
            slug: 'acme',
            display_name: 'Acme',
            lifecycle_status: 'PROVISIONING',
            membership_id: 'membership-1',
            role: 'OWNER',
            agent_id: 'agent-1',
            agent_lifecycle_status: 'PROVISIONING',
          },
        ],
      }),
    );
    const database = {
      withDatabase: jest.fn(
        (work: (database: TenantDatabase) => Promise<unknown>) =>
          work({ query }),
      ),
    } as unknown as DatabaseService;
    const service = new OrganizationService(database);

    await expect(service.listForUser('user-1')).resolves.toEqual([
      {
        id: 'organization-1',
        slug: 'acme',
        displayName: 'Acme',
        lifecycleStatus: 'PROVISIONING',
        membershipId: 'membership-1',
        role: 'OWNER',
        agentId: 'agent-1',
        agentLifecycleStatus: 'PROVISIONING',
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('membership.user_id = $1'),
      ['user-1'],
    );
  });

  it('requires a user id', async () => {
    const service = new OrganizationService({} as DatabaseService);

    await expect(service.listForUser('')).rejects.toThrow('userId is required');
  });

  it('gets one organization through tenant-scoped access', async () => {
    const context: TenantContext = {
      organizationId: 'organization-1',
      userId: 'user-1',
      membershipId: 'membership-1',
      role: 'OWNER',
      agentId: 'agent-1',
      requestId: 'request-1',
    };
    const query = jest.fn(() =>
      Promise.resolve({
        rows: [
          {
            id: 'organization-1',
            slug: 'acme',
            display_name: 'Acme',
            lifecycle_status: 'PROVISIONING',
            membership_id: 'membership-1',
            role: 'OWNER',
            agent_id: 'agent-1',
            agent_lifecycle_status: 'PROVISIONING',
          },
        ],
      }),
    );
    const withTenant = jest.fn(
      (
        _context: TenantContext,
        work: (database: TenantDatabase) => Promise<unknown>,
      ) => work({ query }),
    );
    const database = {
      withTenant,
    } as unknown as DatabaseService;
    const service = new OrganizationService(database);

    await expect(service.getForTenant(context)).resolves.toEqual({
      id: 'organization-1',
      slug: 'acme',
      displayName: 'Acme',
      lifecycleStatus: 'PROVISIONING',
      membershipId: 'membership-1',
      role: 'OWNER',
      agentId: 'agent-1',
      agentLifecycleStatus: 'PROVISIONING',
    });
    expect(withTenant).toHaveBeenCalledWith(context, expect.any(Function));
  });
});
