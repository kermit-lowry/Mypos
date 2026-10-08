/** All money is integer cents. These helpers keep rounding in one place. */

export function roundHalfUp(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/** Multiply cents by a basis-point rate (1% = 100 bps), rounding half-up. */
export function applyBps(cents: number, bps: number): number {
  return roundHalfUp((cents * bps) / 10_000);
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
