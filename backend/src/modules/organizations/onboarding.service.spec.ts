import { ConflictException } from '@nestjs/common';
import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
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
      .mockResolvedValueOnce({ rows: [] })
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

  it('reuses an active operator wallet without queuing another provisioning job', async () => {
    const query = jest.fn((sql: string) => {
      if (sql.includes('INSERT INTO opes.organizations')) {
        return Promise.resolve({
          rows: [
            {
              id: 'organization-1',
              slug: 'acme-design',
              display_name: 'Acme Design',
              lifecycle_status: 'PROVISIONING',
            },
          ],
        });
      }
      if (
        sql.includes('FROM opes.organization_memberships') &&
        sql.includes('user_id')
      ) {
        return Promise.resolve({
          rows: [{ id: 'membership-1', role: 'OWNER', status: 'ACTIVE' }],
        });
      }
      if (sql.includes('INSERT INTO opes.business_agents')) {
        return Promise.resolve({
          rows: [{ id: 'agent-1', lifecycle_status: 'SETUP_REQUIRED' }],
        });
      }
      if (sql.includes('WITH existing AS')) {
        return Promise.resolve({
          rows: [{ id: 'wallet-binding-1', status: 'ACTIVE' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const database = {
      withTransaction: jest.fn((work: (db: TenantDatabase) => unknown) =>
        work({ query }),
      ),
    } as unknown as DatabaseService;

    await new OnboardingService(database).onboard(user, {
      organizationName: 'Acme Design',
    });

    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('agent.wallet.provision.arc_testnet'),
      ),
    ).toBe(false);
  });

  it('rejects taking an existing organization slug owned by another user', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
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
