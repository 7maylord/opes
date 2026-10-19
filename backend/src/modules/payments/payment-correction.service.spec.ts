import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentCorrectionService } from './payment-correction.service';

describe('payment corrections', () => {
  const context = {
    organizationId: '11111111-1111-4111-8111-111111111111',
    membershipId: '22222222-2222-4222-8222-222222222222',
    role: 'OWNER',
  } as never;
  it('posts a balanced credit-note pair linked to a confirmed payment', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            amount_atomic: '100',
            vendor_id: '44444444-4444-4444-8444-444444444444',
            route_asset_symbol: 'USDC',
            route_environment: 'arc-testnet',
            transaction_hash: `0x${'a'.repeat(64)}`,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            correction_type: 'CREDIT_NOTE',
            original_execution_id: '33333333-3333-4333-8333-333333333333',
            credit_note_id: null,
            amount_atomic: '50',
            reason: 'Duplicate charge',
            transaction_hash: null,
            status: 'POSTED',
            created_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const service = new PaymentCorrectionService({
      withTenant: (_context: unknown, work: (db: unknown) => unknown) =>
        work({ query }),
    } as never);
    await expect(
      service.create(context, {
        type: 'CREDIT_NOTE',
        executionId: '33333333-3333-4333-8333-333333333333',
        amountAtomic: '50',
        reason: 'Duplicate charge',
      }),
    ).resolves.toMatchObject({ type: 'CREDIT_NOTE', amountAtomic: '50' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ledger_entries'),
      expect.any(Array),
    );
  });
  it('rejects an unproven refund', async () => {
    const service = new PaymentCorrectionService({} as never);
    await expect(
      service.create(context, {
        type: 'REFUND',
        executionId: '33333333-3333-4333-8333-333333333333',
        creditNoteId: '55555555-5555-4555-8555-555555555555',
        amountAtomic: '50',
        reason: 'Refund',
        transactionHash: 'bad',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects credit beyond the original payment', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            amount_atomic: '100',
            vendor_id: '44444444-4444-4444-8444-444444444444',
            route_asset_symbol: 'USDC',
            route_environment: 'arc-testnet',
            transaction_hash: `0x${'a'.repeat(64)}`,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: '75' }] });
    const service = new PaymentCorrectionService({
      withTenant: (_context: unknown, work: (db: unknown) => unknown) =>
        work({ query }),
    } as never);
    await expect(
      service.create(context, {
        type: 'CREDIT_NOTE',
        executionId: '33333333-3333-4333-8333-333333333333',
        amountAtomic: '50',
        reason: 'Excess credit',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
