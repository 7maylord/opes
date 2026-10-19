import { classifyAnomalies } from './anomaly-review.service';

describe('anomaly review', () => {
  it('explains deterministic signals without authorizing action', () => {
    const signals = classifyAnomalies(
      [
        {
          id: 'invoice',
          invoice_number: 'INV-1',
          vendor_id: 'vendor',
          vendor_name: 'Vendor',
          amount_atomic: '300',
          average_atomic: '100',
          sample_size: '3',
          month_count: '5',
          duplicate_count: '2',
          created_at: new Date(),
        },
      ],
      [],
    );
    expect(signals.map((item) => item.kind)).toEqual([
      'DUPLICATE',
      'AMOUNT',
      'FREQUENCY',
    ]);
    expect(signals.every((item) => item.severity === 'REVIEW')).toBe(true);
  });
});
