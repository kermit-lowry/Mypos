import { describe, expect, it } from "vitest";
import { applyRewards, earnFor, eligibleSpend, RewardNotApplicable, type LoyaltyLine, type LoyaltyProgramConfig } from "./loyalty.js";

const lines: LoyaltyLine[] = [
  { variantId: "card", productId: "p-card", kind: "TCG_SINGLE", unitPriceCents: 1000, quantity: 2, discountCents: 0 },
  { variantId: "pack", productId: "p-pack", kind: "TCG_SEALED", unitPriceCents: 500, quantity: 1, discountCents: 0 },
  { variantId: "fnm", productId: "p-fnm", kind: "EVENT_ENTRY", unitPriceCents: 1500, quantity: 1, discountCents: 0 },
];
const program: LoyaltyProgramConfig = {
  enabled: true,
  type: "POINTS",
  cashbackBps: 200,
  pointsPerDollar: 1,
  excludedKinds: ["EVENT_ENTRY"],
  earnOnCredit: false,
};

describe("applyRewards", () => {
  it("takes a percentage off eligible lines only", () => {
    // 10% of $25 eligible = $2.50, split 2000:500
    expect(applyRewards(lines, [{ id: "r", type: "PERCENT_OFF", pointsCost: 100, percentBps: 1000 }], program)).toEqual([200, 50, 0]);
  });
  it("caps percentage rewards", () => {
    const d = applyRewards(lines, [{ id: "r", type: "PERCENT_OFF", pointsCost: 100, percentBps: 5000, maxDiscountCents: 300 }], program);
    expect(d.reduce((a, b) => a + b, 0)).toBe(300);
  });
  it("takes dollars off without exceeding the cart", () => {
    const d = applyRewards(lines, [{ id: "r", type: "AMOUNT_OFF", pointsCost: 100, amountCents: 5000 }], program);
    expect(d).toEqual([2000, 500, 0]);
  });
  it("gives one unit of a specific item free", () => {
    expect(applyRewards(lines, [{ id: "r", type: "ITEM", pointsCost: 50, variantId: "pack" }], program)).toEqual([0, 500, 0]);
    expect(applyRewards(lines, [{ id: "r", type: "ITEM", pointsCost: 50, productId: "p-card", maxDiscountCents: 300 }], program)).toEqual([300, 0, 0]);
  });
  it("rejects an item reward when the item isn't in the cart", () => {
    expect(() => applyRewards(lines, [{ id: "r", type: "ITEM", pointsCost: 50, variantId: "nope" }], program)).toThrow(RewardNotApplicable);
  });
});

describe("earnFor", () => {
  it("earns points per whole eligible dollar", () => {
    const eligible = eligibleSpend(lines, [0, 0, 0], program);
    expect(eligible).toBe(2500);
    expect(earnFor({ ...program, pointsPerDollar: 2 }, eligible, 4000, 0)).toBe(50);
  });
  it("earns cashback as a percentage", () => {
    expect(earnFor({ ...program, type: "CASHBACK" }, 2550, 2550, 0)).toBe(51);
  });
  it("doesn't earn on the part paid with store credit", () => {
    expect(earnFor({ ...program, type: "CASHBACK", cashbackBps: 1000 }, 2000, 2000, 1000)).toBe(100);
    expect(earnFor({ ...program, type: "CASHBACK", cashbackBps: 1000, earnOnCredit: true }, 2000, 2000, 1000)).toBe(200);
  });
  it("earns nothing when disabled", () => {
    expect(earnFor({ ...program, enabled: false }, 10_000, 10_000, 0)).toBe(0);
  });
});
