import { applyBps } from "./money.js";

/**
 * Trade-in offer rules the owner sets (store default, per product type, or
 * per category). Offers work back from what the store expects to resell the
 * item for, keep the target margin, and lean on the market trend.
 */
export interface BuylistPolicyRule {
  /** Margin to keep on resale when paying cash: 4000 = pay 60% of resale. */
  cashMarginBps: number;
  /** Store credit is worth this much more than cash: 3000 = +30%. */
  creditBonusBps: number;
  /** Share of the 7-day market move to project forward: 5000 = half of it. */
  trendWeightBps: number;
  /** Most a rising market can lift an offer: 500 = +5%. */
  maxTrendUpBps: number;
  /** With this many already on hand, offer less... */
  overstockQty: number | null;
  /** ...by this much: 2000 = 20% less. */
  overstockCutBps: number;
  /** Don't buy things that resell for less than this (bulk). */
  minResaleCents: number;
}

export const DEFAULT_BUYLIST_POLICY: BuylistPolicyRule = {
  cashMarginBps: 5_000,
  creditBonusBps: 3_000,
  trendWeightBps: 5_000,
  maxTrendUpBps: 500,
  overstockQty: null,
  overstockCutBps: 2_000,
  minResaleCents: 100,
};

export type ResaleBasis = "MARKET" | "YOUR_PRICE" | "ENTERED";

export interface OfferInput {
  /** Store's price for this exact item (size/condition/grade), if stocked. */
  priceCents: number | null;
  /** Market price for this exact item, if there's a feed. */
  marketCents: number | null;
  /** Typed in at the counter (items not in the catalog). */
  enteredCents?: number | null;
  /** 7-day market change in bps. */
  trendBps: number | null;
  onHand: number;
}

export interface OfferSuggestion {
  accepted: boolean;
  cashCents: number;
  creditCents: number;
  basis: ResaleBasis | null;
  /** What we expect to resell it for. */
  resaleCents: number;
  /** Resale after projecting the trend. */
  projectedCents: number;
  /** Plain-language reasons, shown to the cashier. */
  notes: string[];
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export function suggestOffer(input: OfferInput, rule: BuylistPolicyRule = DEFAULT_BUYLIST_POLICY): OfferSuggestion {
  const notes: string[] = [];
  // Resell basis: buy conservatively, so take the lower of market and our price.
  let basis: ResaleBasis | null = null;
  let resale = 0;
  if (input.enteredCents != null && input.enteredCents > 0) {
    basis = "ENTERED";
    resale = input.enteredCents;
  } else if (input.marketCents != null && input.priceCents != null) {
    basis = input.marketCents <= input.priceCents ? "MARKET" : "YOUR_PRICE";
    resale = Math.min(input.marketCents, input.priceCents);
  } else if (input.marketCents != null) {
    basis = "MARKET";
    resale = input.marketCents;
  } else if (input.priceCents != null) {
    basis = "YOUR_PRICE";
    resale = input.priceCents;
  }
  if (!basis || resale <= 0) return { accepted: false, cashCents: 0, creditCents: 0, basis, resaleCents: 0, projectedCents: 0, notes: ["No price to work from: enter what it resells for"] };
  notes.push(`Resells for about ${money(resale)} (${basis === "MARKET" ? "market price" : basis === "YOUR_PRICE" ? "your price" : "entered"})`);

  if (resale < rule.minResaleCents) {
    return { accepted: false, cashCents: 0, creditCents: 0, basis, resaleCents: resale, projectedCents: resale, notes: [...notes, `Under the ${money(rule.minResaleCents)} minimum: bulk`] };
  }

  // Project the trend forward: falling markets lower the offer, rising ones lift it a little (capped).
  let projected = resale;
  if (input.trendBps != null && input.trendBps !== 0 && rule.trendWeightBps > 0) {
    let moveBps = Math.round((input.trendBps * rule.trendWeightBps) / 10_000);
    if (moveBps > rule.maxTrendUpBps) moveBps = rule.maxTrendUpBps;
    projected = Math.max(0, resale + applyBps(resale, moveBps));
    notes.push(`Market ${input.trendBps > 0 ? "up" : "down"} ${pct(Math.abs(input.trendBps))} this week: planning on ${money(projected)}`);
  }

  let cash = Math.floor((projected * (10_000 - rule.cashMarginBps)) / 10_000);
  notes.push(`Keeps a ${pct(rule.cashMarginBps)} margin`);
  if (rule.overstockQty != null && input.onHand >= rule.overstockQty) {
    cash = Math.floor((cash * (10_000 - rule.overstockCutBps)) / 10_000);
    notes.push(`${input.onHand} already in stock: ${pct(rule.overstockCutBps)} less`);
  }
  // Credit is worth more to the customer and costs the store less, but never more than resale.
  const credit = Math.min(projected, Math.floor((cash * (10_000 + rule.creditBonusBps)) / 10_000));
  return { accepted: cash > 0, cashCents: cash, creditCents: credit, basis, resaleCents: resale, projectedCents: projected, notes };
}
