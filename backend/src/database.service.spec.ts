import { DatabaseService } from './database.service';
import { TenantContext } from './tenant-context';

describe('DatabaseService', () => {
  const context: TenantContext = {
    organizationId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    membershipId: '33333333-3333-3333-3333-333333333333',
    role: 'OWNER',
    agentId: '44444444-4444-4444-4444-444444444444',
    requestId: 'request-1',
  };

  it('sets tenant scope inside the transaction before running work', async () => {
    const queries: string[] = [];
    const client = {
      query: jest.fn((text: string) => {
        queries.push(text);
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    const service = new DatabaseService();
    Reflect.set(service, 'databaseUrl', 'postgresql://unused');
    Reflect.set(service, 'pool', {
      connect: jest.fn(() => Promise.resolve(client)),
      end: jest.fn(),
    });

    await service.withTenant(context, async (database) => {
      await database.query('SELECT 1');
    });

    expect(queries).toEqual([
      'BEGIN',
      "SELECT set_config('opes.organization_id', $1, true)",
      'SELECT 1',
      'COMMIT',
    ]);
    expect(client.query).toHaveBeenNthCalledWith(2, queries[1], [
      context.organizationId,
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the client when work fails', async () => {
    const client = {
      query: jest.fn(() => Promise.resolve({ rows: [] })),
      release: jest.fn(),
    };
    const service = new DatabaseService();
    Reflect.set(service, 'databaseUrl', 'postgresql://unused');
    Reflect.set(service, 'pool', {
      connect: jest.fn(() => Promise.resolve(client)),
      end: jest.fn(),
    });

    await expect(
      service.withTenant(context, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('runs global transactions without tenant scope', async () => {
    const queries: string[] = [];
    const client = {
      query: jest.fn((text: string) => {
        queries.push(text);
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    const service = new DatabaseService();
    Reflect.set(service, 'databaseUrl', 'postgresql://unused');
    Reflect.set(service, 'pool', {
      connect: jest.fn(() => Promise.resolve(client)),
      end: jest.fn(),
    });

    await service.withTransaction(async (database) => {
      await database.query('SELECT 1');
    });

    expect(queries).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects missing tenant identity before checking out a client', async () => {
    const service = new DatabaseService();
    Reflect.set(service, 'databaseUrl', 'postgresql://unused');

    await expect(
      service.withTenant({ ...context, organizationId: '' }, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('TenantContext.organizationId is required');
  });

  it('rejects empty organization scope before checking out a client', async () => {
    const service = new DatabaseService();

    await expect(
      service.withOrganizationScope('', () => Promise.resolve()),
    ).rejects.toThrow('organizationId is required');
  });
});
