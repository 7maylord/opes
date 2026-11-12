import { calculateAvailableLiquidity } from './treasury-position';

it('subtracts restricted, reserved, unsettled and buffer then applies budget', () => {
  expect(
    calculateAvailableLiquidity({
      verified: 1_000n,
      restricted: 100n,
      reserved: 200n,
      approvedUnsettled: 100n,
      operatingBuffer: 100n,
      monthlyBudget: 600n,
      monthlySettled: 250n,
      monthlyReserved: 50n,
    }),
  ).toEqual({ cashAvailable: 500n, budgetRemaining: 300n, available: 300n });
});

it('never reports negative available liquidity', () => {
  expect(
    calculateAvailableLiquidity({
      verified: 10n,
      restricted: 20n,
      reserved: 0n,
      approvedUnsettled: 0n,
      operatingBuffer: 0n,
      monthlyBudget: null,
      monthlySettled: 0n,
      monthlyReserved: 0n,
    }).available,
  ).toBe(0n);
});
