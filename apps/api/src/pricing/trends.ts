import { changeBps, type MarketTrend } from "@mypos/shared";
import type { Db } from "../db.js";

const DAY = 86_400_000;
const MIN_SPAN_MS = 12 * 3_600_000;

/**
 * Market price and its change over the last `days` for each variant. The
 * baseline is the latest feed pull at or before the start of the window; if
 * history doesn't go back that far yet, the oldest pull we have (and `days`
 * says how long that really covers).
 */
export async function marketTrends(db: Db, variantIds: string[], days = 7, now = new Date()): Promise<Map<string, MarketTrend>> {
  const out = new Map<string, MarketTrend>();
  if (variantIds.length === 0) return out;
  const cutoff = new Date(now.getTime() - days * DAY);
  type Row = { variantId: string; marketCents: number; capturedAt: Date };
  const [variants, before, after] = await Promise.all([
    db.variant.findMany({ where: { id: { in: variantIds } }, select: { id: true, marketCents: true, marketSource: true, marketAt: true } }),
    db.$queryRaw<Row[]>`
      SELECT DISTINCT ON ("variantId") "variantId", "marketCents", "capturedAt" FROM "PricePoint"
      WHERE "variantId" = ANY(${variantIds}) AND "capturedAt" <= ${cutoff}
      ORDER BY "variantId", "capturedAt" DESC`,
    db.$queryRaw<Row[]>`
      SELECT DISTINCT ON ("variantId") "variantId", "marketCents", "capturedAt" FROM "PricePoint"
      WHERE "variantId" = ANY(${variantIds}) AND "capturedAt" > ${cutoff}
      ORDER BY "variantId", "capturedAt" ASC`,
  ]);
  const baseBefore = new Map(before.map((r) => [r.variantId, r]));
  const baseAfter = new Map(after.map((r) => [r.variantId, r]));
  for (const v of variants) {
    const base = baseBefore.get(v.id) ?? baseAfter.get(v.id);
    // A trend needs a baseline meaningfully older than the latest price (not the same pull).
    const latestAt = (v.marketAt ?? now).getTime();
    const usable = v.marketCents !== null && base && base.capturedAt.getTime() <= latestAt - MIN_SPAN_MS;
    out.set(v.id, {
      marketCents: v.marketCents,
      fromCents: usable ? base!.marketCents : null,
      changeBps: usable ? changeBps(base!.marketCents, v.marketCents!) : null,
      days: usable ? Math.max(1, Math.min(days, Math.round((now.getTime() - base!.capturedAt.getTime()) / DAY))) : days,
      source: v.marketSource,
      asOf: v.marketAt?.toISOString() ?? null,
    });
  }
  return out;
}

/** Add `market` (price + 7-day trend) to each variant in a list of products. */
export async function withMarket<P extends { variants: { id: string }[] }>(db: Db, products: P[]) {
  const trends = await marketTrends(db, products.flatMap((p) => p.variants.map((v) => v.id)));
  return products.map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, market: trends.get(v.id) ?? null })) }));
}
