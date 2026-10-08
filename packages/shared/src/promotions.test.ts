import { describe, expect, it } from "vitest";
import { applyPromotions, isScheduledNow, type PromoDef, type PromoLine } from "./promotions.js";

const line = (variantId: string, unitPriceCents: number, quantity = 1, categoryIds: string[] = []): PromoLine => ({
  variantId,
  productId: `p-${variantId}`,
  categoryIds,
  unitPriceCents,
  quantity,
});
const promo = (p: Partial<PromoDef> & Pick<PromoDef, "type">): PromoDef => ({
  id: p.id ?? p.type,
  name: p.name ?? p.type,
  priority: 100,
  stackable: false,
  targets: { all: true },
  ...p,
});

describe("deal types", () => {
  it("percent off each matching item, by category", () => {
    const r = applyPromotions(
      [line("pack", 500, 2, ["sealed", "pokemon"]), line("card", 1000, 1, ["singles"])],
      [promo({ type: "PERCENT_OFF", percentBps: 2000, targets: { categoryIds: ["sealed"] } })],
    );
    expect(r.lineDiscounts).toEqual([200, 0]);
    expect(r.applied).toEqual([{ promotionId: "PERCENT_OFF", name: "PERCENT_OFF", discountCents: 200 }]);
  });

  it("amount off and sale price never go below zero", () => {
    expect(applyPromotions([line("a", 300)], [promo({ type: "AMOUNT_OFF", amountCents: 500 })]).lineDiscounts).toEqual([300]);
    expect(applyPromotions([line("a", 1000), line("b", 400)], [promo({ type: "SALE_PRICE", priceCents: 500 })]).lineDiscounts).toEqual([500, 0]);
  });

  it("BOGO free: the free item is the one of equal or lesser value", () => {
    // $10, $8, $6, $4 -> buy 10 get 8 free; buy 6 get 4 free
    const r = applyPromotions(
      [line("a", 1000), line("b", 800), line("c", 600), line("d", 400)],
      [promo({ type: "BUY_X_GET_Y", buyQty: 1, getQty: 1, getDiscountBps: 10_000 })],
    );
    expect(r.lineDiscounts).toEqual([0, 800, 0, 400]);
  });

  it("buy 2 get 1 half off, limited to one use per order", () => {
    const r = applyPromotions(
      [line("pack", 500, 6)],
      [promo({ type: "BUY_X_GET_Y", buyQty: 2, getQty: 1, getDiscountBps: 5_000, maxApplications: 1 })],
    );
    expect(r.lineDiscounts).toEqual([250]);
  });

  it("BOGO needs the full set in the cart", () => {
    expect(applyPromotions([line("a", 1000)], [promo({ type: "BUY_X_GET_Y", buyQty: 1, getQty: 1 })]).applied).toEqual([]);
  });

  it("buy one thing, get a different thing (cheapest) free", () => {
    const r = applyPromotions(
      [line("box", 14999, 1, ["sealed"]), line("sleeves-a", 1299, 1, ["accessories"]), line("sleeves-b", 899, 1, ["accessories"])],
      [promo({ type: "BUY_X_GET_Y", buyQty: 1, getQty: 1, targets: { categoryIds: ["sealed"] }, getTargets: { categoryIds: ["accessories"] } })],
    );
    expect(r.lineDiscounts).toEqual([0, 0, 899]);
  });

  it("multi-buy: 3 for $10", () => {
    // 4 packs at $4.49: one group of 3 = $13.47 -> $10.00; the 4th stays full price
    const r = applyPromotions([line("pack", 449, 4)], [promo({ type: "MULTI_BUY", buyQty: 3, priceCents: 1000 })]);
    expect(r.lineDiscounts).toEqual([347]);
  });

  it("spend $100 on a category, get $15 off", () => {
    const deal = promo({ type: "ORDER_DISCOUNT", amountCents: 1500, minSubtotalCents: 10_000, targets: { categoryIds: ["sneakers"] } });
    expect(applyPromotions([line("shoe", 9000, 1, ["sneakers"])], [deal]).applied).toEqual([]);
    const r = applyPromotions([line("shoe", 9000, 1, ["sneakers"]), line("socks", 2000, 1, ["sneakers"]), line("card", 500)], [deal]);
    expect(r.lineDiscounts).toEqual([1228, 272, 0]);
  });

  it("respects exclusions and minimum quantity", () => {
    const deal = promo({ type: "PERCENT_OFF", percentBps: 1000, minQty: 2, exclude: { categoryIds: ["events"] } });
    expect(applyPromotions([line("a", 1000), line("fnm", 1500, 1, ["events"])], [deal]).applied).toEqual([]);
    expect(applyPromotions([line("a", 1000, 2), line("fnm", 1500, 1, ["events"])], [deal]).lineDiscounts).toEqual([200, 0]);
  });
});

describe("stacking", () => {
  const lines = [line("a", 1000, 2)];

  it("a non-stackable deal claims its items", () => {
    const r = applyPromotions(lines, [
      promo({ id: "bogo", type: "BUY_X_GET_Y", buyQty: 1, getQty: 1, priority: 1 }),
      promo({ id: "ten", type: "PERCENT_OFF", percentBps: 1000, priority: 2 }),
    ]);
    expect(r.applied.map((a) => a.promotionId)).toEqual(["bogo"]);
    expect(r.lineDiscounts).toEqual([1000]);
  });

  it("a stackable deal applies on top, to the remaining price", () => {
    const r = applyPromotions(lines, [
      promo({ id: "half", type: "PERCENT_OFF", percentBps: 5000, priority: 1, stackable: true }),
      promo({ id: "ten", type: "PERCENT_OFF", percentBps: 1000, priority: 2, stackable: true }),
    ]);
    // $10 -> $5 -> $4.50, twice
    expect(r.lineDiscounts).toEqual([1100]);
  });

  it("runs in priority order", () => {
    const r = applyPromotions(lines, [
      promo({ id: "ten", type: "PERCENT_OFF", percentBps: 1000, priority: 5 }),
      promo({ id: "twenty", type: "PERCENT_OFF", percentBps: 2000, priority: 1 }),
    ]);
    expect(r.applied.map((a) => a.promotionId)).toEqual(["twenty"]);
  });
});

describe("schedule", () => {
  const tz = "America/New_York";
  // 2026-10-09 is a Friday. 22:30 UTC = 18:30 New York (EDT, UTC-4).
  const fridayEvening = new Date("2026-10-09T22:30:00Z");

  it("days of week and time of day, in the store's time zone", () => {
    expect(isScheduledNow({ daysOfWeek: [5], startTime: "17:00", endTime: "21:00" }, fridayEvening, tz)).toBe(true);
    expect(isScheduledNow({ daysOfWeek: [6] }, fridayEvening, tz)).toBe(false);
    expect(isScheduledNow({ startTime: "09:00", endTime: "12:00" }, fridayEvening, tz)).toBe(false);
    // Same instant is already Saturday in Tokyo.
    expect(isScheduledNow({ daysOfWeek: [6] }, fridayEvening, "Asia/Tokyo")).toBe(true);
  });

  it("windows that cross midnight", () => {
    const lateNight = new Date("2026-10-10T04:30:00Z"); // 00:30 New York
    expect(isScheduledNow({ startTime: "22:00", endTime: "02:00" }, lateNight, tz)).toBe(true);
    expect(isScheduledNow({ startTime: "22:00", endTime: "02:00" }, fridayEvening, tz)).toBe(false);
  });

  it("specific calendar dates and a date range", () => {
    expect(isScheduledNow({ dates: ["2026-10-09", "2026-11-27"] }, fridayEvening, tz)).toBe(true);
    expect(isScheduledNow({ dates: ["2026-11-27"] }, fridayEvening, tz)).toBe(false);
    expect(isScheduledNow({ startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-31T00:00:00Z" }, fridayEvening, tz)).toBe(true);
    expect(isScheduledNow({ endsAt: "2026-10-09T00:00:00Z" }, fridayEvening, tz)).toBe(false);
  });
});
