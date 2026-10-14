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
    obligation_status: 'ACCEPTED',
    source_version_status: 'ACCEPTED',
    has_evidence_match: true,
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
      expect.stringContaining('SELECT $1, $3'),
      [
        context.organizationId,
        'execution-1',
        'payment.execute.direct.arc_testnet',
      ],
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

  it('reserves confirmed Base liquidity once for an approved payout', async () => {
    const liquidityActionId = '66666666-6666-4666-8666-666666666666';
    const crosschain = candidate({
      route_environment: 'base-sepolia',
      route_chain_id: 84532,
      vault_address: null,
      destination_wallet_id: 'base-wallet-1',
      destination_wallet_address: '0x0000000000000000000000000000000000000004',
      liquidity_action_id: liquidityActionId,
      max_source_debit_atomic: '25000000',
    });
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [crosschain] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'execution-2',
            decision_id: crosschain.decision_id,
            approval_id: crosschain.approval_id,
            source_version_id: crosschain.source_version_id,
            decision_hash: crosschain.decision_hash,
            idempotency_key: crosschain.obligation_key,
            context_hash: crosschain.decision_context_hash,
            amount_atomic: crosschain.amount_atomic,
            destination_address: crosschain.destination_address,
            route_environment: crosschain.route_environment,
            route_chain_id: crosschain.route_chain_id,
            route_asset_symbol: 'USDC',
            vault_address: null,
            execution_mode: 'CROSSCHAIN_WALLET',
            liquidity_action_id: liquidityActionId,
            token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            max_source_debit_atomic: '25000000',
            refund_address: '0x0000000000000000000000000000000000000004',
            status: 'PENDING',
            failure_reason: null,
            transaction_hash: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithQuery(query);

    await expect(
      service.requestDecisionExecution(context, crosschain.decision_id),
    ).resolves.toMatchObject({
      executionMode: 'CROSSCHAIN_WALLET',
      liquidityActionId,
      maxSourceDebitAtomic: '25000000',
    });
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.arrayContaining([
        'CROSSCHAIN_WALLET',
        liquidityActionId,
        '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        '25000000',
      ]),
    );
    expect(query).toHaveBeenNthCalledWith(3, expect.any(String), [
      context.organizationId,
      'execution-2',
      'payment.execute.crosschain',
    ]);
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
