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

  it('lists organization members through tenant-scoped access', async () => {
    const context: TenantContext = {
      organizationId: 'organization-1',
      userId: 'user-1',
      membershipId: 'membership-1',
      role: 'OWNER',
      agentId: 'agent-1',
      requestId: 'request-1',
    };
    const createdAt = new Date('2026-10-03T10:00:00.000Z');
    const query = jest.fn(() =>
      Promise.resolve({
        rows: [
          {
            id: 'membership-1',
            user_id: 'user-1',
            email: 'owner@example.com',
            display_name: 'Owner',
            role: 'OWNER',
            status: 'ACTIVE',
            created_at: createdAt,
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

    await expect(service.listMembers(context)).resolves.toEqual([
      {
        id: 'membership-1',
        userId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        role: 'OWNER',
        status: 'ACTIVE',
        createdAt,
      },
    ]);
    expect(withTenant).toHaveBeenCalledWith(context, expect.any(Function));
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('membership.organization_id = $1'),
      ['organization-1'],
    );
  });

  it('invites a member through tenant-scoped access', async () => {
    const context: TenantContext = {
      organizationId: 'organization-1',
      userId: 'owner-user-1',
      membershipId: 'owner-membership-1',
      role: 'OWNER',
      agentId: 'agent-1',
      requestId: 'request-1',
    };
    const createdAt = new Date('2026-10-03T10:00:00.000Z');
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-2',
            email: 'ops@example.com',
            display_name: 'Ops',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'membership-2',
            user_id: 'user-2',
            email: 'ops@example.com',
            display_name: 'Ops',
            role: 'APPROVER',
            status: 'INVITED',
            created_at: createdAt,
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
    const database = {
      withTenant,
    } as unknown as DatabaseService;
    const service = new OrganizationService(database);

    await expect(
      service.inviteMember(context, {
        email: 'OPS@example.com',
        displayName: 'Ops',
        role: 'APPROVER',
      }),
    ).resolves.toEqual({
      id: 'membership-2',
      userId: 'user-2',
      email: 'ops@example.com',
      displayName: 'Ops',
      role: 'APPROVER',
      status: 'INVITED',
      createdAt,
    });
    expect(withTenant).toHaveBeenCalledWith(context, expect.any(Function));
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('organization.member.invited'),
      [
        'organization-1',
        'owner-user-1',
        'owner-membership-1',
        'membership-2',
        JSON.stringify({ email: 'ops@example.com', role: 'APPROVER' }),
      ],
    );
  });

  it('rejects member invites from non-admin roles', async () => {
    const service = new OrganizationService({} as DatabaseService);

    await expect(
      service.inviteMember(
        {
          organizationId: 'organization-1',
          userId: 'user-1',
          membershipId: 'membership-1',
          role: 'AUDITOR',
          agentId: 'agent-1',
          requestId: 'request-1',
        },
        {
          email: 'ops@example.com',
          role: 'APPROVER',
        },
      ),
    ).rejects.toThrow('Only owners and admins can invite members');
  });
});
