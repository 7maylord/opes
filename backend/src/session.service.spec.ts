import { DatabaseService, TenantDatabase } from './database.service';
import { SessionService } from './session.service';

describe('SessionService', () => {
  it('stores only a hashed token when creating a session', async () => {
    const query = jest.fn(() => Promise.resolve({ rows: [] }));
    const database = {
      withDatabase: jest.fn(
        (work: (database: TenantDatabase) => Promise<void>) => work({ query }),
      ),
    } as unknown as DatabaseService;
    const service = new SessionService(database);

    const token = await service.createSession(
      '11111111-1111-1111-1111-111111111111',
    );

    expect(token.length).toBeGreaterThan(40);
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      '11111111-1111-1111-1111-111111111111',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(String),
    ]);
    expect(query.mock.calls[0]?.[1]).not.toContain(token);
  });

  it('can create a session inside an existing transaction', async () => {
    const query = jest.fn(() => Promise.resolve({ rows: [] }));
    const service = new SessionService({} as DatabaseService);

    const token = await service.createSessionRecord(
      { query },
      '11111111-1111-1111-1111-111111111111',
    );

    expect(token.length).toBeGreaterThan(40);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('resolves an active token to its user', async () => {
    const database = {
      withDatabase: jest.fn(
        (work: (database: TenantDatabase) => Promise<unknown>) =>
          work({
            query: jest.fn(() =>
              Promise.resolve({
                rows: [
                  {
                    id: 'user-1',
                    email: 'owner@example.com',
                    display_name: 'Owner',
                  },
                ],
              }),
            ),
          }),
      ),
    } as unknown as DatabaseService;
    const service = new SessionService(database);

    await expect(service.resolveUser('token')).resolves.toEqual({
      id: 'user-1',
      email: 'owner@example.com',
      displayName: 'Owner',
    });
  });

  it('returns null for missing tokens', async () => {
    const withDatabase = jest.fn();
    const database = {
      withDatabase,
    } as unknown as DatabaseService;
    const service = new SessionService(database);

    await expect(service.resolveUser('')).resolves.toBeNull();
    expect(withDatabase).not.toHaveBeenCalled();
  });
});
