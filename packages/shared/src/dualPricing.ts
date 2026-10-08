import type { TenderType } from "./enums.js";
import { cartTotals, type CartLineInput, type CartTotals } from "./pricing.js";
import { roundHalfUp } from "./money.js";

/**
 * Dual pricing: every item has a cash price (what's stored) and a card price,
 * which is the cash price plus the merchant's configured percentage. Both are
 * shown to the customer on the display, the receipt, and the shelf label.
 */

/**
 * Cards always pay the card price and cash always pays the cash price. These
 * tenders pay the cash price unless the merchant opts them into card pricing.
 */
export const CONFIGURABLE_PRICED_TENDERS = ["GIFT_CARD", "STORE_CREDIT", "CHECK", "LOYALTY"] as const satisfies readonly TenderType[];
export type ConfigurablePricedTender = (typeof CONFIGURABLE_PRICED_TENDERS)[number];

/** Whether a tender pays the card price, given the location's opted-in tenders. */
export function isCardPriced(t: TenderType, cardPricedTenders: readonly string[] = []): boolean {
  if (t === "CARD") return true;
  return (CONFIGURABLE_PRICED_TENDERS as readonly string[]).includes(t) && cardPricedTenders.includes(t);
}

/** Card price for a cash amount. `bps` = 399 means card is 3.99% more. */
export function cardPrice(cashCents: number, bps: number): number {
  return roundHalfUp((cashCents * (10_000 + bps)) / 10_000);
}

export interface DualTotals {
  cash: CartTotals;
  card: CartTotals;
}

/** Totals at both prices. Card lines are priced per unit so the receipt's line prices add up. */
export function dualTotals(lines: CartLineInput[], taxRateBps: number, bps: number): DualTotals {
  const cash = cartTotals(lines, taxRateBps);
  if (bps <= 0) return { cash, card: cash };
  const card = cartTotals(
    lines.map((l) => ({
      ...l,
      unitPriceCents: cardPrice(l.unitPriceCents, bps),
      discountCents: l.discountCents ? cardPrice(l.discountCents, bps) : 0,
    })),
    taxRateBps,
  );
  return { cash, card };
}

/**
 * What card tenders must add up to, given what's already covered by
 * cash-priced tenders. Paying entirely by card costs exactly the card total;
 * a split prorates the card total over the share the card covers.
 */
export function cardAmountDue(t: DualTotals, cashPricedPaidCents: number): number {
  const remaining = t.cash.totalCents - cashPricedPaidCents;
  if (remaining <= 0) return 0;
  if (remaining === t.cash.totalCents) return t.card.totalCents;
  return roundHalfUp((remaining * t.card.totalCents) / t.cash.totalCents);
}

/**
 * The extra a card payment adds over the cash price, and how much of that
 * extra is sales tax (for tax reporting).
 */
export function cardAdjustment(t: DualTotals, cardPaidCents: number, cashPricedPaidCents: number): { adjustmentCents: number; taxCents: number } {
  const remaining = Math.max(0, t.cash.totalCents - cashPricedPaidCents);
  const adjustmentCents = Math.max(0, cardPaidCents - remaining);
  const fullAdj = t.card.totalCents - t.cash.totalCents;
  const fullTax = t.card.taxCents - t.cash.taxCents;
  const taxCents = fullAdj > 0 ? roundHalfUp((adjustmentCents * fullTax) / fullAdj) : 0;
  return { adjustmentCents, taxCents };
}

/** "3.99%" from bps. */
export const formatBps = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
