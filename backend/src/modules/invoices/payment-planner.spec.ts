import { planPayment } from './payment-planner';

const operating = {
  liquidityRoute: 'OPERATING' as const,
  environment: 'arc-testnet',
  chainId: 5042002,
  assetSymbol: 'USDC',
  feeAtomic: '20',
  availableAtomic: '1000',
  finalitySeconds: 10,
  providerAvailable: true,
};

it('changes time and route when due date, discount, liquidity, or cost changes', () => {
  const now = new Date('2026-10-15T00:00:00.000Z');
  const delayed = planPayment({
    amountAtomic: '500',
    dueAt: new Date('2026-10-20T00:00:00.000Z'),
    now,
    quotes: [operating],
  });
  expect(delayed).toMatchObject({
    action: 'DELAY',
    proposedExecutionAt: '2026-10-19T00:00:00.000Z',
  });

  const discounted = planPayment({
    amountAtomic: '500',
    dueAt: new Date('2026-10-20T00:00:00.000Z'),
    now,
    discountAtomic: '100',
    discountDeadline: new Date('2026-10-16T00:00:00.000Z'),
    quotes: [operating],
  });
  expect(discounted.action).toBe('PAY');

  const routed = planPayment({
    amountAtomic: '500',
    dueAt: null,
    now,
    quotes: [
      { ...operating, availableAtomic: '100' },
      {
        ...operating,
        liquidityRoute: 'CCTP',
        environment: 'base-sepolia',
        chainId: 84532,
        feeAtomic: '30',
      },
    ],
  });
  expect(routed.route).toMatchObject({ liquidityRoute: 'CCTP' });
});
