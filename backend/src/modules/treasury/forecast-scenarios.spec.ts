import { PaymentCalendarService } from './payment-calendar.service';

describe('forecast scenarios', () => {
  it('keeps scenarios advisory and deterministic', async () => {
    const service = new PaymentCalendarService({} as never, {} as never);
    jest.spyOn(service, 'get').mockResolvedValue({
      from: '2026-10-19',
      to: '2027-01-17',
      snapshotStatus: 'FRESH',
      startingOperatingAvailableAtomic: '15000000',
      projectedOperatingAvailableAtomic: '5000000',
      scheduledOperatingSpendAtomic: '10000000',
      uncoveredAtomic: '0',
      items: [
        {
          id: 'invoice:1',
          kind: 'INVOICE',
          title: 'Invoice',
          counterparty: 'Vendor',
          amountAtomic: '10000000',
          assetSymbol: 'USDC',
          scheduledFor: '2026-10-25T00:00:00.000Z',
          status: 'PAY',
          explanation: '',
          actionView: 'invoices',
          relatedRecordId: '1',
          affectsOperatingBalance: true,
          projectedOperatingAvailableAtomic: null,
          dueAt: '2026-10-31T00:00:00.000Z',
          policyScheduledAt: '2026-10-25T00:00:00.000Z',
        },
      ],
    });
    const result = await service.getScenarios({} as never);
    expect(result.authoritative).toBe(false);
    expect(result.scenarios.map((item) => item.lastPaymentAt)).toEqual([
      '2026-10-19T00:00:00.000Z',
      '2026-10-31T00:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
    ]);
  });
});
