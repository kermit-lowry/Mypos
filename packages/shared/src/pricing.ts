import type { CardCondition } from "./enums.js";
import { applyBps, roundHalfUp } from "./money.js";

/** Default discount off NM market price by card condition, in bps of NM price. */
export const DEFAULT_CONDITION_BPS: Record<CardCondition, number> = {
  NM: 10_000,
  LP: 8_500,
  MP: 7_000,
  HP: 5_000,
  DMG: 3_000,
};

export type Rounding = "NONE" | "UP_TO_99" | "UP_TO_49_99" | "UP_TO_WHOLE";

export interface PriceRule {
  /** Sell price as bps of market (10_000 = 100% of market). */
  markupBps: number;
  rounding: Rounding;
  /** Never price below this (covers bulk/penny cards). */
  minCents: number;
}

export const DEFAULT_PRICE_RULE: PriceRule = { markupBps: 10_000, rounding: "UP_TO_99", minCents: 25 };

export function roundPrice(cents: number, rounding: Rounding): number {
  if (cents <= 0) return 0;
  switch (rounding) {
    case "NONE":
      return cents;
    case "UP_TO_WHOLE":
      return Math.ceil(cents / 100) * 100;
    case "UP_TO_99": {
      // 4.12 -> 4.99, 4.99 -> 4.99, 5.00 -> 5.99
      const dollars = Math.floor(cents / 100);
      return dollars * 100 + 99;
    }
    case "UP_TO_49_99": {
      const dollars = Math.floor(cents / 100);
      const rem = cents % 100;
      return dollars * 100 + (rem <= 49 ? 49 : 99);
    }
  }
}

/** Condition-adjusted market price for a single. */
export function conditionAdjusted(
  nmMarketCents: number,
  condition: CardCondition,
  table: Record<CardCondition, number> = DEFAULT_CONDITION_BPS,
): number {
  return applyBps(nmMarketCents, table[condition]);
}

export function sellPrice(marketCents: number, rule: PriceRule = DEFAULT_PRICE_RULE): number {
  const raw = applyBps(marketCents, rule.markupBps);
  return Math.max(rule.minCents, roundPrice(raw, rule.rounding));
}

export interface BuylistRule {
  /** Cash offer as bps of market. */
  cashBps: number;
  /** Store-credit offer as bps of market (usually higher than cash). */
  creditBps: number;
  /** Items whose market price is below this are not bought individually. */
  minMarketCents: number;
}

export const DEFAULT_BUYLIST_RULE: BuylistRule = { cashBps: 5_000, creditBps: 6_500, minMarketCents: 100 };

export function buylistOffer(
  marketCents: number,
  rule: BuylistRule = DEFAULT_BUYLIST_RULE,
): { cashCents: number; creditCents: number; accepted: boolean } {
  if (marketCents < rule.minMarketCents) return { cashCents: 0, creditCents: 0, accepted: false };
  // Round offers down to the cent we can actually pay; never round up against the store.
  return {
    cashCents: Math.floor((marketCents * rule.cashBps) / 10_000),
    creditCents: Math.floor((marketCents * rule.creditBps) / 10_000),
    accepted: true,
  };
}

export interface CartLineInput {
  unitPriceCents: number;
  quantity: number;
  discountCents?: number;
  taxable: boolean;
}

export interface CartTotals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * Totals for a cart. Tax is computed on the taxable discounted subtotal once
 * (not per line) so the register and the API always agree to the cent.
 */
export function cartTotals(lines: CartLineInput[], taxRateBps: number): CartTotals {
  let subtotal = 0;
  let discount = 0;
  let taxableBase = 0;
  for (const l of lines) {
    const gross = l.unitPriceCents * l.quantity;
    const disc = Math.min(l.discountCents ?? 0, gross);
    subtotal += gross;
    discount += disc;
    if (l.taxable) taxableBase += gross - disc;
  }
  const tax = roundHalfUp((taxableBase * taxRateBps) / 10_000);
  return { subtotalCents: subtotal, discountCents: discount, taxCents: tax, totalCents: subtotal - discount + tax };
}
