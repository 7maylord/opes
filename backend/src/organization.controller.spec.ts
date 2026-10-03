import { UnauthorizedException } from '@nestjs/common';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { SessionService } from './session.service';
import { TenantContextService } from './tenant-context.service';

describe('OrganizationController', () => {
  it('lists organizations for the bearer session user', async () => {
    const listForUser = jest.fn(() => Promise.resolve([]));
    const resolveUser = jest.fn(() =>
      Promise.resolve({
        id: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
      }),
    );
    const controller = new OrganizationController(
      { listForUser } as unknown as OrganizationService,
      { resolveUser } as unknown as SessionService,
      {} as TenantContextService,
    );

    await expect(
      controller.listOrganizations('Bearer token-1'),
    ).resolves.toEqual([]);
    expect(resolveUser).toHaveBeenCalledWith('token-1');
    expect(listForUser).toHaveBeenCalledWith('user-1');
  });

  it('rejects missing bearer tokens', async () => {
    const controller = new OrganizationController(
      {} as OrganizationService,
      { resolveUser: jest.fn() } as unknown as SessionService,
      {} as TenantContextService,
    );

    await expect(
      controller.listOrganizations(undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects invalid sessions', async () => {
    const controller = new OrganizationController(
      {} as OrganizationService,
      {
        resolveUser: jest.fn(() => Promise.resolve(null)),
      } as unknown as SessionService,
      {} as TenantContextService,
    );

    await expect(
      controller.listOrganizations('Bearer missing'),
    ).rejects.toThrow('Session is invalid or expired');
  });

  it('gets an organization through resolved tenant context', async () => {
    const organization = {
      id: 'organization-1',
      slug: 'acme',
      displayName: 'Acme',
      lifecycleStatus: 'PROVISIONING',
      membershipId: 'membership-1',
      role: 'OWNER',
      agentId: 'agent-1',
      agentLifecycleStatus: 'PROVISIONING',
    };
    const getForTenant = jest.fn(() => Promise.resolve(organization));
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
      requestId: 'http-request',
    };
    const resolve = jest.fn(() => Promise.resolve(context));
    const controller = new OrganizationController(
      { getForTenant } as unknown as OrganizationService,
      { resolveUser } as unknown as SessionService,
      { resolve } as unknown as TenantContextService,
    );

    await expect(
      controller.getOrganization('organization-1', 'Bearer token-1'),
    ).resolves.toEqual(organization);
    expect(resolve).toHaveBeenCalledWith({
      organizationId: 'organization-1',
      userId: 'user-1',
      requestId: 'http-request',
    });
    expect(getForTenant).toHaveBeenCalledWith(context);
  });

  it('lists organization members through resolved tenant context', async () => {
    const members = [
      {
        id: 'membership-1',
        userId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        role: 'OWNER',
        status: 'ACTIVE',
        createdAt: new Date('2026-10-03T10:00:00.000Z'),
      },
    ];
    const listMembers = jest.fn(() => Promise.resolve(members));
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
      requestId: 'http-request',
    };
    const resolve = jest.fn(() => Promise.resolve(context));
    const controller = new OrganizationController(
      { listMembers } as unknown as OrganizationService,
      { resolveUser } as unknown as SessionService,
      { resolve } as unknown as TenantContextService,
    );

    await expect(
      controller.listOrganizationMembers('organization-1', 'Bearer token-1'),
    ).resolves.toEqual(members);
    expect(resolve).toHaveBeenCalledWith({
      organizationId: 'organization-1',
      userId: 'user-1',
      requestId: 'http-request',
    });
    expect(listMembers).toHaveBeenCalledWith(context);
  });

  it('invites organization members through resolved tenant context', async () => {
    const member = {
      id: 'membership-2',
      userId: 'user-2',
      email: 'ops@example.com',
      displayName: 'Ops',
      role: 'APPROVER',
      status: 'INVITED',
      createdAt: new Date('2026-10-03T10:00:00.000Z'),
      invitationToken: 'invite-token',
    };
    const inviteMember = jest.fn(() => Promise.resolve(member));
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
      requestId: 'http-request',
    };
    const resolve = jest.fn(() => Promise.resolve(context));
    const controller = new OrganizationController(
      { inviteMember } as unknown as OrganizationService,
      { resolveUser } as unknown as SessionService,
      { resolve } as unknown as TenantContextService,
    );
    const body = {
      email: 'ops@example.com',
      displayName: 'Ops',
      role: 'APPROVER' as const,
    };

    await expect(
      controller.inviteOrganizationMember(
        'organization-1',
        'Bearer token-1',
        body,
        'invite-key-1',
      ),
    ).resolves.toEqual(member);
    expect(resolve).toHaveBeenCalledWith({
      organizationId: 'organization-1',
      userId: 'user-1',
      requestId: 'http-request',
    });
    expect(inviteMember).toHaveBeenCalledWith(context, body, 'invite-key-1');
  });

  it('updates organization members through resolved tenant context', async () => {
    const member = {
      id: 'membership-2',
      userId: 'user-2',
      email: 'ops@example.com',
      displayName: 'Ops',
      role: 'AUDITOR',
      status: 'REVOKED',
      createdAt: new Date('2026-10-03T10:00:00.000Z'),
    };
    const updateMember = jest.fn(() => Promise.resolve(member));
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
      requestId: 'http-request',
    };
    const resolve = jest.fn(() => Promise.resolve(context));
    const controller = new OrganizationController(
      { updateMember } as unknown as OrganizationService,
      { resolveUser } as unknown as SessionService,
      { resolve } as unknown as TenantContextService,
    );
    const body = {
      role: 'AUDITOR' as const,
      status: 'REVOKED' as const,
    };

    await expect(
      controller.updateOrganizationMember(
        'organization-1',
        'membership-2',
        'Bearer token-1',
        body,
        'update-key-1',
      ),
    ).resolves.toEqual(member);
    expect(resolve).toHaveBeenCalledWith({
      organizationId: 'organization-1',
      userId: 'user-1',
      requestId: 'http-request',
    });
    expect(updateMember).toHaveBeenCalledWith(
      context,
      'membership-2',
      body,
      'update-key-1',
    );
  });
});
