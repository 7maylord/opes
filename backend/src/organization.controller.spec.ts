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
});
