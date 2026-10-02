import { UnauthorizedException } from '@nestjs/common';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { SessionService } from './session.service';

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
    );

    await expect(
      controller.listOrganizations('Bearer missing'),
    ).rejects.toThrow('Session is invalid or expired');
  });
});
