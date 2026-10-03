import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { PaymentExecutionService } from './payment-execution.service';
import { TenantContext } from './tenant-context';

const context: TenantContext = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'OWNER',
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'request-1',
};

function serviceWithQuery(
  query: TenantDatabase['query'],
): PaymentExecutionService {
  const withTenant = jest.fn(
    (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return new PaymentExecutionService({
    withTenant,
  } as unknown as DatabaseService);
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    decision_id: '55555555-5555-5555-5555-555555555555',
    approval_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    source_version_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    derived_action: 'PAY',
    route_environment: 'arc-testnet',
    route_chain_id: 5042002,
    route_asset_symbol: 'USDC',
    amount_atomic: '12340001',
    destination_address: '0x0000000000000000000000000000000000000002',
    decision_context_hash: 'c'.repeat(64),
    approval_context_hash: 'c'.repeat(64),
    approval_amount_atomic: '12340001',
    approval_destination_address: '0x0000000000000000000000000000000000000002',
    decision_hash: `0x${'d'.repeat(64)}`,
    obligation_key: 'e'.repeat(64),
    checks: [{ status: 'PASS' }],
    decision_expires_at: new Date(Date.now() + 86_400_000),
    approval_expires_at: new Date(Date.now() + 86_400_000),
    vault_address: '0x0000000000000000000000000000000000000003',
    ...overrides,
  };
}

describe('PaymentExecutionService', () => {
  it('reserves an approved direct payment once and enqueues execution', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [candidate()] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'execution-1',
            decision_id: '55555555-5555-5555-5555-555555555555',
            approval_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            source_version_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            decision_hash: `0x${'d'.repeat(64)}`,
            idempotency_key: 'e'.repeat(64),
            context_hash: 'c'.repeat(64),
            amount_atomic: '12340001',
            destination_address: '0x0000000000000000000000000000000000000002',
            route_environment: 'arc-testnet',
            route_chain_id: 5042002,
            route_asset_symbol: 'USDC',
            vault_address: '0x0000000000000000000000000000000000000003',
            status: 'PENDING',
            failure_reason: null,
            transaction_hash: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithQuery(query);

    await expect(
      service.requestDecisionExecution(
        context,
        '55555555-5555-5555-5555-555555555555',
      ),
    ).resolves.toMatchObject({
      id: 'execution-1',
      decisionHash: `0x${'d'.repeat(64)}`,
      idempotencyKey: 'e'.repeat(64),
      status: 'PENDING',
    });
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO opes.payment_executions'),
      expect.arrayContaining([
        context.organizationId,
        '55555555-5555-5555-5555-555555555555',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        `0x${'d'.repeat(64)}`,
        'e'.repeat(64),
        'c'.repeat(64),
        '12340001',
        '0x0000000000000000000000000000000000000002',
        'arc-testnet',
        5042002,
        'USDC',
        '0x0000000000000000000000000000000000000003',
        expect.any(String),
        context.membershipId,
      ]),
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('payment.execute.direct.arc_testnet'),
      [context.organizationId, 'execution-1'],
    );
  });

  it('refuses mismatched approvals before reserving execution', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [candidate({ approval_amount_atomic: '12340002' })],
    });
    const service = serviceWithQuery(query);

    await expect(
      service.requestDecisionExecution(
        context,
        '55555555-5555-5555-5555-555555555555',
      ),
    ).rejects.toThrow(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('requires an approving role to request execution', async () => {
    const service = serviceWithQuery(jest.fn());

    await expect(
      service.requestDecisionExecution(
        { ...context, role: 'AUDITOR' },
        '55555555-5555-5555-5555-555555555555',
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
