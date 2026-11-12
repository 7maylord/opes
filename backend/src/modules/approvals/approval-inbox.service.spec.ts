import {
  DatabaseService,
  TenantDatabase,
} from '../../core/database/database.service';
import { TenantContext } from '../../core/database/tenant-context';
import { ApprovalInboxService } from './approval-inbox.service';

const context: TenantContext = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'APPROVER',
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'approval-test',
};

it('exposes exact authority and blocks expired approval actions', async () => {
  const query = jest.fn().mockResolvedValue({
    rows: [
      {
        id: 'active',
        kind: 'MILESTONE',
        title: 'Accept milestone',
        reason: 'Review evidence',
        amount_atomic: '1000000',
        asset_symbol: 'USDC',
        expires_at: null,
        requested_at: new Date('2030-01-01'),
        action_view: 'agreements',
        related_record_id: 'agreement',
      },
      {
        id: 'expired',
        kind: 'PAYMENT_LIMIT',
        title: 'Approve invoice',
        reason: 'Over limit',
        amount_atomic: '2000000',
        asset_symbol: 'USDC',
        expires_at: new Date('2020-01-01'),
        requested_at: new Date('2020-01-01'),
        action_view: 'invoices',
        related_record_id: 'invoice',
      },
    ],
  });
  const database = {
    withTenant: jest.fn(
      (_context: TenantContext, work: (client: TenantDatabase) => unknown) =>
        work({ query } as TenantDatabase),
    ),
  } as unknown as DatabaseService;
  const result = await new ApprovalInboxService(database).list(context);
  expect(result.summary).toEqual({ total: 2, actionable: 1, expiring: 1 });
  expect(result.items[0]).toMatchObject({
    canAct: true,
    requiredRoles: ['OWNER', 'ADMIN', 'APPROVER'],
  });
  expect(result.items[1]).toMatchObject({ canAct: false, status: 'EXPIRED' });
});
