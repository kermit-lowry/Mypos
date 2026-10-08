import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, onHand, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
});
afterAll(() => prisma.$disconnect());

const sale = (lines: object[], tenders: object[], extra: object = {}) => ({
  locationId: w.locationId,
  lines,
  tenders,
  idempotencyKey: key(),
  ...extra,
});

describe("checkout", () => {
  it("rings up a cash sale with tax and change, and decrements stock", async () => {
    // 2 x $10.00 = $20.00 + 8.25% = $21.65
    const res = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ variantId: v.nm, quantity: 2 }], [{ type: "CASH", amountCents: 2165, tenderedCents: 3000 }]));
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ status: "PAID", subtotalCents: 2000, taxCents: 165, totalCents: 2165 });
    expect(res.body.changeCents).toBe(835);
    expect(await onHand(v.nm, w.locationId)).toBe(1);
    const moves = await prisma.inventoryMovement.findMany({ where: { variantId: v.nm, reason: "SALE" } });
    expect(moves.map((m) => m.delta)).toEqual([-2]);
  });

  it("splits card and store credit", async () => {
    const c = await w.as(w.cashier, "POST", "/customers", { name: "Ash" });
    await w.as(w.manager, "POST", `/customers/${c.body.id}/credit`, { amountCents: 500, reason: "Promo" });
    const res = await w.as(
      w.cashier,
      "POST",
      "/orders/checkout",
      sale([{ variantId: v.nm, quantity: 1 }], [{ type: "STORE_CREDIT", amountCents: 500 }, { type: "CARD", amountCents: 583, paymentToken: "tok_ok" }], { customerId: c.body.id }),
    );
    expect(res.status).toBe(201);
    const cust = await w.as(w.cashier, "GET", `/customers/${c.body.id}`);
    expect(cust.body.storeCreditCents).toBe(0);
    expect(res.body.order.payments.map((p: any) => p.tender).sort()).toEqual(["CARD", "STORE_CREDIT"]);
  });

  it("rejects tenders that don't match the total", async () => {
    const res = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ variantId: v.nm, quantity: 1 }], [{ type: "CASH", amountCents: 1000 }]));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("TENDER_MISMATCH");
  });

  it("voids the order on decline and leaves stock alone", async () => {
    const body = sale([{ variantId: v.nm, quantity: 1 }], [{ type: "CARD", amountCents: 1083, paymentToken: "tok_decline" }]);
    const res = await w.as(w.cashier, "POST", "/orders/checkout", body);
    expect(res.status).toBe(402);
    expect(await onHand(v.nm, w.locationId)).toBe(3);
    const replay = await w.as(w.cashier, "POST", "/orders/checkout", body);
    expect(replay.status).toBe(409);
  });

  it("is idempotent: a retried request charges once", async () => {
    const body = sale([{ variantId: v.nm, quantity: 1 }], [{ type: "CARD", amountCents: 1083, paymentToken: "tok_ok" }]);
    const first = await w.as(w.cashier, "POST", "/orders/checkout", body);
    const second = await w.as(w.cashier, "POST", "/orders/checkout", body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(w.gateway.calls.filter((c) => c.op === "sale")).toHaveLength(1);
    expect(await onHand(v.nm, w.locationId)).toBe(2);
  });

  it("voids the card charge when stock runs out", async () => {
    const res = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ variantId: v.nm, quantity: 4 }], [{ type: "CARD", amountCents: 4330, paymentToken: "tok_ok" }]));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("INSUFFICIENT_STOCK");
    expect(w.gateway.calls.map((c) => c.op)).toEqual(["sale", "void"]);
  });

  it("never sells the last copy twice", async () => {
    await w.as(w.manager, "POST", "/inventory/adjust", { variantId: v.lp, locationId: w.locationId, delta: -2, reason: "COUNT" });
    const attempt = () => w.as(w.cashier, "POST", "/orders/checkout", sale([{ variantId: v.lp, quantity: 1 }], [{ type: "CASH", amountCents: 920 }]));
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await onHand(v.lp, w.locationId)).toBe(0);
  });

  it("requires a manager for price overrides", async () => {
    const lines = [{ variantId: v.nm, quantity: 1, unitPriceCents: 800 }];
    const cashier = await w.as(w.cashier, "POST", "/orders/checkout", sale(lines, [{ type: "CASH", amountCents: 866 }]));
    expect(cashier.status).toBe(403);
    const manager = await w.as(w.manager, "POST", "/orders/checkout", sale(lines, [{ type: "CASH", amountCents: 866 }]));
    expect(manager.status).toBe(201);
  });

  it("rejects unauthenticated register calls", async () => {
    const res = await w.app.inject({ method: "POST", url: "/orders/checkout", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe("refunds", () => {
  it("refunds part of a card sale back to the card and restocks", async () => {
    const res = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ variantId: v.nm, quantity: 2 }], [{ type: "CARD", amountCents: 2165, paymentToken: "tok_ok" }]));
    const line = res.body.order.lines[0];
    const refund = await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: line.id, quantity: 1 }] });
    expect(refund.status).toBe(200);
    // $10.00 + 82.5c tax (rounded half-up)
    expect(refund.body.refundCents).toBe(1083);
    expect(refund.body.legs).toEqual([{ tender: "CARD", amountCents: 1083, status: "APPROVED" }]);
    expect(await onHand(v.nm, w.locationId)).toBe(2);
    const order = await w.as(w.cashier, "GET", `/orders/${res.body.order.id}`);
    expect(order.body.status).toBe("PARTIALLY_REFUNDED");

    const again = await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: line.id, quantity: 2 }] });
    expect(again.status).toBe(400);
  });

  it("cashiers cannot refund", async () => {
    const res = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ variantId: v.nm, quantity: 1 }], [{ type: "CASH", amountCents: 1083 }]));
    const refund = await w.as(w.cashier, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: res.body.order.lines[0].id, quantity: 1 }] });
    expect(refund.status).toBe(403);
  });

  it("can refund to store credit", async () => {
    const c = await w.as(w.cashier, "POST", "/customers", { name: "Misty" });
    const res = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ variantId: v.nm, quantity: 1 }], [{ type: "CASH", amountCents: 1083 }], { customerId: c.body.id }));
    await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: res.body.order.lines[0].id, quantity: 1 }], toStoreCredit: true });
    const cust = await w.as(w.cashier, "GET", `/customers/${c.body.id}`);
    expect(cust.body.storeCreditCents).toBe(1083);
  });
});

describe("storefront", () => {
  it("lists storefront products and sells them by card", async () => {
    const list = await w.app.inject({ method: "GET", url: "/storefront/products" });
    const products = list.json().products;
    expect(products.map((p: any) => p.title)).toEqual(["Charizard ex"]);
    expect(products[0].variants[0].available).toBe(3);

    const res = await w.app.inject({
      method: "POST",
      url: "/storefront/checkout",
      payload: { email: "red@example.com", name: "Red", lines: [{ variantId: v.nm, quantity: 1 }], paymentToken: "tok_ok", amountCents: 1083, idempotencyKey: key() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "PAID", totalCents: 1083 });
  });

  it("won't sell products not published to the storefront", async () => {
    const res = await w.app.inject({
      method: "POST",
      url: "/storefront/checkout",
      payload: { email: "red@example.com", name: "Red", lines: [{ variantId: v.shoe, quantity: 1 }], paymentToken: "tok_ok", amountCents: 32475, idempotencyKey: key() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("NOT_ON_CHANNEL");
  });
});
