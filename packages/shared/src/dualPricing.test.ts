import { describe, expect, it } from "vitest";
import { cardAdjustment, cardAmountDue, cardPrice, dualTotals, formatBps } from "./dualPricing.js";

describe("dual pricing", () => {
  it("derives card prices from cash prices", () => {
    expect(cardPrice(1000, 400)).toBe(1040);
    expect(cardPrice(999, 399)).toBe(1039); // 1038.86 -> 1039
    expect(cardPrice(1000, 0)).toBe(1000);
  });

  it("computes both totals with tax on each price", () => {
    const t = dualTotals([{ unitPriceCents: 1000, quantity: 2, taxable: true }], 825, 400);
    expect(t.cash).toMatchObject({ subtotalCents: 2000, taxCents: 165, totalCents: 2165 });
    expect(t.card).toMatchObject({ subtotalCents: 2080, taxCents: 172, totalCents: 2252 });
  });

  it("is a no-op when disabled", () => {
    const t = dualTotals([{ unitPriceCents: 1000, quantity: 1, taxable: true }], 825, 0);
    expect(t.card).toEqual(t.cash);
  });

  it("charges the full card total when paying entirely by card", () => {
    const t = dualTotals([{ unitPriceCents: 1000, quantity: 2, taxable: true }], 825, 400);
    expect(cardAmountDue(t, 0)).toBe(2252);
    expect(cardAdjustment(t, 2252, 0)).toEqual({ adjustmentCents: 87, taxCents: 7 });
  });

  it("prorates a split between cash and card", () => {
    const t = dualTotals([{ unitPriceCents: 1000, quantity: 2, taxable: true }], 825, 400);
    // $10 cash leaves $11.65 at cash price; on card that's 11.65 x 2252/2165
    expect(cardAmountDue(t, 1000)).toBe(1212);
    expect(cardAdjustment(t, 1212, 1000)).toEqual({ adjustmentCents: 47, taxCents: 4 });
    expect(cardAmountDue(t, 2165)).toBe(0);
  });

  it("formats the percentage", () => {
    expect(formatBps(399)).toBe("3.99%");
    expect(formatBps(400)).toBe("4%");
  });
});
