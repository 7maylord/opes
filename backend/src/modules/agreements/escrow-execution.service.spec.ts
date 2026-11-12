import { DatabaseService } from '../../core/database/database.service';
import {
  EscrowExecutionService,
  escrowDecisionHash,
} from './escrow-execution.service';

describe('escrowDecisionHash', () => {
  it('binds funding approval to its tenant, escrow and agreement', () => {
    const args = [
      '11111111-1111-1111-1111-111111111111',
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      `0x${'33'.repeat(32)}`,
      `0x${'44'.repeat(32)}`,
      '0x5555555555555555555555555555555555555555',
      `0x${'66'.repeat(32)}`,
      '1000000',
      2_000_000_000,
    ] as const;
    const hash = escrowDecisionHash(...args);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(escrowDecisionHash(...args)).toBe(hash);
    expect(
      escrowDecisionHash(
        ...args.slice(0, 6),
        `0x${'77'.repeat(32)}`,
        ...args.slice(7),
      ),
    ).not.toBe(hash);
  });
});

describe('escrow agreement preparation', () => {
  it('reuses workspace controls and prepares one agreement signature', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'agreement-1',
            total_amount_atomic: '10000000',
            payout_address: '0x1111111111111111111111111111111111111111',
            vault_address: '0x2222222222222222222222222222222222222222',
            escrow_address: '0x3333333333333333333333333333333333333333',
            amounts: ['10000000'],
            titles: ['Delivery'],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ configured: true }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'action-1',
            organization_id: '11111111-1111-1111-1111-111111111111',
            action_type: 'CREATE_ESCROW_AGREEMENT',
            target_id: 'agreement-1',
            actor: 'OWNER',
            contract_address: '0x3333333333333333333333333333333333333333',
            call_data: '0x1234',
            idempotency_key: 'action-1',
            payload: {},
            status: 'PREPARED',
            provider_transaction_id: null,
          },
        ],
      });
    const database = {
      withTenant: jest.fn(
        (_: unknown, work: (db: { query: typeof query }) => unknown) =>
          work({ query }),
      ),
    } as unknown as DatabaseService;
    const service = new EscrowExecutionService(
      database,
      {} as never,
      {} as never,
    );

    const actions = await service.prepareAgreement(
      {
        organizationId: '11111111-1111-1111-1111-111111111111',
        membershipId: '22222222-2222-2222-2222-222222222222',
        userId: '33333333-3333-3333-3333-333333333333',
        role: 'OWNER',
        agentId: '44444444-4444-4444-4444-444444444444',
        requestId: 'test',
      },
      '44444444-4444-4444-4444-444444444444',
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.actionType).toBe('CREATE_ESCROW_AGREEMENT');
  });
});
