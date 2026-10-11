import { ConflictException } from '@nestjs/common';
import { DatabaseService, TenantDatabase } from './database.service';
import { LedgerService } from './ledger.service';
import { TenantContext } from './tenant-context';

const context: TenantContext = {
  organizationId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  membershipId: '33333333-3333-3333-3333-333333333333',
  role: 'OWNER',
  agentId: '44444444-4444-4444-4444-444444444444',
  requestId: 'request-1',
};

function serviceWithQuery(query: TenantDatabase['query']): LedgerService {
  const withTenant = jest.fn(
    (_context: TenantContext, work: (database: TenantDatabase) => unknown) =>
      work({ query }),
  );
  return new LedgerService({ withTenant } as unknown as DatabaseService);
}

function ledgerRows(eventType: string, eventId: string) {
  return [
    {
      id: 'line-1',
      ledger_event_type: eventType,
      ledger_event_id: eventId,
      line_number: 1,
      account:
        eventType === 'INVOICE_ACCEPTED'
          ? 'EXPENSE:PAYABLES'
          : 'LIABILITY:ACCOUNTS_PAYABLE',
      direction: 'DEBIT',
      asset_symbol: 'USDC',
      amount_atomic: '12340001',
      source_type:
        eventType === 'INVOICE_ACCEPTED'
          ? 'PAYABLE_OBLIGATION_VERSION'
          : 'PAYMENT_EXECUTION',
      source_id: '66666666-6666-6666-6666-666666666666',
      source_version_id: '55555555-5555-5555-5555-555555555555',
      counterparty_id: '77777777-7777-7777-7777-777777777777',
      transaction_hash:
        eventType === 'PAYMENT_SETTLED' ? `0x${'a'.repeat(64)}` : null,
    },
    {
      id: 'line-2',
      ledger_event_type: eventType,
      ledger_event_id: eventId,
      line_number: 2,
      account:
        eventType === 'INVOICE_ACCEPTED'
          ? 'LIABILITY:ACCOUNTS_PAYABLE'
          : 'ASSET:OPERATING_USDC',
      direction: 'CREDIT',
      asset_symbol: 'USDC',
      amount_atomic: '12340001',
      source_type:
        eventType === 'INVOICE_ACCEPTED'
          ? 'PAYABLE_OBLIGATION_VERSION'
          : 'PAYMENT_EXECUTION',
      source_id: '66666666-6666-6666-6666-666666666666',
      source_version_id: '55555555-5555-5555-5555-555555555555',
      counterparty_id: '77777777-7777-7777-7777-777777777777',
      transaction_hash:
        eventType === 'PAYMENT_SETTLED' ? `0x${'a'.repeat(64)}` : null,
    },
  ];
}

describe('LedgerService', () => {
  it('projects accepted invoice accrual as a balanced pair', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            version_id: '55555555-5555-5555-5555-555555555555',
            obligation_id: '66666666-6666-6666-6666-666666666666',
            vendor_id: '77777777-7777-7777-7777-777777777777',
            currency: 'USDC',
            amount_atomic: '12340001',
            status: 'ACCEPTED',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: ledgerRows(
          'INVOICE_ACCEPTED',
          '55555555-5555-5555-5555-555555555555',
        ),
      });
    const service = serviceWithQuery(query);

    await expect(
      service.projectInvoiceAccrual(
        context,
        '55555555-5555-5555-5555-555555555555',
      ),
    ).resolves.toMatchObject([
      {
        account: 'EXPENSE:PAYABLES',
        direction: 'DEBIT',
        amountAtomic: '12340001',
      },
      {
        account: 'LIABILITY:ACCOUNTS_PAYABLE',
        direction: 'CREDIT',
        amountAtomic: '12340001',
      },
    ]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO opes.ledger_entries'),
      expect.arrayContaining([
        context.organizationId,
        'INVOICE_ACCEPTED',
        '55555555-5555-5555-5555-555555555555',
        'EXPENSE:PAYABLES',
        '12340001',
        'PAYABLE_OBLIGATION_VERSION',
        '66666666-6666-6666-6666-666666666666',
        '55555555-5555-5555-5555-555555555555',
        '77777777-7777-7777-7777-777777777777',
        null,
        'LIABILITY:ACCOUNTS_PAYABLE',
      ]),
    );
  });

  it('projects confirmed payment settlement as liability debit and cash credit', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            execution_id: 'aaaaaaaa-1111-1111-1111-111111111111',
            decision_id: 'bbbbbbbb-1111-1111-1111-111111111111',
            source_version_id: '55555555-5555-5555-5555-555555555555',
            vendor_id: '77777777-7777-7777-7777-777777777777',
            route_asset_symbol: 'USDC',
            route_environment: 'arc-testnet',
            amount_atomic: '12340001',
            status: 'CONFIRMED',
            transaction_hash: `0x${'a'.repeat(64)}`,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: ledgerRows(
          'PAYMENT_SETTLED',
          'aaaaaaaa-1111-1111-1111-111111111111',
        ),
      });
    const service = serviceWithQuery(query);

    await expect(
      service.projectPaymentSettlement(
        context,
        'aaaaaaaa-1111-1111-1111-111111111111',
      ),
    ).resolves.toMatchObject([
      {
        account: 'LIABILITY:ACCOUNTS_PAYABLE',
        direction: 'DEBIT',
        transactionHash: `0x${'a'.repeat(64)}`,
      },
      { account: 'ASSET:OPERATING_USDC', direction: 'CREDIT' },
    ]);
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("SET status = 'PAID'"),
      [context.organizationId, '55555555-5555-5555-5555-555555555555'],
    );
  });

  it('refuses to settle pending payments', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          execution_id: 'aaaaaaaa-1111-1111-1111-111111111111',
          decision_id: 'bbbbbbbb-1111-1111-1111-111111111111',
          source_version_id: '55555555-5555-5555-5555-555555555555',
          vendor_id: '77777777-7777-7777-7777-777777777777',
          route_asset_symbol: 'USDC',
          route_environment: 'arc-testnet',
          amount_atomic: '12340001',
          status: 'SUBMITTED',
          transaction_hash: `0x${'a'.repeat(64)}`,
        },
      ],
    });
    const service = serviceWithQuery(query);

    await expect(
      service.projectPaymentSettlement(
        context,
        'aaaaaaaa-1111-1111-1111-111111111111',
      ),
    ).rejects.toThrow(ConflictException);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
