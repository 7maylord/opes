export function formatAtomic(amountAtomic: string, decimals: number) {
  const value = BigInt(amountAtomic);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = value / base;
  const rawFraction = (value % base).toString().padStart(decimals, "0");
  const fraction = rawFraction.replace(/0+$/, "") || "0";
  return `${whole}.${fraction}`;
}
