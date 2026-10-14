import { BadRequestException } from '@nestjs/common';
import { evaluatePaymentRoute } from './liquidity-policy';

export interface PaymentRouteQuote {
  liquidityRoute: 'OPERATING' | 'GATEWAY' | 'CCTP';
  environment: string;
  chainId: number;
  assetSymbol: string;
  feeAtomic: string;
  availableAtomic: string;
  finalitySeconds: number;
  providerAvailable: boolean;
}

export function planPayment(input: {
  amountAtomic: string;
  dueAt: Date | null;
  now: Date;
  quotes: PaymentRouteQuote[];
  discountAtomic?: string;
  discountDeadline?: Date | null;
}) {
  const amount = atomic(input.amountAtomic, 'amountAtomic');
  const viable = input.quotes
    .map((quote) => {
      if (
        !Number.isInteger(quote.finalitySeconds) ||
        quote.finalitySeconds < 0 ||
        typeof quote.providerAvailable !== 'boolean'
      )
        throw new BadRequestException('route quote is invalid');
      return { ...quote, fee: atomic(quote.feeAtomic, 'feeAtomic', true) };
    })
    .filter(
      (quote) =>
        quote.providerAvailable &&
        evaluatePaymentRoute(quote).executable &&
        atomic(quote.availableAtomic, 'availableAtomic', true) >= amount,
    )
    .sort((a, b) =>
      a.fee === b.fee
        ? a.finalitySeconds - b.finalitySeconds
        : a.fee < b.fee
          ? -1
          : 1,
    );
  const selected = viable[0];
  if (!selected)
    return {
      action: 'ESCALATE' as const,
      proposedExecutionAt: null,
      route: null,
      reason:
        'No supported route has known provider availability and sufficient liquidity',
    };

  const discount = input.discountAtomic
    ? atomic(input.discountAtomic, 'discountAtomic', true)
    : 0n;
  const capturesDiscount =
    discount > selected.fee &&
    input.discountDeadline !== null &&
    input.discountDeadline !== undefined &&
    input.discountDeadline.getTime() > input.now.getTime();
  const duePlan = input.dueAt
    ? new Date(input.dueAt.getTime() - 24 * 60 * 60 * 1000)
    : input.now;
  const executionAt =
    capturesDiscount || duePlan <= input.now ? input.now : duePlan;
  return {
    action: executionAt <= input.now ? ('PAY' as const) : ('DELAY' as const),
    proposedExecutionAt: executionAt.toISOString(),
    route: {
      liquidityRoute: selected.liquidityRoute,
      environment: selected.environment,
      chainId: selected.chainId,
      assetSymbol: selected.assetSymbol.toUpperCase(),
      feeAtomic: selected.feeAtomic,
      finalitySeconds: selected.finalitySeconds,
    },
    reason: capturesDiscount
      ? 'Pay now because the verified discount exceeds route cost'
      : executionAt <= input.now
        ? 'Pay now because the invoice is due or has no due date'
        : 'Schedule payment one day before the due date',
  };
}

function atomic(value: string, name: string, zero = false): bigint {
  if (!/^\d+$/.test(value) || (!zero && BigInt(value) === 0n))
    throw new BadRequestException(`${name} must be atomic digits`);
  return BigInt(value);
}
