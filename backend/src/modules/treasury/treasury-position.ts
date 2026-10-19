export interface TreasuryAmounts {
  verified: bigint;
  restricted: bigint;
  reserved: bigint;
  approvedUnsettled: bigint;
  operatingBuffer: bigint;
  monthlyBudget: bigint | null;
  monthlySettled: bigint;
  monthlyReserved: bigint;
}

export function calculateAvailableLiquidity(input: TreasuryAmounts): {
  cashAvailable: bigint;
  budgetRemaining: bigint | null;
  available: bigint;
} {
  const cashAvailable = floor(
    input.verified -
      input.restricted -
      input.reserved -
      input.approvedUnsettled -
      input.operatingBuffer,
  );
  const budgetRemaining =
    input.monthlyBudget === null
      ? null
      : floor(
          input.monthlyBudget - input.monthlySettled - input.monthlyReserved,
        );
  return {
    cashAvailable,
    budgetRemaining,
    available:
      budgetRemaining === null || cashAvailable < budgetRemaining
        ? cashAvailable
        : budgetRemaining,
  };
}

function floor(value: bigint): bigint {
  return value > 0n ? value : 0n;
}
