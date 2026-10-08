import { describe, expect, it } from "vitest";
import { buylistOffer, cartTotals, conditionAdjusted, roundPrice, sellPrice } from "./pricing.js";

describe("roundPrice", () => {
  it("rounds up to .99", () => {
    expect(roundPrice(412, "UP_TO_99")).toBe(499);
    expect(roundPrice(499, "UP_TO_99")).toBe(499);
    expect(roundPrice(500, "UP_TO_99")).toBe(599);
  });
  it("rounds to .49/.99", () => {
    expect(roundPrice(412, "UP_TO_49_99")).toBe(449);
    expect(roundPrice(450, "UP_TO_49_99")).toBe(499);
  });
  it("rounds to whole dollar", () => {
    expect(roundPrice(401, "UP_TO_WHOLE")).toBe(500);
    expect(roundPrice(400, "UP_TO_WHOLE")).toBe(400);
  });
});

describe("sellPrice", () => {
  it("applies markup, rounding, and floor", () => {
    expect(sellPrice(1000, { markupBps: 11_000, rounding: "UP_TO_99", minCents: 25 })).toBe(1199);
    expect(sellPrice(3, { markupBps: 10_000, rounding: "NONE", minCents: 25 })).toBe(25);
  });
});

describe("conditionAdjusted", () => {
  it("discounts by condition", () => {
    expect(conditionAdjusted(1000, "NM")).toBe(1000);
    expect(conditionAdjusted(1000, "LP")).toBe(850);
    expect(conditionAdjusted(1000, "HP")).toBe(500);
  });
});

describe("buylistOffer", () => {
  it("offers cash and credit, rounding down", () => {
    expect(buylistOffer(1001)).toEqual({ cashCents: 500, creditCents: 650, accepted: true });
  });
  it("rejects bulk below threshold", () => {
    expect(buylistOffer(50).accepted).toBe(false);
  });
});

describe("cartTotals", () => {
  it("taxes only taxable lines after discount", () => {
    const t = cartTotals(
      [
        { unitPriceCents: 1000, quantity: 2, discountCents: 200, taxable: true },
        { unitPriceCents: 500, quantity: 1, taxable: false },
      ],
      825,
    );
    expect(t).toEqual({ subtotalCents: 2500, discountCents: 200, taxCents: 149, totalCents: 2449 });
  });
});
