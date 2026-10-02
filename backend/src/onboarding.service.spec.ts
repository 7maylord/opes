import { ConflictException } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { OnboardingService } from './onboarding.service';
import { SessionService } from './session.service';

describe('OnboardingService', () => {
  it('creates the user, organization, owner membership, primary agent and session atomically', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-1',
            email: 'owner@example.com',
            display_name: 'Owner',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'organization-1',
            slug: 'acme-design',
            display_name: 'Acme Design',
            lifecycle_status: 'PROVISIONING',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'membership-1', role: 'OWNER', status: 'ACTIVE' }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'agent-1', lifecycle_status: 'PROVISIONING' }],
      });
    const database = {
      withTransaction: jest.fn((work: (database: TenantDatabase) => unknown) =>
        work({ query }),
      ),
    } as unknown as DatabaseService;
    const createSessionRecord = jest.fn(() => Promise.resolve('session-token'));
    const sessions = {
      createSessionRecord,
    } as unknown as SessionService;
    const service = new OnboardingService(database, sessions);

    await expect(
      service.onboard({
        email: 'OWNER@EXAMPLE.COM',
        displayName: 'Owner',
        organizationName: 'Acme Design',
      }),
    ).resolves.toEqual({
      user: {
        id: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
      },
      organization: {
        id: 'organization-1',
        slug: 'acme-design',
        displayName: 'Acme Design',
        lifecycleStatus: 'PROVISIONING',
      },
      membership: {
        id: 'membership-1',
        role: 'OWNER',
      },
      agent: {
        id: 'agent-1',
        lifecycleStatus: 'PROVISIONING',
      },
      sessionToken: 'session-token',
    });

    expect(createSessionRecord).toHaveBeenCalledWith({ query }, 'user-1');
  });

  it('rejects taking an existing organization slug owned by another user', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-2',
            email: 'other@example.com',
            display_name: 'Other',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'organization-1',
            slug: 'acme-design',
            display_name: 'Acme Design',
            lifecycle_status: 'PROVISIONING',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'membership-1' }] });
    const database = {
      withTransaction: jest.fn((work: (database: TenantDatabase) => unknown) =>
        work({ query }),
      ),
    } as unknown as DatabaseService;
    const createSessionRecord = jest.fn();
    const sessions = {
      createSessionRecord,
    } as unknown as SessionService;
    const service = new OnboardingService(database, sessions);

    await expect(
      service.onboard({
        email: 'other@example.com',
        displayName: 'Other',
        organizationName: 'Acme Design',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(createSessionRecord).not.toHaveBeenCalled();
  });

  it('rejects invalid email before opening a transaction', async () => {
    const withTransaction = jest.fn();
    const database = {
      withTransaction,
    } as unknown as DatabaseService;
    const service = new OnboardingService(database, {} as SessionService);

    await expect(
      service.onboard({
        email: 'not-an-email',
        displayName: 'Owner',
        organizationName: 'Acme Design',
      }),
    ).rejects.toThrow('email must be valid');
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
