export function formatAtomic(amountAtomic: string, decimals: number) {
  const value = BigInt(amountAtomic);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = value / base;
  const rawFraction = (value % base).toString().padStart(decimals, "0");
  const fraction = rawFraction.replace(/0+$/, "") || "0";
  return `${whole}.${fraction}`;
}

export function parseDecimalToAtomic(value: string, decimals: number) {
  const match = value.trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!match || (match[2]?.length ?? 0) > decimals) {
    throw new Error(`Enter a valid amount with up to ${decimals} decimal places`);
  }
  const base = BigInt(10) ** BigInt(decimals);
  const fraction = (match[2] ?? "").padEnd(decimals, "0");
  return (BigInt(match[1]) * base + BigInt(fraction || "0")).toString();
}
