import { evaluatePayableMatch, MatchDocument } from './payable-match';

const invoice: MatchDocument = {
  vendorId: 'vendor-1',
  currency: 'USDC',
  totalAmountAtomic: 100n,
  toleranceBps: 0,
  status: 'ACTIVE',
  lines: [
    { description: 'Catering', quantityMicros: 2_000_000n, amountAtomic: 100n },
  ],
};

it('passes within remaining order and receipt capacity', () => {
  expect(
    evaluatePayableMatch({
      invoice,
      governing: { ...invoice, totalAmountAtomic: 200n },
      delivery: { ...invoice, totalAmountAtomic: 200n },
      governingSourceId: 'po-1',
      deliveryGoverningSourceId: 'po-1',
      governingUsed: { amountAtomic: 50n, lines: [] },
      deliveryUsed: { amountAtomic: 50n, lines: [] },
      payoutAddressActive: true,
    }),
  ).toEqual([]);
});

it('returns typed blockers for cumulative, quantity and authority conflicts', () => {
  expect(
    evaluatePayableMatch({
      invoice,
      governing: { ...invoice, vendorId: 'vendor-2', totalAmountAtomic: 150n },
      delivery: { ...invoice, status: 'REVOKED', totalAmountAtomic: 150n },
      governingSourceId: 'po-1',
      deliveryGoverningSourceId: 'po-2',
      governingUsed: {
        amountAtomic: 100n,
        lines: [{ ...invoice.lines[0], quantityMicros: 1n }],
      },
      deliveryUsed: {
        amountAtomic: 100n,
        lines: [{ ...invoice.lines[0], amountAtomic: 100n }],
      },
      payoutAddressActive: false,
    }),
  ).toEqual(
    expect.arrayContaining([
      'EVIDENCE_INACTIVE',
      'VENDOR_MISMATCH',
      'DELIVERY_SOURCE_MISMATCH',
      'PAYOUT_ADDRESS_CHANGED',
      'GOVERNING_TOTAL_EXCEEDED',
      'GOVERNING_QUANTITY_EXCEEDED',
      'DELIVERY_TOTAL_EXCEEDED',
      'DELIVERY_VALUE_EXCEEDED',
    ]),
  );
});
