import { describe, expect, it } from "vitest";
import { DEFAULT_BUYLIST_POLICY, suggestOffer } from "./buylist.js";

const rule = { ...DEFAULT_BUYLIST_POLICY, cashMarginBps: 4000, creditBonusBps: 2500 };

describe("suggestOffer", () => {
  it("works back from resale price and target margin", () => {
    const s = suggestOffer({ priceCents: 10_000, marketCents: null, trendBps: null, onHand: 0 }, rule);
    expect(s).toMatchObject({ accepted: true, basis: "YOUR_PRICE", cashCents: 6000, creditCents: 7500 });
  });

  it("uses the lower of market and your price", () => {
    expect(suggestOffer({ priceCents: 10_000, marketCents: 9_000, trendBps: null, onHand: 0 }, rule)).toMatchObject({ basis: "MARKET", resaleCents: 9_000, cashCents: 5400 });
  });

  it("lowers offers in a falling market and caps the lift in a rising one", () => {
    // down 20% with 50% weight -> plan on 10% lower
    expect(suggestOffer({ priceCents: null, marketCents: 10_000, trendBps: -2000, onHand: 0 }, rule)).toMatchObject({ projectedCents: 9000, cashCents: 5400 });
    // up 30% -> +15% wanted, capped at +5%
    expect(suggestOffer({ priceCents: null, marketCents: 10_000, trendBps: 3000, onHand: 0 }, rule)).toMatchObject({ projectedCents: 10_500, cashCents: 6300 });
  });

  it("offers less when overstocked and passes on bulk", () => {
    const over = suggestOffer({ priceCents: 10_000, marketCents: null, trendBps: null, onHand: 6 }, { ...rule, overstockQty: 5 });
    expect(over.cashCents).toBe(4800);
    expect(over.notes.join(" ")).toContain("6 already in stock");
    expect(suggestOffer({ priceCents: 50, marketCents: null, trendBps: null, onHand: 0 }, rule).accepted).toBe(false);
  });

  it("never offers more credit than it resells for", () => {
    expect(suggestOffer({ priceCents: 1000, marketCents: null, trendBps: null, onHand: 0 }, { ...rule, cashMarginBps: 1000, creditBonusBps: 5000 }).creditCents).toBe(1000);
  });

  it("explains itself", () => {
    const s = suggestOffer({ priceCents: null, marketCents: 10_000, trendBps: -1000, onHand: 0 }, rule);
    expect(s.notes).toEqual(["Resells for about $100.00 (market price)", "Market down 10% this week: planning on $95.00", "Keeps a 40% margin"]);
  });
});
