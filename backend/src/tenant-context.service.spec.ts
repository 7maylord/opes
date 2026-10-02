import { DatabaseService, TenantDatabase } from './database.service';
import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  it('resolves an active membership through organization-scoped database access', async () => {
    const withOrganizationScope = jest.fn(
      (
        _organizationId: string,
        work: (database: TenantDatabase) => Promise<unknown>,
      ) =>
        work({
          query: jest.fn(() =>
            Promise.resolve({
              rows: [
                {
                  membership_id: 'membership-1',
                  role: 'OWNER',
                  agent_id: 'agent-1',
                },
              ],
            }),
          ),
        }),
    );
    const database = {
      withOrganizationScope,
    } as unknown as DatabaseService;
    const service = new TenantContextService(database);

    await expect(
      service.resolve({
        organizationId: 'organization-1',
        userId: 'user-1',
        requestId: 'request-1',
      }),
    ).resolves.toEqual({
      organizationId: 'organization-1',
      userId: 'user-1',
      membershipId: 'membership-1',
      role: 'OWNER',
      agentId: 'agent-1',
      requestId: 'request-1',
    });

    expect(withOrganizationScope).toHaveBeenCalledWith(
      'organization-1',
      expect.any(Function),
    );
  });

  it('rejects users without an active organization membership', async () => {
    const database = {
      withOrganizationScope: jest.fn(
        (
          _organizationId: string,
          work: (database: TenantDatabase) => Promise<unknown>,
        ) =>
          work({
            query: jest.fn(() => Promise.resolve({ rows: [] })),
          }),
      ),
    } as unknown as DatabaseService;
    const service = new TenantContextService(database);

    await expect(
      service.resolve({
        organizationId: 'organization-1',
        userId: 'user-1',
        requestId: 'request-1',
      }),
    ).rejects.toThrow('Active organization membership not found');
  });
});
