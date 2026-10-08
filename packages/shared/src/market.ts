/** Market price movement for an item, from price-feed history. */
export interface MarketTrend {
  /** Latest market price, or null when the item has no price feed. */
  marketCents: number | null;
  /** Market price at the start of the window. */
  fromCents: number | null;
  /** Change over the window in bps (1234 = +12.34%); null without enough history. */
  changeBps: number | null;
  /** Days the change covers: 7 normally, fewer while history is still building. */
  days: number;
  source: string | null;
  asOf: string | null;
}

export function changeBps(fromCents: number, toCents: number): number | null {
  if (fromCents <= 0) return null;
  return Math.round(((toCents - fromCents) * 10_000) / fromCents);
}

/** "▲ 12.3%", "▼ 4.0%", "— 0.0%". */
export function formatTrend(bps: number | null): string {
  if (bps === null) return "";
  const pct = (Math.abs(bps) / 100).toFixed(1);
  return bps > 0 ? `▲ ${pct}%` : bps < 0 ? `▼ ${pct}%` : `— ${pct}%`;
}
