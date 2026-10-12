import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { WorkspaceService } from './workspace.service';

const context = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'OWNER' as const,
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'request-1',
};

describe('WorkspaceService', () => {
  it('lists tenant-scoped records with a stable next cursor', async () => {
    let capturedValues: readonly unknown[] | undefined;
    const query = jest.fn((_sql: string, values?: readonly unknown[]) => {
      capturedValues = values;
      return Promise.resolve({
        rows: [
          row(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '2026-10-12T10:00:00.000Z',
          ),
          row(
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            '2026-10-12T09:00:00.000Z',
          ),
        ],
      });
    });
    const database = {
      withTenant: jest.fn(
        (
          _context: unknown,
          work: (sql: { query: typeof query }) => Promise<unknown>,
        ) => work({ query }),
      ),
    };
    const service = new WorkspaceService(
      database as unknown as DatabaseService,
    );

    const result = await service.list(context, 'vendor', { limit: '1' });

    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).not.toBeNull();
    expect(database.withTenant).toHaveBeenCalledWith(
      context,
      expect.any(Function),
    );
    expect(capturedValues).toEqual([
      context.organizationId,
      'vendor',
      null,
      null,
      null,
      null,
      2,
    ]);
  });

  it('rejects unsupported record types before accessing the database', async () => {
    const database = { withTenant: jest.fn() };
    const service = new WorkspaceService(
      database as unknown as DatabaseService,
    );
    await expect(service.list(context, 'secret', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(database.withTenant).not.toHaveBeenCalled();
  });
});

function row(id: string, createdAt: string) {
  return {
    id,
    kind: 'vendor',
    title: 'Acme',
    subtitle: 'Vendor',
    status: 'VERIFIED',
    amount_atomic: null,
    asset_symbol: null,
    chain_id: null,
    transaction_hash: null,
    created_at: new Date(createdAt),
    updated_at: new Date(createdAt),
    details: {},
  };
}
