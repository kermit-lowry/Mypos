import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, onHand, PINS, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;
/** Ash, the layaway customer. */
let cust: string;

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
  // Round numbers (no tax) and a 3.99% card price; the sneaker gets its one unit of stock.
  await prisma.location.update({ where: { id: w.locationId }, data: { taxRateBps: 0, cardPriceBps: 399 } });
  await w.as(w.manager, "POST", "/inventory/adjust", { variantId: v.shoe, locationId: w.locationId, delta: 1, reason: "RECEIVE" });
  cust = (await w.as(w.cashier, "POST", "/customers", { name: "Ash Ketchum", email: "ash@example.com", phone: "555-0100" })).body.id;
});
afterAll(() => prisma.$disconnect());

// The sneaker ($300) and a Charizard ($10): $310, so the 20% minimum deposit is $62.
const lines = () => [
  { variantId: v.shoe, quantity: 1 },
  { variantId: v.nm, quantity: 1 },
];
const open = (tenders: object[], extra: object = {}, as = w.cashier) =>
  w.as(as, "POST", "/layaways", { locationId: w.locationId, customerId: cust, lines: lines(), tenders, idempotencyKey: key(), ...extra });
const pay = (id: string, tenders: object[], extra: object = {}) => w.as(w.cashier, "POST", `/layaways/${id}/payments`, { tenders, idempotencyKey: key(), ...extra });
const staffId = async (name: string) => (await prisma.staff.findUniqueOrThrow({ where: { email: `${name.toLowerCase()}@shop.test` } })).id;
/** A manager's PIN approval for the cashier. */
const approve = async (permissions: string[]) => (await w.as(w.cashier, "POST", "/auth/approve", { pin: PINS.MANAGER, permissions })).body.token as string;
const withToken = async (as: string, token: string, method: "GET" | "POST", url: string, body?: unknown) => {
  const res = await w.app.inject({ method, url, payload: body as object, headers: { authorization: `Bearer ${as}`, "x-approval-token": token } });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
};
const movements = (variantId: string, reason: string) => prisma.inventoryMovement.findMany({ where: { variantId, reason: reason as never } });
const lastAudit = (action: string) => prisma.auditEvent.findFirstOrThrow({ where: { action }, orderBy: { createdAt: "desc" } });
const today = () => {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).toISOString();
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2).toISOString();
  return `from=${from}&to=${to}`;
};

describe("opening a layaway", () => {
  it("locks the prices, reserves the stock and takes the deposit", async () => {
    const res = await open([{ type: "CASH", amountCents: 6200, tenderedCents: 7000 }], { notes: "Birthday present" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ changeCents: 800, replayed: false });
    const l = res.body.layaway;
    expect(l).toMatchObject({
      status: "ACTIVE",
      locationId: w.locationId,
      customerId: cust,
      subtotalCents: 31000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 31000,
      cardPriceBps: 399,
      paidCents: 6200,
      cardAdjustmentCents: 0,
      balanceCents: 24800,
      cardBalanceCents: 25790,
      overdue: false,
      notes: "Birthday present",
      customer: { id: cust, name: "Ash Ketchum", email: "ash@example.com", phone: "555-0100" },
      staff: { name: "CASHIER" },
      cancelFeePreview: { feeCents: 0, refundCents: 6200 },
    });
    expect(Math.round((new Date(l.dueAt).getTime() - Date.now()) / 86_400_000)).toBe(30);
    expect(l.lines).toHaveLength(2);
    expect(l.lines[0]).toMatchObject({ variantId: v.shoe, quantity: 1, unitPriceCents: 30000, discountCents: 0, taxable: true, variant: { sku: "DZ5485-612-10", product: { title: "Jordan 1 Retro High OG Chicago" } } });
    expect(l.lines[0].title).toContain("Jordan 1");
    expect(l.payments).toHaveLength(1);
    expect(l.payments[0]).toMatchObject({ tender: "CASH", amountCents: 6200, appliedCents: 6200, changeCents: 800, status: "APPROVED", layawayId: l.id, orderId: null, staff: { name: "CASHIER" } });

    // The stock is held: on hand drops with a LAYAWAY movement.
    expect(await onHand(v.shoe, w.locationId)).toBe(0);
    expect(await onHand(v.nm, w.locationId)).toBe(2);
    expect((await movements(v.shoe, "LAYAWAY")).map((m) => m.delta)).toEqual([-1]);
    expect((await movements(v.nm, "LAYAWAY")).map((m) => m.delta)).toEqual([-1]);

    const audit = await lastAudit("LAYAWAY_CREATED");
    expect(audit).toMatchObject({ staffId: await staffId("CASHIER"), locationId: w.locationId, details: { layawayId: l.id, number: l.number, customerId: cust, totalCents: 31000, depositCents: 6200 } });
    expect((await w.as(w.cashier, "GET", `/layaways/${l.id}`)).body).toMatchObject({ id: l.id, balanceCents: 24800, lines: [{ variant: { sku: "DZ5485-612-10" } }, { variant: { sku: "PKM-OBF-125-NM" } }] });
    expect((await w.as(w.cashier, "GET", "/layaways/nope")).status).toBe(404);
  });

  it("the deposit must reach the location's minimum and can't exceed the total", async () => {
    const small = await open([{ type: "CASH", amountCents: 6199 }]);
    expect(small.status).toBe(400);
    expect(small.body).toMatchObject({ error: "DEPOSIT_TOO_SMALL", details: { minimumCents: 6200, tenderedCents: 6199 } });
    const big = await open([{ type: "CASH", amountCents: 31001 }]);
    expect(big.status).toBe(400);
    expect(big.body).toMatchObject({ error: "OVERPAID", details: { balanceCents: 31000 } });
    expect(await prisma.layaway.count()).toBe(0);
    expect(await onHand(v.shoe, w.locationId)).toBe(1);
  });

  it("charges nothing when the stock isn't there", async () => {
    const res = await open([{ type: "CARD", amountCents: 1000, paymentToken: "tok_ok" }], { lines: [{ variantId: v.nm, quantity: 5 }] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "INSUFFICIENT_STOCK", details: { variantId: v.nm, onHand: 3, requested: 5 } });
    expect(w.gateway.calls).toEqual([]);
    expect(await prisma.layaway.count()).toBe(0);
  });

  it("a declined card puts the stock back and the key can't be reused", async () => {
    const body = { locationId: w.locationId, customerId: cust, lines: lines(), tenders: [{ type: "CARD", amountCents: 6200, paymentToken: "tok_decline" }], idempotencyKey: key() };
    const res = await w.as(w.cashier, "POST", "/layaways", body);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("PAYMENT_DECLINED");
    const l = await prisma.layaway.findFirstOrThrow();
    expect(l).toMatchObject({ status: "CANCELLED", paidCents: 0, cancelReason: "Deposit payment failed", cancelledById: null });
    expect(await onHand(v.shoe, w.locationId)).toBe(1);
    expect((await movements(v.shoe, "LAYAWAY_RETURN")).map((m) => m.delta)).toEqual([1]);
    const again = await w.as(w.cashier, "POST", "/layaways", body);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "LAYAWAY_FAILED", details: { layawayId: l.id } });
  });

  it("refuses manual discounts and price changes", async () => {
    const disc = await open([{ type: "CASH", amountCents: 6200 }], { lines: [{ variantId: v.shoe, quantity: 1, discountCents: 100 }] });
    expect(disc.status).toBe(400);
    expect(disc.body.error).toBe("LAYAWAY_NO_MANUAL_DISCOUNT");
    const price = await open([{ type: "CASH", amountCents: 6200 }], { lines: [{ variantId: v.shoe, quantity: 1, unitPriceCents: 25000 }] });
    expect(price.body.error).toBe("LAYAWAY_NO_MANUAL_DISCOUNT");
    expect((await open([{ type: "GIFT_CARD", amountCents: 6200, giftCardCode: "ABCDEF" }])).body.error).toBe("TENDER_NOT_ALLOWED");
  });

  it("the owner sets the layaway terms per location, and can switch it off", async () => {
    expect((await w.as(w.manager, "PATCH", `/locations/${w.locationId}`, { layawayEnabled: false })).status).toBe(403);
    expect((await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { layawayTermDays: 0 })).status).toBe(400);
    expect((await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { layawayMinDepositBps: 10_001 })).status).toBe(400);
    const res = await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { layawayEnabled: false, layawayMinDepositBps: 2500, layawayTermDays: 45, layawayCancelFeeCents: 500, layawayCancelFeeBps: 1000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ layawayEnabled: false, layawayMinDepositBps: 2500, layawayTermDays: 45, layawayCancelFeeCents: 500, layawayCancelFeeBps: 1000 });
    expect((await lastAudit("SETTINGS_UPDATED")).details).toEqual({
      changes: {
        layawayEnabled: { from: true, to: false },
        layawayMinDepositBps: { from: 2000, to: 2500 },
        layawayTermDays: { from: 30, to: 45 },
        layawayCancelFeeCents: { from: 0, to: 500 },
        layawayCancelFeeBps: { from: 0, to: 1000 },
      },
    });
    const off = await open([{ type: "CASH", amountCents: 10000 }]);
    expect(off.status).toBe(409);
    expect(off.body.error).toBe("LAYAWAY_DISABLED");
    expect(await prisma.layaway.count()).toBe(0);

    // Back on: the new minimum (25%) and term (45 days) apply.
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { layawayEnabled: true });
    expect((await open([{ type: "CASH", amountCents: 7749 }])).body.details.minimumCents).toBe(7750);
    const on = await open([{ type: "CASH", amountCents: 7750 }]);
    expect(on.status).toBe(201);
    expect(Math.round((new Date(on.body.layaway.dueAt).getTime() - Date.now()) / 86_400_000)).toBe(45);
  });

  it("cash deposits need an open drawer when the location requires one", async () => {
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { requireDrawerSession: true });
    const cash = await open([{ type: "CASH", amountCents: 6200 }]);
    expect(cash.status).toBe(409);
    expect(cash.body.error).toBe("DRAWER_CLOSED");
    expect(await prisma.layaway.count()).toBe(0);
    expect(await onHand(v.shoe, w.locationId)).toBe(1);
    expect(w.gateway.calls).toEqual([]);
    // Cards don't touch the drawer.
    expect((await open([{ type: "CARD", amountCents: 6200, paymentToken: "tok_ok" }])).status).toBe(201);
  });

  it("is idempotent", async () => {
    const body = { locationId: w.locationId, customerId: cust, lines: lines(), tenders: [{ type: "CASH", amountCents: 6200 }], idempotencyKey: key() };
    const first = await w.as(w.cashier, "POST", "/layaways", body);
    const again = await w.as(w.cashier, "POST", "/layaways", body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.layaway.id).toBe(first.body.layaway.id);
    expect(again.body.layaway.payments.map((p: any) => p.id)).toEqual(first.body.layaway.payments.map((p: any) => p.id));
    expect(await prisma.layaway.count()).toBe(1);
    expect(await onHand(v.shoe, w.locationId)).toBe(0);
  });
});

describe("payments", () => {
  let id: string;
  beforeEach(async () => {
    id = (await open([{ type: "CASH", amountCents: 6200 }])).body.layaway.id;
  });

  it("a card pays the card price: less than the charge comes off the balance", async () => {
    // $100 by card at 3.99%: $96.16 applies (card price $100.00), $3.84 is the card adjustment.
    const res = await pay(id, [{ type: "CARD", amountCents: 10000, paymentToken: "tok_ok" }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ changeCents: 0, replayed: false });
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0]).toMatchObject({ tender: "CARD", amountCents: 10000, appliedCents: 9616, cardLast4: "4242", layawayId: id, orderId: null });
    expect(res.body.layaway).toMatchObject({ paidCents: 15816, cardAdjustmentCents: 384, cardAdjustmentTaxCents: 0, balanceCents: 15184, cardBalanceCents: 15790 });
    expect(w.gateway.calls).toEqual([{ op: "sale", amountCents: 10000 }]);
    expect(w.gateway.lastSale?.orderRef).toMatch(/^LAY-\d+$/);
    expect((await lastAudit("LAYAWAY_PAYMENT")).details).toMatchObject({ layawayId: id, tenders: [{ tender: "CARD", amountCents: 10000, appliedCents: 9616 }], appliedCents: 9616, balanceCents: 15184 });

    // Charging the balance at the card price clears it exactly.
    const off = await pay(id, [{ type: "CARD", amountCents: 15790, paymentToken: "tok_ok" }]);
    expect(off.status).toBe(201);
    expect(off.body.payments[0].appliedCents).toBe(15184);
    expect(off.body.layaway).toMatchObject({ paidCents: 31000, cardAdjustmentCents: 990, balanceCents: 0, cardBalanceCents: 0 });
  });

  it("with sales tax, the tax inside the card adjustment is tracked", async () => {
    await prisma.location.update({ where: { id: w.locationId }, data: { taxRateBps: 825 } });
    // 2 x $10.00 + 8.25% = $21.65; $5 cash deposit.
    const l = (await open([{ type: "CASH", amountCents: 500 }], { lines: [{ variantId: v.nm, quantity: 2 }] })).body.layaway;
    expect(l).toMatchObject({ subtotalCents: 2000, taxCents: 165, totalCents: 2165, balanceCents: 1665 });
    // $10.00 by card: $9.62 applies, $0.38 adjustment of which $0.03 is tax (165/2165 of it).
    const a = await pay(l.id, [{ type: "CARD", amountCents: 1000, paymentToken: "tok_ok" }]);
    expect(a.body.payments[0].appliedCents).toBe(962);
    expect(a.body.layaway).toMatchObject({ paidCents: 1462, cardAdjustmentCents: 38, cardAdjustmentTaxCents: 3, balanceCents: 703, cardBalanceCents: 731 });
    const b = await pay(l.id, [{ type: "CARD", amountCents: 731, paymentToken: "tok_ok" }]);
    expect(b.body.payments[0].appliedCents).toBe(703);
    expect(b.body.layaway).toMatchObject({ paidCents: 2165, cardAdjustmentCents: 66, cardAdjustmentTaxCents: 5, balanceCents: 0 });
    const done = await w.as(w.cashier, "POST", `/layaways/${l.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.order).toMatchObject({ totalCents: 2165, taxCents: 165, cardAdjustmentCents: 66, cardAdjustmentTaxCents: 5, cardPriceBps: 399, cardTotalCents: 2251 });
  });

  it("can't take more than the balance", async () => {
    const cash = await pay(id, [{ type: "CASH", amountCents: 24801 }]);
    expect(cash.status).toBe(400);
    expect(cash.body).toMatchObject({ error: "OVERPAID", details: { balanceCents: 24800 } });
    const card = await pay(id, [{ type: "CARD", amountCents: 30000, paymentToken: "tok_ok" }]);
    expect(card.status).toBe(400);
    expect(w.gateway.calls).toEqual([]);
    // Over-tendered cash is change, not an overpayment.
    const change = await pay(id, [{ type: "CASH", amountCents: 24800, tenderedCents: 25000 }]);
    expect(change.status).toBe(201);
    expect(change.body.changeCents).toBe(200);
    expect(change.body.layaway.balanceCents).toBe(0);
    expect((await pay(id, [{ type: "CASH", amountCents: 1 }])).body.error).toBe("OVERPAID");
  });

  it("a payment is idempotent", async () => {
    const body = { tenders: [{ type: "CASH", amountCents: 1000 }], idempotencyKey: key() };
    const first = await w.as(w.cashier, "POST", `/layaways/${id}/payments`, body);
    const again = await w.as(w.cashier, "POST", `/layaways/${id}/payments`, body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.payments.map((p: any) => p.id)).toEqual(first.body.payments.map((p: any) => p.id));
    expect(again.body.layaway.paidCents).toBe(7200);
    expect(await prisma.payment.count({ where: { layawayId: id } })).toBe(2);
  });

  it("store credit needs the same approval as on a sale", async () => {
    await w.as(w.manager, "POST", `/customers/${cust}/credit`, { amountCents: 5000, reason: "Trade-in" });
    // Cashiers may take store credit by default; this store wants a manager's PIN for it.
    await w.as(w.owner, "PATCH", `/staff/${await staffId("CASHIER")}`, { permissionOverrides: { TENDER_STORE_CREDIT: "PIN" } });
    const denied = await pay(id, [{ type: "STORE_CREDIT", amountCents: 2000 }]);
    expect(denied.status).toBe(403);
    expect(denied.body.details.permission).toBe("TENDER_STORE_CREDIT");
    const ok = await withToken(w.cashier, await approve(["TENDER_STORE_CREDIT"]), "POST", `/layaways/${id}/payments`, { tenders: [{ type: "STORE_CREDIT", amountCents: 2000 }], idempotencyKey: key() });
    expect(ok.status).toBe(201);
    expect(ok.body.layaway.paidCents).toBe(8200);
    expect((await w.as(w.cashier, "GET", `/customers/${cust}`)).body.storeCreditCents).toBe(3000);
  });
});

describe("picking up", () => {
  it("needs the balance paid off", async () => {
    const id = (await open([{ type: "CASH", amountCents: 6200 }])).body.layaway.id;
    const res = await w.as(w.cashier, "POST", `/layaways/${id}/complete`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "BALANCE_DUE", details: { balanceCents: 24800 } });
    expect(await prisma.order.count()).toBe(0);
  });

  it("creates the sale with the layaway's totals and moves the payments onto it", async () => {
    await prisma.loyaltyProgram.upsert({ where: { id: "default" }, create: { id: "default", enabled: true, type: "POINTS", pointsPerDollar: 1 }, update: { enabled: true, type: "POINTS", pointsPerDollar: 1 } });
    await prisma.variant.update({ where: { id: v.shoe }, data: { costCents: 20000 } });
    const id = (await open([{ type: "CASH", amountCents: 6200 }])).body.layaway.id;
    await pay(id, [{ type: "CARD", amountCents: 10000, paymentToken: "tok_ok" }]);
    await pay(id, [{ type: "CASH", amountCents: 15184 }]);

    const res = await w.as(w.cashier, "POST", `/layaways/${id}/complete`);
    expect(res.status).toBe(200);
    const { order, layaway } = res.body;
    expect(order).toMatchObject({
      status: "PAID",
      channel: "POS",
      locationId: w.locationId,
      customerId: cust,
      staffId: await staffId("CASHIER"),
      subtotalCents: 31000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 31000,
      cardAdjustmentCents: 384,
      cardAdjustmentTaxCents: 0,
      cardPriceBps: 399,
      cardTotalCents: 32237,
      loyaltyEarned: 310,
      loyaltyUnit: "POINTS",
      loyaltyEligibleCents: 31000,
      note: `Layaway #${layaway.number}`,
    });
    expect(order.lines).toHaveLength(2);
    expect(order.lines[0]).toMatchObject({ variantId: v.shoe, quantity: 1, unitPriceCents: 30000, discountCents: 0, promoDiscountCents: 0, taxable: true, costCents: 20000, earnsLoyalty: true });
    expect(order.payments).toHaveLength(3);
    for (const p of order.payments) expect(p).toMatchObject({ layawayId: id, orderId: order.id, status: "APPROVED" });
    const byTime = [...order.payments].sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt));
    expect(byTime.map((p: any) => [p.tender, p.amountCents, p.appliedCents])).toEqual([
      ["CASH", 6200, 6200],
      ["CARD", 10000, 9616],
      ["CASH", 15184, 15184],
    ]);
    expect(layaway).toMatchObject({ status: "COMPLETED", orderId: order.id, balanceCents: 0, cancelFeePreview: null });
    expect(layaway.completedAt).toBeTruthy();
    expect(await prisma.loyaltyEntry.findMany({ where: { customerId: cust } })).toMatchObject([{ unit: "POINTS", amount: 310, orderId: order.id }]);

    // No stock moves at pick-up: it left the shelf when the layaway opened.
    expect(await onHand(v.shoe, w.locationId)).toBe(0);
    expect((await prisma.inventoryMovement.findMany({ where: { variantId: v.shoe } })).map((m) => m.reason)).toEqual(["RECEIVE", "LAYAWAY"]);

    // The sale is in the history and today's figures.
    const orders = await w.as(w.cashier, "GET", `/orders?locationId=${w.locationId}`);
    expect(orders.body.map((o: any) => o.id)).toEqual([order.id]);
    const summary = await w.as(w.manager, "GET", `/reports/summary?${today()}&locationId=${w.locationId}`);
    expect(summary.body).toMatchObject({ orders: 1, units: 2, grossCents: 31000, netSalesCents: 31000, cardAdjustmentCents: 384, collectedCents: 31384, costOfGoodsCents: 20000 });
    expect((await lastAudit("LAYAWAY_COMPLETED")).details).toEqual({ layawayId: id, number: layaway.number, orderId: order.id, orderNumber: order.number });

    // Done is done.
    expect((await w.as(w.cashier, "POST", `/layaways/${id}/complete`)).body.error).toBe("LAYAWAY_STATE");
    expect((await pay(id, [{ type: "CASH", amountCents: 100 }])).body.error).toBe("LAYAWAY_STATE");
    const cancel = await w.as(w.manager, "POST", `/layaways/${id}/cancel`, {});
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toBe("LAYAWAY_STATE");
    expect((await w.as(w.cashier, "GET", `/orders/${order.id}/receipt`)).body).toMatchObject({ orderNumber: order.number, totalCents: 31000, dualPricing: { cardAdjustmentCents: 384 } });
  });
});

describe("cancelling", () => {
  beforeEach(() => prisma.location.update({ where: { id: w.locationId }, data: { layawayCancelFeeBps: 1000 } }));

  it("cashiers need a manager's PIN; the fee is kept and the rest goes back to the original tenders, cards first", async () => {
    const opened = (await open([{ type: "CASH", amountCents: 6200 }])).body.layaway;
    const id = opened.id as string;
    await pay(id, [{ type: "CARD", amountCents: 10000, paymentToken: "tok_ok" }]);
    expect((await w.as(w.cashier, "GET", `/layaways/${id}`)).body.cancelFeePreview).toEqual({ feeCents: 3100, refundCents: 13100 });

    const denied = await w.as(w.cashier, "POST", `/layaways/${id}/cancel`, { reason: "Changed mind" });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: "APPROVAL_REQUIRED", details: { permission: "LAYAWAY_CANCEL" } });
    expect((await prisma.layaway.findUniqueOrThrow({ where: { id } })).status).toBe("ACTIVE");

    // $162 collected, 10% of $310 = $31 fee: $131 back, the card's $100 first, then $31 cash.
    const res = await w.as(w.manager, "POST", `/layaways/${id}/cancel`, { reason: "Changed mind" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ feeCents: 3100, refundedCents: 13100 });
    expect(res.body.legs).toEqual([
      { tender: "CASH", amountCents: 3100, status: "APPROVED" },
      { tender: "CARD", amountCents: 10000, status: "APPROVED" },
    ]);
    expect(res.body.layaway).toMatchObject({ status: "CANCELLED", cancelFeeCents: 3100, refundedCents: 13100, cancelReason: "Changed mind", cancelledBy: { name: "MANAGER" }, cancelFeePreview: null });
    expect(res.body.layaway.cancelledAt).toBeTruthy();
    expect(w.gateway.calls).toContainEqual({ op: "refund", ref: "mock_1", amountCents: 10000, terminal: undefined });
    const refunds = await prisma.payment.findMany({ where: { layawayId: id, amountCents: { lt: 0 } }, orderBy: { amountCents: "desc" } });
    expect(refunds.map((p) => [p.tender, p.amountCents, p.status])).toEqual([
      ["CASH", -3100, "APPROVED"],
      ["CARD", -10000, "APPROVED"],
    ]);
    expect(refunds[0]!.refundOfId).toBe(opened.payments[0].id);
    expect(refunds[1]!.gatewayRef).toBe("mock_1_r2");

    // Back on the shelf.
    expect(await onHand(v.shoe, w.locationId)).toBe(1);
    expect(await onHand(v.nm, w.locationId)).toBe(3);
    expect((await movements(v.shoe, "LAYAWAY_RETURN")).map((m) => m.delta)).toEqual([1]);
    expect(await lastAudit("LAYAWAY_CANCELLED")).toMatchObject({
      staffId: await staffId("MANAGER"),
      details: { layawayId: id, number: opened.number, feeCents: 3100, refundedCents: 13100, legs: res.body.legs, toStoreCredit: false, waived: false, reason: "Changed mind" },
    });

    // A cashier with a manager's PIN can cancel too.
    // $8.50 card, $5 down: the fee is 10% of $8.50.
    const other = (await open([{ type: "CASH", amountCents: 500 }], { lines: [{ variantId: v.lp, quantity: 1 }] })).body.layaway;
    const approved = await withToken(w.cashier, await approve(["LAYAWAY_CANCEL"]), "POST", `/layaways/${other.id}/cancel`, {});
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ feeCents: 85, refundedCents: 415, legs: [{ tender: "CASH", amountCents: 415, status: "APPROVED" }] });
    expect((await lastAudit("LAYAWAY_CANCELLED")).approverId).toBe(await staffId("MANAGER"));
  });

  it("can refund everything to store credit", async () => {
    const id = (await open([{ type: "CASH", amountCents: 6200 }])).body.layaway.id;
    const res = await w.as(w.manager, "POST", `/layaways/${id}/cancel`, { toStoreCredit: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ feeCents: 3100, refundedCents: 3100, legs: [{ tender: "STORE_CREDIT", amountCents: 3100, status: "APPROVED" }] });
    expect((await w.as(w.cashier, "GET", `/customers/${cust}`)).body.storeCreditCents).toBe(3100);
    expect(await onHand(v.shoe, w.locationId)).toBe(1);
  });

  it("waiving the fee needs LAYAWAY_MANAGE", async () => {
    const id = (await open([{ type: "CASH", amountCents: 6200 }])).body.layaway.id;
    const denied = await withToken(w.cashier, await approve(["LAYAWAY_CANCEL"]), "POST", `/layaways/${id}/cancel`, { waiveFee: true });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: "PERMISSION_DENIED", details: { permission: "LAYAWAY_MANAGE" } });
    expect((await prisma.layaway.findUniqueOrThrow({ where: { id } })).status).toBe("ACTIVE");
    const res = await w.as(w.manager, "POST", `/layaways/${id}/cancel`, { waiveFee: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ feeCents: 0, refundedCents: 6200, legs: [{ tender: "CASH", amountCents: 6200, status: "APPROVED" }] });
    expect((await lastAudit("LAYAWAY_CANCELLED")).details).toMatchObject({ feeCents: 0, waived: true });
  });

  it("cash refunds come out of the register's drawer", async () => {
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { requireDrawerSession: true });
    const t1 = (await prisma.terminal.create({ data: { locationId: w.locationId, name: "Front", gatewayRef: "T1" } })).id;
    const shift = await w.as(w.cashier, "POST", "/drawer/open", { locationId: w.locationId, terminalId: t1, openingFloatCents: 10000 });
    const id = (await open([{ type: "CASH", amountCents: 6200 }], { terminalId: t1 })).body.layaway.id;
    await w.as(w.manager, "POST", `/drawer/${shift.body.id}/close`, { countedCashCents: 16200 });
    const closed = await w.as(w.manager, "POST", `/layaways/${id}/cancel`, { terminalId: t1 });
    expect(closed.status).toBe(409);
    expect(closed.body.error).toBe("DRAWER_CLOSED");
    expect((await prisma.layaway.findUniqueOrThrow({ where: { id } })).status).toBe("ACTIVE");
    const next = await w.as(w.cashier, "POST", "/drawer/open", { locationId: w.locationId, terminalId: t1, openingFloatCents: 10000 });
    const res = await w.as(w.manager, "POST", `/layaways/${id}/cancel`, { terminalId: t1 });
    expect(res.status).toBe(200);
    const refund = await prisma.payment.findFirstOrThrow({ where: { layawayId: id, amountCents: { lt: 0 } } });
    expect(refund).toMatchObject({ tender: "CASH", amountCents: -3100, drawerSessionId: next.body.id });
    expect((await w.as(w.manager, "GET", `/drawer/${next.body.id}/report`)).body).toMatchObject({
      cash: { cashRefundsCents: 3100, expectedCents: 6900 },
      layawayPayments: { count: 0, amountCents: 0, refunds: { count: 1, amountCents: 3100, byTender: [{ tender: "CASH", count: 1, amountCents: 3100 }] } },
    });
  });
});

describe("managing", () => {
  it("extends the due date and edits the notes (LAYAWAY_MANAGE)", async () => {
    const l = (await open([{ type: "CASH", amountCents: 6200 }])).body.layaway;
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString();
    const denied = await w.as(w.cashier, "POST", `/layaways/${l.id}/extend`, { dueAt: later });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: "PERMISSION_DENIED", details: { permission: "LAYAWAY_MANAGE" } });
    expect((await w.as(w.manager, "POST", `/layaways/${l.id}/extend`, { dueAt: "2001-01-01T00:00:00Z" })).body.error).toBe("DUE_DATE");
    const res = await w.as(w.manager, "POST", `/layaways/${l.id}/extend`, { dueAt: later });
    expect(res.status).toBe(200);
    expect(res.body.dueAt).toBe(later);
    expect((await lastAudit("LAYAWAY_EXTENDED")).details).toEqual({ layawayId: l.id, number: l.number, from: l.dueAt, to: later });

    const notes = await w.as(w.manager, "PATCH", `/layaways/${l.id}`, { notes: "Call before the 15th" });
    expect(notes.status).toBe(200);
    expect(notes.body.notes).toBe("Call before the 15th");
    expect((await lastAudit("LAYAWAY_UPDATED")).details).toEqual({ layawayId: l.id, number: l.number, changes: { notes: { from: null, to: "Call before the 15th" } } });
  });
});

describe("lists, statements and reports", () => {
  it("lists layaways with their balance, and finds the overdue ones", async () => {
    const l = (await open([{ type: "CASH", amountCents: 6200 }])).body.layaway;
    expect((await w.as(w.cashier, "GET", `/layaways?overdue=true`)).body).toEqual([]);
    await prisma.layaway.update({ where: { id: l.id }, data: { dueAt: new Date(Date.now() - 86_400_000) } });
    const overdue = await w.as(w.cashier, "GET", `/layaways?overdue=true&locationId=${w.locationId}`);
    expect(overdue.status).toBe(200);
    expect(overdue.body).toHaveLength(1);
    expect(overdue.body[0]).toMatchObject({ id: l.id, number: l.number, status: "ACTIVE", overdue: true, paidCents: 6200, totalCents: 31000, balanceCents: 24800, lineCount: 2, customer: { id: cust, name: "Ash Ketchum", email: "ash@example.com", phone: "555-0100" }, staff: { name: "CASHIER" } });
    expect(overdue.body[0].lines).toBeUndefined();
    expect((await w.as(w.cashier, "GET", `/layaways/${l.id}`)).body.overdue).toBe(true);
    expect((await w.as(w.cashier, "GET", `/layaways?q=%23${l.number}`)).body).toHaveLength(1);
    expect((await w.as(w.cashier, "GET", `/layaways?q=${l.number}`)).body).toHaveLength(1);
    expect((await w.as(w.cashier, "GET", `/layaways?q=ketch`)).body).toHaveLength(1);
    expect((await w.as(w.cashier, "GET", `/layaways?q=nobody`)).body).toHaveLength(0);
    expect((await w.as(w.cashier, "GET", `/layaways?customerId=${cust}`)).body).toHaveLength(1);
    expect((await w.as(w.cashier, "GET", `/layaways?status=COMPLETED`)).body).toHaveLength(0);
  });

  it("prints a statement with the number, payments and balance", async () => {
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { receiptFooter: "Thanks for shopping local!" });
    const l = (await open([{ type: "CASH", amountCents: 6200 }])).body.layaway;
    await pay(l.id, [{ type: "CARD", amountCents: 10000, paymentToken: "tok_ok" }]);
    const json = await w.as(w.cashier, "GET", `/layaways/${l.id}/receipt`);
    expect(json.status).toBe(200);
    expect(json.body).toMatchObject({
      number: l.number,
      status: "ACTIVE",
      cashier: "CASHIER",
      customer: { name: "Ash Ketchum" },
      totalCents: 31000,
      paidCents: 15816,
      cardAdjustmentCents: 384,
      balanceCents: 15184,
      cardBalanceCents: 15790,
      dualPricing: { percent: "3.99%" },
      payments: [
        { label: "Cash", amountCents: 6200, appliedCents: 6200, deposit: true, staff: "CASHIER" },
        { label: "Card", amountCents: 10000, appliedCents: 9616, deposit: false, detail: "VISA •••• 4242" },
      ],
    });
    expect(json.body.lines).toHaveLength(2);
    expect(json.body.terms[0]).toMatch(/^Balance of \$151\.84 is due by /);

    const auth = { authorization: `Bearer ${w.cashier}` };
    const text = await w.app.inject({ method: "GET", url: `/layaways/${l.id}/receipt?format=text`, headers: auth });
    expect(text.statusCode).toBe(200);
    expect(text.headers["content-type"]).toContain("text/plain");
    expect(text.body).toContain(`LAYAWAY #${l.number}`);
    expect(text.body).toContain("Customer: Ash Ketchum");
    expect(text.body).toMatch(/Cash \(deposit\)\s+\$62\.00/);
    expect(text.body).toMatch(/applied to balance\s+\$96\.16/);
    expect(text.body).toMatch(/BALANCE DUE\s+\$151\.84/);
    expect(text.body).toMatch(/by card\s+\$157\.90/);
    expect(text.body).toContain("Thanks for shopping local!");
    for (const line of text.body.split("\n")) expect(line.length).toBeLessThanOrEqual(42);
    const narrow = await w.app.inject({ method: "GET", url: `/layaways/${l.id}/receipt?format=text&width=32`, headers: auth });
    for (const line of narrow.body.split("\n")) expect(line.length).toBeLessThanOrEqual(32);

    const html = await w.app.inject({ method: "GET", url: `/layaways/${l.id}/receipt?format=html`, headers: auth });
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain(`Layaway #${l.number}`);
    expect(html.body).toContain("$151.84");

    // Printing needs a receipt printer on a register at this location.
    const t1 = await prisma.terminal.create({ data: { locationId: w.locationId, name: "Front", gatewayRef: "T1" } });
    const noPrinter = await w.as(w.cashier, "POST", `/layaways/${l.id}/receipt/print`, { terminalId: t1.id });
    expect(noPrinter.status).toBe(400);
    expect(noPrinter.body.error).toBe("NO_PRINTER");
    expect((await w.as(w.cashier, "POST", `/layaways/${l.id}/receipt/print`, { terminalId: "nope" })).status).toBe(404);
  });

  it("reports what's owed and held on active layaways", async () => {
    const a = (await open([{ type: "CASH", amountCents: 6200 }])).body.layaway;
    await prisma.layaway.update({ where: { id: a.id }, data: { dueAt: new Date(Date.now() - 3 * 86_400_000) } });
    const b = (await open([{ type: "CASH", amountCents: 500 }], { lines: [{ variantId: v.nm, quantity: 1 }] })).body.layaway;
    await pay(b.id, [{ type: "CARD", amountCents: 100, paymentToken: "tok_ok" }]);
    // A cancelled one isn't active.
    const c = (await open([{ type: "CASH", amountCents: 850 }], { lines: [{ variantId: v.lp, quantity: 1 }] })).body.layaway;
    await w.as(w.manager, "POST", `/layaways/${c.id}/cancel`, {});

    const r = await w.as(w.manager, "GET", `/reports/layaways?locationId=${w.locationId}`);
    expect(r.status).toBe(200);
    // b: $5 cash + $1 card ($0.96 applied): $5.96 applied, $6.00 held.
    expect(r.body).toMatchObject({ active: 2, overdue: 1, balanceCents: 24800 + 404, heldCents: 6200 + 600 });
    expect(r.body.rows.map((x: any) => x.number)).toEqual([a.number, b.number]);
    expect(r.body.rows[0]).toMatchObject({ id: a.id, customer: "Ash Ketchum", lines: 2, totalCents: 31000, paidCents: 6200, collectedCents: 6200, balanceCents: 24800, overdue: true, daysOverdue: 3 });
    expect(r.body.rows[1]).toMatchObject({ id: b.id, lines: 1, totalCents: 1000, paidCents: 596, collectedCents: 600, balanceCents: 404, overdue: false, daysOverdue: 0 });
    expect((await w.as(w.cashier, "GET", "/reports/layaways")).status).toBe(403);

    const csv = await w.app.inject({ method: "GET", url: `/reports/layaways?format=csv`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("number,customerId,customer");
  });

  it("the drawer report shows layaway money taken in the shift, and the sale once it's picked up", async () => {
    const t1 = (await prisma.terminal.create({ data: { locationId: w.locationId, name: "Front", gatewayRef: "T1" } })).id;
    const shift = await w.as(w.cashier, "POST", "/drawer/open", { locationId: w.locationId, terminalId: t1, openingFloatCents: 20000 });
    const sid = shift.body.id as string;
    const opened = await open([{ type: "CASH", amountCents: 6200 }], { terminalId: t1 });
    expect(opened.body.layaway.payments[0].drawerSessionId).toBe(sid);
    const id = opened.body.layaway.id as string;

    const x = await w.as(w.manager, "GET", `/drawer/${sid}/report`);
    expect(x.status).toBe(200);
    expect(x.body).toMatchObject({
      kind: "X",
      cash: { openingFloatCents: 20000, cashSalesCents: 6200, expectedCents: 26200 },
      sales: { orders: 0, collectedCents: 0, byTender: [] },
      layawayPayments: { count: 1, amountCents: 6200, byTender: [{ tender: "CASH", count: 1, amountCents: 6200 }], refunds: { count: 0, amountCents: 0, byTender: [] } },
    });
    const auth = { authorization: `Bearer ${w.manager}` };
    const text = await w.app.inject({ method: "GET", url: `/drawer/${sid}/report?format=text`, headers: auth });
    expect(text.body).toMatch(/Layaway payments \(1\)\s+\$62\.00/);
    expect(text.body).toMatch(/EXPECTED\s+\$262\.00/);
    const html = await w.app.inject({ method: "GET", url: `/drawer/${sid}/report?format=html`, headers: auth });
    expect(html.body).toContain("Layaway payments (1)");

    // Paid off and picked up in the same shift: the money now belongs to the sale.
    await pay(id, [{ type: "CASH", amountCents: 24800 }], { terminalId: t1 });
    expect((await w.as(w.cashier, "POST", `/layaways/${id}/complete`)).status).toBe(200);
    const after = await w.as(w.manager, "GET", `/drawer/${sid}/report`);
    expect(after.body).toMatchObject({
      cash: { cashSalesCents: 31000, expectedCents: 51000 },
      sales: { orders: 1, units: 2, netSalesCents: 31000, collectedCents: 31000, byTender: [{ tender: "CASH", count: 2, amountCents: 31000 }] },
      layawayPayments: { count: 0, amountCents: 0 },
    });
    const closed = await w.as(w.manager, "POST", `/drawer/${sid}/close`, { countedCashCents: 51000 });
    expect(closed.status).toBe(200);
    expect(closed.body.report).toMatchObject({ kind: "Z", cash: { varianceCents: 0 }, layawayPayments: { count: 0 } });
  });
});
