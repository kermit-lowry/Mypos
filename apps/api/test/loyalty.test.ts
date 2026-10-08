import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;
let cust: string;

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
  cust = (await w.as(w.cashier, "POST", "/customers", { name: "Ash" })).body.id;
});
afterAll(() => prisma.$disconnect());

const program = (body: object) => w.as(w.owner, "PUT", "/loyalty/program", { enabled: true, ...body });
const balances = async () => (await w.as(w.cashier, "GET", `/customers/${cust}/loyalty`)).body as { points: number; rewardsCents: number };
const sell = (lines: object[], tenders: object[], extra: object = {}) =>
  w.as(w.cashier, "POST", "/orders/checkout", { locationId: w.locationId, customerId: cust, lines, tenders, idempotencyKey: key(), ...extra });

describe("program settings", () => {
  it("only the owner can configure loyalty", async () => {
    const res = await w.as(w.manager, "PUT", "/loyalty/program", { enabled: true, type: "POINTS", pointsPerDollar: 1 });
    expect(res.status).toBe(403);
    expect((await program({ type: "POINTS", pointsPerDollar: 1 })).status).toBe(200);
  });

  it("rejects an enabled program with no earn rate", async () => {
    expect((await program({ type: "CASHBACK", cashbackBps: 0 })).status).toBe(400);
  });

  it("earns nothing while disabled", async () => {
    await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CASH", amountCents: 1083 }]);
    expect(await balances()).toEqual(expect.objectContaining({ points: 0, rewardsCents: 0 }));
  });
});

describe("cashback (percentage of every dollar)", () => {
  beforeEach(() => program({ type: "CASHBACK", cashbackBps: 500 }));

  it("earns a percentage of pre-tax spend as rewards dollars", async () => {
    // 2 x $10 = $20 pre-tax, 5% = $1.00
    const res = await sell([{ variantId: v.nm, quantity: 2 }], [{ type: "CARD", amountCents: 2165, paymentToken: "tok_ok" }]);
    expect(res.body.order).toMatchObject({ loyaltyEarned: 100, loyaltyUnit: "CENTS" });
    expect((await balances()).rewardsCents).toBe(100);
  });

  it("spends rewards dollars as a tender, without earning on that part", async () => {
    await w.as(w.manager, "POST", `/customers/${cust}/loyalty`, { unit: "CENTS", amount: 500, reason: "Welcome bonus" });
    // $10.83 total, $5 paid with rewards: earns 5% on the cash-paid share of $10 ≈ $0.27
    const res = await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "LOYALTY", amountCents: 500 }, { type: "CASH", amountCents: 583 }]);
    expect(res.status).toBe(201);
    expect((await balances()).rewardsCents).toBe(0 + res.body.order.loyaltyEarned);
    expect(res.body.order.loyaltyEarned).toBe(26);
  });

  it("won't overspend rewards dollars, and never touches the card", async () => {
    const res = await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "LOYALTY", amountCents: 500 }, { type: "CARD", amountCents: 583, paymentToken: "tok_ok" }]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("INSUFFICIENT_REWARDS");
    expect(w.gateway.calls).toHaveLength(0);
  });

  it("claws back cashback on refunds, exactly, across partial refunds", async () => {
    const res = await sell([{ variantId: v.nm, quantity: 3 }], [{ type: "CASH", amountCents: 3248 }]);
    expect(res.body.order.loyaltyEarned).toBe(150);
    const lineId = res.body.order.lines[0].id;
    for (let i = 0; i < 3; i++) {
      await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: lineId, quantity: 1 }] });
    }
    expect((await balances()).rewardsCents).toBe(0);
  });

  it("returns rewards dollars when a sale paid with them is refunded", async () => {
    await w.as(w.manager, "POST", `/customers/${cust}/loyalty`, { unit: "CENTS", amount: 1083, reason: "Promo" });
    const res = await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "LOYALTY", amountCents: 1083 }]);
    expect(res.body.order.loyaltyEarned).toBe(0); // fully paid with rewards
    await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: res.body.order.lines[0].id, quantity: 1 }] });
    expect((await balances()).rewardsCents).toBe(1083);
  });
});

describe("points", () => {
  beforeEach(async () => {
    await program({ type: "POINTS", pointsPerDollar: 10, excludedKinds: ["EVENT_ENTRY"] });
    await w.as(w.manager, "POST", `/customers/${cust}/loyalty`, { unit: "POINTS", amount: 1000, reason: "Starting balance" });
  });

  const reward = async (body: object) => (await w.as(w.owner, "POST", "/loyalty/rewards", body)).body.id as string;

  it("earns points per whole dollar and skips excluded product types", async () => {
    const event = await w.as(w.manager, "POST", "/events", {
      locationId: w.locationId,
      name: "Locals",
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      capacity: 8,
      entryFeeCents: 1500,
    });
    // $8.50 card (8 whole dollars -> 80 pts) + $15 event entry (excluded)
    const res = await sell(
      [{ variantId: v.lp, quantity: 1 }, { variantId: event.body.variantId, quantity: 1 }],
      [{ type: "CASH", amountCents: 850 + 70 + 1500 }],
    );
    expect(res.status).toBe(201);
    expect(res.body.order.loyaltyEarned).toBe(80);
    expect((await balances()).points).toBe(1080);
  });

  it("redeems a percentage-off reward, taxing the discounted price", async () => {
    const tenOff = await reward({ name: "10% off", type: "PERCENT_OFF", pointsCost: 500, percentBps: 1000 });
    const quote = await w.as(w.cashier, "POST", "/loyalty/quote", {
      locationId: w.locationId,
      customerId: cust,
      lines: [{ variantId: v.nm, quantity: 2 }],
      rewardIds: [tenOff],
    });
    // $20 - $2 = $18, tax 8.25% = $1.49 -> $19.49; earns 18 x 10 = 180 pts
    expect(quote.body).toMatchObject({ discountCents: 200, taxCents: 149, totalCents: 1949, pointsCost: 500, earn: { unit: "POINTS", amount: 180 } });

    const res = await sell([{ variantId: v.nm, quantity: 2 }], [{ type: "CARD", amountCents: 1949, paymentToken: "tok_ok" }], { rewardIds: [tenOff] });
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ totalCents: 1949, pointsRedeemed: 500, loyaltyEarned: 180 });
    expect(res.body.order.lines[0].rewardDiscountCents).toBe(200);
    expect((await balances()).points).toBe(1000 - 500 + 180);
  });

  it("redeems a dollars-off reward", async () => {
    const fiveOff = await reward({ name: "$5 off", type: "AMOUNT_OFF", pointsCost: 400, amountCents: 500 });
    // $10 - $5 = $5, tax $0.41
    const res = await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CASH", amountCents: 541 }], { rewardIds: [fiveOff] });
    expect(res.status).toBe(201);
    expect(res.body.order.discountCents).toBe(500);
  });

  it("redeems a specific free item, only when it's in the cart", async () => {
    const freeLp = await reward({ name: "Free LP Charizard", type: "ITEM", pointsCost: 900, variantId: v.lp });
    const missing = await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CASH", amountCents: 1083 }], { rewardIds: [freeLp] });
    expect(missing.body.error).toBe("REWARD_NOT_APPLICABLE");

    const res = await sell([{ variantId: v.lp, quantity: 1 }, { variantId: v.nm, quantity: 1 }], [{ type: "CASH", amountCents: 1083 }], { rewardIds: [freeLp] });
    expect(res.status).toBe(201);
    expect(res.body.order.lines.find((l: any) => l.variantId === v.lp).rewardDiscountCents).toBe(850);
  });

  it("refuses rewards the customer can't afford, without charging the card", async () => {
    const big = await reward({ name: "50% off", type: "PERCENT_OFF", pointsCost: 5000, percentBps: 5000 });
    const res = await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CARD", amountCents: 541, paymentToken: "tok_ok" }], { rewardIds: [big] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("INSUFFICIENT_POINTS");
    expect(w.gateway.calls).toHaveLength(0);
  });

  it("hides deactivated rewards", async () => {
    const r = await reward({ name: "Old promo", type: "AMOUNT_OFF", pointsCost: 100, amountCents: 100 });
    await w.as(w.owner, "PATCH", `/loyalty/rewards/${r}`, { active: false });
    expect((await w.as(w.cashier, "GET", "/loyalty/rewards")).body).toHaveLength(0);
    const res = await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CASH", amountCents: 975 }], { rewardIds: [r] });
    expect(res.body.error).toBe("REWARD_UNAVAILABLE");
  });

  it("gives redeemed points back only on a full refund", async () => {
    const fiveOff = await reward({ name: "$5 off", type: "AMOUNT_OFF", pointsCost: 400, amountCents: 500 });
    // 2 x $10 - $5 = $15 -> tax $1.24 -> $16.24; earns 150
    const res = await sell([{ variantId: v.nm, quantity: 2 }], [{ type: "CASH", amountCents: 1624 }], { rewardIds: [fiveOff] });
    expect((await balances()).points).toBe(1000 - 400 + 150);
    const lineId = res.body.order.lines[0].id;
    await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: lineId, quantity: 1 }] });
    expect((await balances()).points).toBe(1000 - 400 + 75);
    await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: lineId, quantity: 1 }] });
    expect((await balances()).points).toBe(1000);
  });

  it("online orders earn points too", async () => {
    const res = await w.app.inject({
      method: "POST",
      url: "/storefront/checkout",
      payload: { email: "ash@example.com", name: "Ash", lines: [{ variantId: v.nm, quantity: 1 }], paymentToken: "tok_ok", amountCents: 1083, idempotencyKey: key() },
    });
    expect(res.statusCode).toBe(201);
    const web = await prisma.customer.findUniqueOrThrow({ where: { email: "ash@example.com" } });
    const bal = await w.as(w.cashier, "GET", `/customers/${web.id}/loyalty`);
    expect(bal.body.points).toBe(100);
  });
});
