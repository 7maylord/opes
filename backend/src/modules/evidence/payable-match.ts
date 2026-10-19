export interface MatchLine {
  description: string;
  quantityMicros: bigint;
  amountAtomic: bigint;
}

export interface MatchDocument {
  vendorId: string;
  currency: string;
  totalAmountAtomic: bigint;
  toleranceBps: number;
  status: string;
  lines: MatchLine[];
}

export interface MatchUsage {
  amountAtomic: bigint;
  lines: MatchLine[];
}

export function evaluatePayableMatch(input: {
  invoice: MatchDocument;
  governing: MatchDocument;
  delivery: MatchDocument;
  governingSourceId: string;
  deliveryGoverningSourceId: string | null;
  governingUsed: MatchUsage;
  deliveryUsed: MatchUsage;
  payoutAddressActive: boolean;
}): string[] {
  const reasons = new Set<string>();
  if (input.governing.status !== 'ACTIVE' || input.delivery.status !== 'ACTIVE')
    reasons.add('EVIDENCE_INACTIVE');
  if (
    input.invoice.vendorId !== input.governing.vendorId ||
    input.invoice.vendorId !== input.delivery.vendorId
  )
    reasons.add('VENDOR_MISMATCH');
  if (
    input.invoice.currency !== input.governing.currency ||
    input.invoice.currency !== input.delivery.currency
  )
    reasons.add('CURRENCY_MISMATCH');
  if (input.deliveryGoverningSourceId !== input.governingSourceId)
    reasons.add('DELIVERY_SOURCE_MISMATCH');
  if (!input.payoutAddressActive) reasons.add('PAYOUT_ADDRESS_CHANGED');

  checkCapacity(
    input.invoice,
    input.governing,
    input.governingUsed,
    'GOVERNING',
    reasons,
  );
  checkCapacity(
    input.invoice,
    input.delivery,
    input.deliveryUsed,
    'DELIVERY',
    reasons,
  );
  return [...reasons];
}

function checkCapacity(
  invoice: MatchDocument,
  evidence: MatchDocument,
  used: MatchUsage,
  prefix: string,
  reasons: Set<string>,
): void {
  if (
    used.amountAtomic + invoice.totalAmountAtomic >
    evidence.totalAmountAtomic
  )
    reasons.add(`${prefix}_TOTAL_EXCEEDED`);
  const evidenceLines = aggregate(evidence.lines);
  const usedLines = aggregate(used.lines);
  for (const line of aggregate(invoice.lines).values()) {
    const available = evidenceLines.get(key(line.description));
    if (!available) {
      reasons.add(`${prefix}_LINE_MISSING`);
      continue;
    }
    const consumed = usedLines.get(key(line.description));
    if (
      (consumed?.quantityMicros ?? 0n) + line.quantityMicros >
      available.quantityMicros
    )
      reasons.add(`${prefix}_QUANTITY_EXCEEDED`);
    const requested = (consumed?.amountAtomic ?? 0n) + line.amountAtomic;
    const tolerated =
      available.amountAtomic +
      (available.amountAtomic * BigInt(evidence.toleranceBps)) / 10_000n;
    if (requested > tolerated) reasons.add(`${prefix}_VALUE_EXCEEDED`);
  }
}

function aggregate(lines: MatchLine[]): Map<string, MatchLine> {
  const result = new Map<string, MatchLine>();
  for (const line of lines) {
    const normalized = key(line.description);
    const current = result.get(normalized);
    result.set(normalized, {
      description: line.description,
      quantityMicros: (current?.quantityMicros ?? 0n) + line.quantityMicros,
      amountAtomic: (current?.amountAtomic ?? 0n) + line.amountAtomic,
    });
  }
  return result;
}

function key(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
