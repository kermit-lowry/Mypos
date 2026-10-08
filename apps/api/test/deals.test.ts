import { localParts } from "@mypos/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;
let pokemon: string;
let singles: string;

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
  pokemon = (await w.as(w.manager, "POST", "/categories", { name: "Pokémon" })).body.id;
  singles = (await w.as(w.manager, "POST", "/categories", { name: "Singles", parentId: pokemon })).body.id;
  const card = await prisma.variant.findUniqueOrThrow({ where: { id: v.nm } });
  await w.as(w.manager, "POST", "/categories/assign", { categoryId: singles, productIds: [card.productId] });
});
afterAll(() => prisma.$disconnect());

const deal = (body: object) => w.as(w.manager, "POST", "/promotions", { name: "Deal", ...body });
const sell = (lines: object[], tenders: object[], extra: object = {}) =>
  w.as(w.cashier, "POST", "/orders/checkout", { locationId: w.locationId, lines, tenders, idempotencyKey: key(), ...extra });
const quote = (lines: object[]) => w.as(w.cashier, "POST", "/cart/quote", { locationId: w.locationId, lines });

describe("categories", () => {
  it("lists the tree with paths and product counts", async () => {
    const res = await w.as(w.cashier, "GET", "/categories");
    expect(res.body.map((c: any) => [c.path, c.productCount])).toEqual([
      ["Pokémon", 0],
      ["Pokémon > Singles", 1],
    ]);
  });

  it("rejects duplicates, loops, and deleting categories in use", async () => {
    expect((await w.as(w.manager, "POST", "/categories", { name: "Pokémon" })).status).toBe(409);
    expect((await w.as(w.manager, "PATCH", `/categories/${pokemon}`, { parentId: singles })).body.error).toBe("CATEGORY_LOOP");
    expect((await w.app.inject({ method: "DELETE", url: `/categories/${singles}`, headers: { authorization: `Bearer ${w.manager}` } })).statusCode).toBe(409);
  });
});

describe("deal setup", () => {
  it("validates each deal type and requires a manager", async () => {
    expect((await w.as(w.cashier, "POST", "/promotions", { name: "x", type: "PERCENT_OFF", percentBps: 1000, targetAll: true })).status).toBe(403);
    const bad = await deal({ type: "PERCENT_OFF", targetAll: true });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.details)).toContain("Set the % off");
    expect((await deal({ type: "BUY_X_GET_Y", buyQty: 1 })).status).toBe(400);
    expect((await deal({ type: "PERCENT_OFF", percentBps: 1000, targetAll: true, startTime: "17:00" })).status).toBe(400);
  });
});

describe("deals at checkout", () => {
  it("BOGO 50% on a parent category applies to products in subcategories", async () => {
    await deal({ name: "Pokémon BOGO 50%", type: "BUY_X_GET_Y", buyQty: 1, getQty: 1, getDiscountBps: 5000, categoryIds: [pokemon] });
    // 2 x $10 - $5 = $15 + 8.25% = $16.24
    const q = await quote([{ variantId: v.nm, quantity: 2 }]);
    expect(q.body).toMatchObject({ discountCents: 500, totalCents: 1624, promotions: [{ name: "Pokémon BOGO 50%", discountCents: 500 }] });

    const res = await sell([{ variantId: v.nm, quantity: 2 }], [{ type: "CASH", amountCents: 1624 }]);
    expect(res.status).toBe(201);
    expect(res.body.order.lines[0]).toMatchObject({ promoDiscountCents: 500, discountCents: 500 });
    expect(res.body.order.appliedPromotions).toEqual([{ promotionId: expect.any(String), name: "Pokémon BOGO 50%", discountCents: 500 }]);

    const receipt = await w.as(w.cashier, "GET", `/orders/${res.body.order.id}/receipt`);
    expect(receipt.body).toMatchObject({ savedCents: 500, promotions: [{ name: "Pokémon BOGO 50%", discountCents: 500 }] });
  });

  it("doesn't touch items outside the deal", async () => {
    await deal({ type: "PERCENT_OFF", percentBps: 2000, categoryIds: [pokemon] });
    const q = await quote([{ variantId: v.shoe, quantity: 1 }]);
    expect(q.body.discountCents).toBe(0);
  });

  it("a manual discount stacks on what the deal left", async () => {
    await deal({ type: "PERCENT_OFF", percentBps: 9000, targetAll: true });
    const q = await quote([{ variantId: v.nm, quantity: 1, discountCents: 500 }]);
    // $10 - $9 deal = $1 left; the $5 manual discount can only take that $1
    expect(q.body.discountCents).toBe(1000);
    expect(q.body.lines[0]).toMatchObject({ promoDiscountCents: 900, discountCents: 1000 });
  });

  it("only runs on its scheduled days and hours, in the store's time zone", async () => {
    const tz = (await prisma.location.findUniqueOrThrow({ where: { id: w.locationId } })).timezone;
    const now = localParts(new Date(), tz);
    const pad = (n: number) => String(n).padStart(2, "0");
    const hour = Math.floor(now.minutes / 60);

    await deal({ name: "Not today", type: "PERCENT_OFF", percentBps: 1000, targetAll: true, daysOfWeek: [(now.weekday + 1) % 7] });
    await deal({ name: "Not this hour", type: "PERCENT_OFF", percentBps: 1000, targetAll: true, startTime: `${pad((hour + 2) % 24)}:00`, endTime: `${pad((hour + 3) % 24)}:00` });
    await deal({ name: "Expired", type: "PERCENT_OFF", percentBps: 1000, targetAll: true, endsAt: new Date(Date.now() - 60_000).toISOString() });
    await deal({ name: "Not today's date", type: "PERCENT_OFF", percentBps: 1000, targetAll: true, dates: ["2000-01-01"] });
    expect((await quote([{ variantId: v.nm, quantity: 1 }])).body.promotions).toEqual([]);

    await deal({ name: "Happy hour", type: "PERCENT_OFF", percentBps: 1000, targetAll: true, daysOfWeek: [now.weekday], startTime: `${pad(hour)}:00`, endTime: `${pad((hour + 1) % 24)}:00`, dates: [now.date] });
    expect((await quote([{ variantId: v.nm, quantity: 1 }])).body.promotions.map((p: any) => p.name)).toEqual(["Happy hour"]);
    const running = await w.as(w.cashier, "GET", `/promotions/running?locationId=${w.locationId}`);
    expect(running.body.map((p: any) => p.name)).toEqual(["Happy hour"]);
  });

  it("paused deals stop applying", async () => {
    const d = await deal({ type: "PERCENT_OFF", percentBps: 1000, targetAll: true });
    await w.as(w.manager, "PATCH", `/promotions/${d.body.id}`, { active: false });
    expect((await quote([{ variantId: v.nm, quantity: 1 }])).body.discountCents).toBe(0);
  });

  it("deals respect channels: in-store only vs online", async () => {
    await deal({ name: "In-store only", type: "PERCENT_OFF", percentBps: 1000, targetAll: true, channels: ["POS"] });
    await deal({ name: "Web only", type: "AMOUNT_OFF", amountCents: 100, targetAll: true, channels: ["STOREFRONT"] });
    const web = await w.app.inject({ method: "POST", url: "/storefront/quote", payload: { lines: [{ variantId: v.nm, quantity: 1 }] } });
    // $10 - $1 = $9 + tax $0.74
    expect(web.json()).toMatchObject({ discountCents: 100, totalCents: 974, promotions: [{ name: "Web only" }] });
    const checkout = await w.app.inject({
      method: "POST",
      url: "/storefront/checkout",
      payload: { email: "a@b.co", name: "A", lines: [{ variantId: v.nm, quantity: 1 }], paymentToken: "tok_ok", amountCents: 974, idempotencyKey: key() },
    });
    expect(checkout.statusCode).toBe(201);
  });

  it("works with dual pricing: card pays card price on the discounted total", async () => {
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { cardPriceBps: 400 });
    await deal({ type: "PERCENT_OFF", percentBps: 5000, targetAll: true });
    const q = await quote([{ variantId: v.nm, quantity: 1 }]);
    // cash: $5 + $0.41 = $5.41; card: $10.40 - $5.20 = $5.20 + $0.43 = $5.63
    expect(q.body).toMatchObject({ totalCents: 541, card: { totalCents: 563 } });
    expect((await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CARD", amountCents: 563, paymentToken: "tok_ok" }])).status).toBe(201);
  });
});

describe("which tenders pay the card price", () => {
  beforeEach(() => w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { cardPriceBps: 400 }));
  // 1 x $10: cash price $10.83, card price $11.26

  it("gift cards, store credit, and checks pay the cash price by default", async () => {
    await w.as(w.manager, "POST", "/gift-cards", { code: "GIFT-0001", amountCents: 5000 });
    expect((await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "GIFT_CARD", amountCents: 1083, giftCardCode: "GIFT-0001" }])).status).toBe(201);
    expect((await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CHECK", amountCents: 1083, reference: "1042" }])).status).toBe(201);
  });

  it("the owner can make them pay the card price", async () => {
    expect((await w.as(w.manager, "PATCH", `/locations/${w.locationId}`, { cardPricedTenders: ["GIFT_CARD"] })).status).toBe(403);
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { cardPricedTenders: ["GIFT_CARD", "CHECK"] });
    await w.as(w.manager, "POST", "/gift-cards", { code: "GIFT-0002", amountCents: 5000 });
    const atCash = await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "GIFT_CARD", amountCents: 1083, giftCardCode: "GIFT-0002" }]);
    expect(atCash.body.error).toBe("TENDER_MISMATCH");
    expect((await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "GIFT_CARD", amountCents: 1126, giftCardCode: "GIFT-0002" }])).status).toBe(201);
    expect((await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CHECK", amountCents: 1126, reference: "77" }])).status).toBe(201);
    // Cash still pays the cash price.
    expect((await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CASH", amountCents: 1083 }])).status).toBe(201);
  });

  it("a gift card at card price can combine with a card", async () => {
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { cardPricedTenders: ["GIFT_CARD"] });
    await w.as(w.manager, "POST", "/gift-cards", { code: "GIFT-0003", amountCents: 500 });
    const res = await sell(
      [{ variantId: v.nm, quantity: 1 }],
      [{ type: "GIFT_CARD", amountCents: 500, giftCardCode: "GIFT-0003" }, { type: "CARD", amountCents: 626, paymentToken: "tok_ok" }],
    );
    expect(res.status).toBe(201);
  });

  it("checks need a check number and appear on the receipt", async () => {
    expect((await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CHECK", amountCents: 1083 }])).body.error).toBe("CHECK_NUMBER");
    const res = await sell([{ variantId: v.nm, quantity: 1 }], [{ type: "CHECK", amountCents: 1083, reference: "5521" }]);
    const r = await w.as(w.cashier, "GET", `/orders/${res.body.order.id}/receipt`);
    expect(r.body.payments[0]).toMatchObject({ label: "Check", detail: "#5521" });
  });
});

describe("browser clients", () => {
  it("CORS preflight allows the write methods the back office uses", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await w.app.inject({
        method: "OPTIONS",
        url: "/promotions/x",
        headers: { origin: "http://localhost:8090", "access-control-request-method": method },
      });
      expect(res.headers["access-control-allow-methods"]).toContain(method);
    }
  });
});
