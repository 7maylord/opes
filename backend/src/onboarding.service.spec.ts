import { ConflictException } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { OnboardingService } from './onboarding.service';

const user = {
  id: 'user-1',
  email: 'owner@example.com',
  displayName: 'Owner',
  ownerWalletAddress: '0x1111111111111111111111111111111111111111',
};

describe('OnboardingService', () => {
  it('creates an organization for the authenticated user without minting a session', async () => {
    const query = jest
      .fn()
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
      })
      .mockResolvedValueOnce({ rows: [{ id: 'wallet-binding-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const database = {
      withTransaction: jest.fn((work: (db: TenantDatabase) => unknown) =>
        work({ query }),
      ),
    } as unknown as DatabaseService;

    await expect(
      new OnboardingService(database).onboard(user, {
        organizationName: 'Acme Design',
      }),
    ).resolves.toMatchObject({
      user,
      organization: { id: 'organization-1', slug: 'acme-design' },
      membership: { id: 'membership-1', role: 'OWNER' },
      agent: { id: 'agent-1' },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('user_id'), [
      'organization-1',
      'user-1',
    ]);
  });

  it('rejects taking an existing organization slug owned by another user', async () => {
    const query = jest
      .fn()
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
      withTransaction: jest.fn((work: (db: TenantDatabase) => unknown) =>
        work({ query }),
      ),
    } as unknown as DatabaseService;
    await expect(
      new OnboardingService(database).onboard(user, {
        organizationName: 'Acme Design',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('binds idempotency to the authenticated user', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rows: [{ request_hash: 'different-request', status: 'COMPLETED' }],
      });
    const database = {
      withTransaction: jest.fn((work: (db: TenantDatabase) => unknown) =>
        work({ query }),
      ),
    } as unknown as DatabaseService;
    await expect(
      new OnboardingService(database).onboard(
        user,
        { organizationName: 'Acme Design' },
        'key-1',
      ),
    ).rejects.toThrow('different request');
  });
});
