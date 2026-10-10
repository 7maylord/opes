import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { PrivyClient } from '@privy-io/node';
import { DatabaseService, TenantDatabase } from './database.service';
import { AuthService, linkPrivyUser } from './auth.service';
import { SessionService } from './session.service';

jest.mock('@privy-io/node', () => ({ PrivyClient: jest.fn() }));

describe('linkPrivyUser', () => {
  it('links a verified subject to the matching unclaimed email user', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-1',
            email: 'owner@example.com',
            display_name: 'Owner',
            privy_user_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'user-1',
            email: 'owner@example.com',
            display_name: 'Owner',
            privy_user_id: 'did:privy:1',
          },
        ],
      });
    await expect(
      linkPrivyUser(
        { query } as TenantDatabase,
        'did:privy:1',
        'OWNER@example.com',
      ),
    ).resolves.toMatchObject({ id: 'user-1', privy_user_id: 'did:privy:1' });
  });

  it('does not overwrite an email already bound to another subject', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'user-1',
          email: 'owner@example.com',
          display_name: 'Owner',
          privy_user_id: 'did:privy:other',
        },
      ],
    });
    await expect(
      linkPrivyUser(
        { query } as TenantDatabase,
        'did:privy:1',
        'owner@example.com',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('AuthService', () => {
  it('rejects an invalid Privy token before touching the database', async () => {
    process.env.PRIVY_APP_ID = 'app-id';
    process.env.PRIVY_APP_SECRET = 'app-secret';
    const verifyAccessToken = jest.fn().mockRejectedValue(new Error('invalid'));
    (PrivyClient as unknown as jest.Mock).mockImplementation(() => ({
      utils: () => ({ auth: () => ({ verifyAccessToken }) }),
    }));
    const withTransaction = jest.fn();
    const service = new AuthService(
      { withTransaction } as unknown as DatabaseService,
      {} as SessionService,
    );

    await expect(service.exchangePrivyToken('forged')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
