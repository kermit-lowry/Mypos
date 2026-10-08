import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { importOrder } from "../src/channels/sync.js";
import { key, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
});
afterAll(() => prisma.$disconnect());

const address = { name: "Red Oak", line1: "1 Pallet Town Rd", line2: "Apt 2", city: "Pallet Town", state: "KS", postalCode: "66002", country: "US", phone: "555-0100" };

/** Public web-store checkout (no staff token; mock card token). Defaults: one NM Charizard for pickup. */
const webCheckout = (payload: object = {}) =>
  w.app.inject({
    method: "POST",
    url: "/storefront/checkout",
    payload: { email: "red@example.com", name: "Red", lines: [{ variantId: v.nm, quantity: 1 }], amountCents: 1083, paymentToken: "tok_ok", idempotencyKey: key(), ...payload },
  });
const quote = (payload: object) => w.app.inject({ method: "POST", url: "/storefront/quote", payload });
const settings = (data: object) => prisma.location.update({ where: { id: w.locationId }, data });
const posSale = () =>
  w.as(w.cashier, "POST", "/orders/checkout", { locationId: w.locationId, lines: [{ variantId: v.lp, quantity: 1 }], tenders: [{ type: "CASH", amountCents: 920 }], idempotencyKey: key() });
const act = (id: string, step: string, body?: object, token = w.manager) => w.as(token, "POST", `/fulfillment/orders/${id}/${step}`, body);

describe("storefront pickup and shipping", () => {
  it("defaults to pickup: a NEW pickup order with no shipping", async () => {
    await settings({ pickupInstructions: "Ask at the counter with your order number." });
    const res = await webCheckout();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: "PAID",
      fulfillment: "PICKUP",
      fulfillmentStatus: "NEW",
      shippingCents: 0,
      totalCents: 1083,
      pickupInstructions: "Ask at the counter with your order number.",
    });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.json().orderId } });
    expect(order).toMatchObject({ channel: "STOREFRONT", fulfillment: "PICKUP", fulfillmentStatus: "NEW", shippingCents: 0, subtotalCents: 1000, taxCents: 83, totalCents: 1083, shippingAddress: null });
    expect(w.gateway.lastSale?.amountCents).toBe(1083);
  });

  it("charges the flat shipping rate, untaxed, and stores the address, phone and note", async () => {
    await settings({ onlineShippingFlatCents: 599, onlineFreeShippingOverCents: 5000 });
    const q = await quote({ lines: [{ variantId: v.nm, quantity: 1 }], fulfillment: "SHIP" });
    expect(q.json()).toMatchObject({ fulfillment: "SHIP", subtotalCents: 1000, taxCents: 83, shippingCents: 599, totalCents: 1682, pickupInstructions: null });

    const wrong = await webCheckout({ fulfillment: "SHIP", shippingAddress: address, amountCents: 1083 });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("TENDER_MISMATCH");
    expect(wrong.json().details).toMatchObject({ shippingCents: 599, cardDueCents: 1682 });

    const res = await webCheckout({ fulfillment: "SHIP", shippingAddress: address, amountCents: 1682, phone: "555-0199", note: "Leave with the neighbour" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ fulfillment: "SHIP", fulfillmentStatus: "NEW", shippingCents: 599, totalCents: 1682, shippingAddress: address });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.json().orderId }, include: { payments: true, customer: true } });
    expect(order).toMatchObject({ fulfillment: "SHIP", subtotalCents: 1000, taxCents: 83, shippingCents: 599, totalCents: 1682, cardTotalCents: 1682, customerPhone: "555-0199", customerNote: "Leave with the neighbour" });
    expect(order.shippingAddress).toEqual(address);
    expect(order.payments[0]).toMatchObject({ tender: "CARD", amountCents: 1682 });
    expect(order.customer?.phone).toBe("555-0199");
    expect(w.gateway.lastSale?.amountCents).toBe(1682);

    // Receipts show the shipping line and a total that includes it.
    const text = await w.app.inject({ method: "GET", url: `/orders/${order.id}/receipt?format=text`, headers: { authorization: `Bearer ${w.cashier}` } });
    expect(text.body).toMatch(/Shipping\s+\$5\.99/);
    expect(text.body).toMatch(/TOTAL\s+\$16\.82/);
    const json = await w.as(w.cashier, "GET", `/orders/${order.id}/receipt`);
    expect(json.body).toMatchObject({ shippingCents: 599, totalCents: 1682 });
  });

  it("ships free once the goods reach the threshold", async () => {
    await settings({ onlineShippingFlatCents: 599, onlineFreeShippingOverCents: 2500 });
    const lines = [{ variantId: v.nm, quantity: 2 }, { variantId: v.lp, quantity: 1 }];
    const q = await quote({ lines, fulfillment: "SHIP" });
    // 2 x $10 + $8.50 = $28.50 goods ≥ $25 → free; tax 8.25% = $2.35
    expect(q.json()).toMatchObject({ subtotalCents: 2850, shippingCents: 0, totalCents: 3085 });
    const res = await webCheckout({ lines, fulfillment: "SHIP", shippingAddress: address, amountCents: 3085 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ fulfillment: "SHIP", shippingCents: 0, totalCents: 3085 });
  });

  it("with dual pricing the card pays the goods at the card price plus shipping as-is", async () => {
    await settings({ cardPriceBps: 399, onlineShippingFlatCents: 599 });
    // $10.00 → $10.40 card; + 8.25% = $11.26; + $5.99 shipping = $17.25
    const q = await quote({ lines: [{ variantId: v.nm, quantity: 1 }], fulfillment: "SHIP" });
    expect(q.json()).toMatchObject({ subtotalCents: 1040, taxCents: 86, shippingCents: 599, totalCents: 1725 });
    const res = await webCheckout({ fulfillment: "SHIP", shippingAddress: address, amountCents: 1725 });
    expect(res.statusCode).toBe(201);
    expect(res.json().totalCents).toBe(1725);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.json().orderId } });
    expect(order).toMatchObject({ totalCents: 1682, cardAdjustmentCents: 43, cardAdjustmentTaxCents: 3, cardTotalCents: 1725, shippingCents: 599 });
    expect(w.gateway.lastSale?.amountCents).toBe(1725);
    const text = await w.app.inject({ method: "GET", url: `/orders/${order.id}/receipt?format=text`, headers: { authorization: `Bearer ${w.cashier}` } });
    expect(text.body).toMatch(/Shipping\s+\$5\.99/);
    expect(text.body).toMatch(/TOTAL \(card price\)\s+\$17\.25/);
  });

  it("refuses a method the store turned off, and shipping without an address", async () => {
    await settings({ onlineShippingEnabled: false });
    const q = await quote({ lines: [{ variantId: v.nm, quantity: 1 }], fulfillment: "SHIP" });
    expect(q.statusCode).toBe(400);
    expect(q.json().error).toBe("FULFILLMENT_DISABLED");
    const ship = await webCheckout({ fulfillment: "SHIP", shippingAddress: address });
    expect(ship.statusCode).toBe(400);
    expect(ship.json().error).toBe("FULFILLMENT_DISABLED");

    await settings({ onlineShippingEnabled: true, onlinePickupEnabled: false });
    const pickup = await webCheckout({ fulfillment: "PICKUP" });
    expect(pickup.statusCode).toBe(400);
    expect(pickup.json().error).toBe("FULFILLMENT_DISABLED");

    const noAddress = await webCheckout({ fulfillment: "SHIP" });
    expect(noAddress.statusCode).toBe(400);
    expect(noAddress.json().error).toBe("SHIPPING_ADDRESS");
    expect(await prisma.order.count()).toBe(0);
  });

  it("tells the store what's on offer", async () => {
    await settings({ onlineShippingFlatCents: 799, onlineFreeShippingOverCents: 7500, pickupInstructions: "Side door, ring the bell." });
    const res = await w.app.inject({ method: "GET", url: "/storefront/fulfillment" });
    expect(res.json()).toEqual({ pickup: true, shipping: true, shippingFlatCents: 799, freeShippingOverCents: 7500, pickupInstructions: "Side door, ring the bell." });
    await settings({ onlinePickupEnabled: false, onlineFreeShippingOverCents: null });
    expect((await w.app.inject({ method: "GET", url: "/storefront/fulfillment" })).json()).toMatchObject({ pickup: false, freeShippingOverCents: null });
  });

  it("owners set the online options; changes are logged", async () => {
    const res = await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { onlineShippingFlatCents: 499, onlineFreeShippingOverCents: 10000, onlinePickupEnabled: false, pickupInstructions: "Counter." });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ onlineShippingFlatCents: 499, onlineFreeShippingOverCents: 10000, onlinePickupEnabled: false, pickupInstructions: "Counter." });
    expect((await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { onlineShippingFlatCents: 100001 })).status).toBe(400);
    const log = await prisma.auditEvent.findFirst({ where: { action: "SETTINGS_UPDATED" } });
    expect((log?.details as any).changes).toMatchObject({ onlineShippingFlatCents: { from: 0, to: 499 }, onlinePickupEnabled: { from: true, to: false } });
  });
});

describe("channel imports", () => {
  it("imported orders join the queue as NEW shipping orders with the buyer's address", async () => {
    await prisma.channelListing.create({ data: { channel: "SHOPIFY", externalId: "shop-nm", variantId: v.nm } });
    const r = await importOrder(prisma, "SHOPIFY", w.locationId, {
      externalId: "1001",
      createdAt: new Date(),
      customerEmail: "blue@example.com",
      customerName: "Blue",
      customerPhone: "555-0123",
      lines: [{ listingId: "shop-nm", quantity: 1, unitPriceCents: 1000 }],
      taxCents: 83,
      shippingCents: 599,
      totalCents: 1682,
      shippingAddress: { name: "Blue", line1: "2 Viridian Way", city: "Viridian", postalCode: "66003" },
    });
    expect(r).toEqual({ imported: true, unmatched: [] });
    const order = await prisma.order.findFirstOrThrow({ where: { channel: "SHOPIFY" }, include: { customer: true } });
    expect(order).toMatchObject({ fulfillment: "SHIP", fulfillmentStatus: "NEW", shippingCents: 599, totalCents: 1682, customerPhone: "555-0123" });
    expect(order.shippingAddress).toEqual({ name: "Blue", line1: "2 Viridian Way", city: "Viridian", postalCode: "66003" });
    expect(order.customer?.phone).toBe("555-0123");

    // Adapters that don't know about fulfillment still import (defaults).
    await prisma.channelListing.create({ data: { channel: "EBAY", externalId: "ebay-lp", variantId: v.lp } });
    await importOrder(prisma, "EBAY", w.locationId, { externalId: "e-1", createdAt: new Date(), lines: [{ listingId: "ebay-lp", quantity: 1, unitPriceCents: 850 }], taxCents: 0, totalCents: 850 });
    expect(await prisma.order.findFirstOrThrow({ where: { channel: "EBAY" } })).toMatchObject({ fulfillment: "SHIP", fulfillmentStatus: "NEW", shippingCents: 0, shippingAddress: null });

    const queue = await w.as(w.cashier, "GET", `/fulfillment/queue?locationId=${w.locationId}`);
    expect(queue.body.counts).toMatchObject({ NEW: 2, total: 2 });
    expect(queue.body.latest.map((o: any) => o.channel).sort()).toEqual(["EBAY", "SHOPIFY"]);
  });
});

describe("queue", () => {
  it("counts open orders, flags new ones since the last poll, lists the newest; POS sales never appear", async () => {
    const first = (await webCheckout()).json();
    await new Promise((r) => setTimeout(r, 20));
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const second = (await webCheckout({ email: "green@example.com", name: "Green", lines: [{ variantId: v.lp, quantity: 2 }], amountCents: 1840 })).json();
    const pos = (await posSale()).body.order;
    expect(pos.fulfillment).toBeNull();
    expect(pos.fulfillmentStatus).toBeNull();

    const queue = await w.as(w.cashier, "GET", `/fulfillment/queue?locationId=${w.locationId}&since=${encodeURIComponent(since)}`);
    expect(queue.status).toBe(200);
    expect(queue.body.counts).toEqual({ NEW: 2, ACKNOWLEDGED: 0, PICKING: 0, READY: 0, PROBLEM: 0, total: 2 });
    expect(queue.body.newSince).toBe(1);
    expect(queue.body.latest.map((o: any) => o.number)).toEqual([second.orderNumber, first.orderNumber]);
    expect(queue.body.latest[0]).toMatchObject({ channel: "STOREFRONT", fulfillment: "PICKUP", fulfillmentStatus: "NEW", customer: { name: "Green" }, items: 2, totalCents: 1840 });
    expect((await w.as(w.cashier, "GET", `/fulfillment/queue`)).body.newSince).toBe(2);

    const list = await w.as(w.cashier, "GET", `/fulfillment/orders?locationId=${w.locationId}`);
    expect(list.body.map((o: any) => o.number)).toEqual([second.orderNumber, first.orderNumber]);
    expect(list.body[0]).toMatchObject({
      channel: "STOREFRONT",
      fulfillment: "PICKUP",
      fulfillmentStatus: "NEW",
      customer: { name: "Green", email: "green@example.com" },
      items: 2,
      pickedLineIds: [],
      totals: { subtotalCents: 1700, taxCents: 140, shippingCents: 0, totalCents: 1840, chargedCents: 1840 },
      fulfilledBy: null,
    });
    expect(list.body[0].lines[0]).toMatchObject({ title: "Charizard ex (LP / HOLO)", sku: "PKM-OBF-125-LP", quantity: 2, picked: false, imageUrl: null });
    expect(list.body[0].ageMinutes).toBe(0);
    expect(list.body.some((o: any) => o.id === pos.id)).toBe(false);
    // Search by number and by customer; filter by method.
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders?q=%23${first.orderNumber}`)).body.map((o: any) => o.number)).toEqual([first.orderNumber]);
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders?q=green`)).body).toHaveLength(1);
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders?fulfillment=SHIP`)).body).toHaveLength(0);
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders?status=bogus`)).status).toBe(400);
    // Reading needs a signed-in employee.
    expect((await w.app.inject({ method: "GET", url: "/fulfillment/queue" })).statusCode).toBe(401);
  });
});

describe("pickup flow", () => {
  it("acknowledge → pick (partial, then all) → ready → picked up, with timestamps and audit rows", async () => {
    const placed = (await webCheckout({ lines: [{ variantId: v.nm, quantity: 1 }, { variantId: v.lp, quantity: 1 }], amountCents: 2003 })).json();
    const id = placed.orderId as string;
    const lines = (await w.as(w.cashier, "GET", `/fulfillment/orders/${id}`)).body.lines;
    expect(lines).toHaveLength(2);

    const ack = await act(id, "acknowledge");
    expect(ack.status).toBe(200);
    expect(ack.body.fulfillmentStatus).toBe("ACKNOWLEDGED");
    expect(ack.body.acknowledgedAt).toBeTruthy();
    expect(ack.body.fulfilledBy).toEqual({ id: expect.any(String), name: "MANAGER" });

    const partial = await act(id, "pick", { pickedLineIds: [lines[0].id] });
    expect(partial.status).toBe(200);
    expect(partial.body.fulfillmentStatus).toBe("PICKING");
    expect(partial.body.pickedLineIds).toEqual([lines[0].id]);
    expect(partial.body.lines.map((l: any) => l.picked)).toEqual([true, false]);
    expect((await act(id, "pick", { pickedLineIds: ["nope"] })).body.error).toBe("LINE_IDS");

    const early = await act(id, "ready");
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("NOT_ALL_PICKED");
    expect(early.body.details.missingLineIds).toEqual([lines[1].id]);

    await act(id, "pick", { pickedLineIds: [lines[0].id, lines[1].id] });
    const ready = await act(id, "ready");
    expect(ready.status).toBe(200);
    expect(ready.body.fulfillmentStatus).toBe("READY");
    expect(ready.body.readyAt).toBeTruthy();

    // It's a pickup order: shipping it makes no sense.
    const ship = await act(id, "ship", { carrier: "USPS" });
    expect(ship.status).toBe(400);
    expect(ship.body.error).toBe("FULFILLMENT_METHOD");

    const done = await act(id, "picked-up", { note: "Showed ID" }, w.cashier);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ fulfillmentStatus: "PICKED_UP", fulfilledBy: { name: "CASHIER" } });
    expect(done.body.pickedUpAt).toBeTruthy();
    expect(done.body.timeline.map((t: any) => t.event)).toEqual(["ORDER_PLACED", "ORDER_ACKNOWLEDGED", "ORDER_PICKED", "ORDER_PICKED", "ORDER_READY", "ORDER_PICKED_UP"]);
    expect(done.body.timeline.at(-1)).toMatchObject({ by: "CASHIER", note: "Showed ID" });

    const order = await prisma.order.findUniqueOrThrow({ where: { id } });
    expect(order.acknowledgedAt).toBeTruthy();
    expect(order.readyAt).toBeTruthy();
    expect(order.pickedUpAt).toBeTruthy();
    expect(order.shippedAt).toBeNull();
    expect(order.pickedLineIds).toEqual([lines[0].id, lines[1].id]);

    const events = await prisma.auditEvent.findMany({ where: { action: { startsWith: "ORDER_" } }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.action)).toEqual(["ORDER_ACKNOWLEDGED", "ORDER_PICKED", "ORDER_PICKED", "ORDER_READY", "ORDER_PICKED_UP"]);
    for (const e of events) {
      expect(e.locationId).toBe(w.locationId);
      expect(e.details).toMatchObject({ orderId: id, orderNumber: placed.orderNumber, channel: "STOREFRONT", fulfillment: "PICKUP" });
    }
    expect(events[1]!.details).toMatchObject({ pickedLineIds: [lines[0].id], picked: 1, of: 2 });
    expect(events[4]!.details).toMatchObject({ note: "Showed ID", from: "READY", to: "PICKED_UP" });

    // Done: out of the queue.
    expect((await w.as(w.cashier, "GET", `/fulfillment/queue`)).body.counts.total).toBe(0);
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders`)).body).toHaveLength(0);
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders?status=PICKED_UP`)).body.map((o: any) => o.id)).toEqual([id]);
  });

  it("ready can be forced before every line is ticked", async () => {
    const id = (await webCheckout()).json().orderId;
    await act(id, "acknowledge");
    expect((await act(id, "ready")).status).toBe(409);
    const forced = await act(id, "ready", { force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.fulfillmentStatus).toBe("READY");
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: "ORDER_READY" } });
    expect(ev.details).toMatchObject({ forced: true });
  });
});

describe("shipping flow", () => {
  it("ships with a carrier and tracking number from READY, or straight from PICKING", async () => {
    await settings({ onlineShippingFlatCents: 599 });
    const a = (await webCheckout({ fulfillment: "SHIP", shippingAddress: address, amountCents: 1682 })).json().orderId as string;
    const b = (await webCheckout({ fulfillment: "SHIP", shippingAddress: address, amountCents: 1682, email: "b@example.com", name: "Bee" })).json().orderId as string;

    const aLines = (await w.as(w.cashier, "GET", `/fulfillment/orders/${a}`)).body.lines;
    await act(a, "acknowledge");
    await act(a, "pick", { pickedLineIds: aLines.map((l: any) => l.id) });
    await act(a, "ready");
    expect((await act(a, "picked-up")).body.error).toBe("FULFILLMENT_METHOD");
    expect((await act(a, "ship", {})).status).toBe(400);
    const shipped = await act(a, "ship", { carrier: "USPS", trackingNumber: "9400 1000 0000 0000 0000 00", note: "Priority" });
    expect(shipped.status).toBe(200);
    expect(shipped.body).toMatchObject({ fulfillmentStatus: "SHIPPED", carrier: "USPS", trackingNumber: "9400 1000 0000 0000 0000 00" });
    expect(shipped.body.shippedAt).toBeTruthy();
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: "ORDER_SHIPPED" } });
    expect(ev.details).toMatchObject({ orderId: a, fulfillment: "SHIP", carrier: "USPS", trackingNumber: "9400 1000 0000 0000 0000 00", note: "Priority" });

    // From PICKING: readyAt is stamped on the way out.
    const bLines = (await w.as(w.cashier, "GET", `/fulfillment/orders/${b}`)).body.lines;
    await act(b, "pick", { pickedLineIds: bLines.map((l: any) => l.id) });
    const quick = await act(b, "ship", { carrier: "UPS" });
    expect(quick.status).toBe(200);
    expect(quick.body).toMatchObject({ fulfillmentStatus: "SHIPPED", carrier: "UPS", trackingNumber: null });
    expect(quick.body.readyAt).toBeTruthy();
    expect(quick.body.acknowledgedAt).toBeTruthy();
    expect(quick.body.timeline.map((t: any) => t.event)).toEqual(["ORDER_PLACED", "ORDER_ACKNOWLEDGED", "ORDER_PICKED", "ORDER_READY", "ORDER_SHIPPED"]);

    expect((await w.as(w.cashier, "GET", `/fulfillment/queue`)).body.counts.total).toBe(0);
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders?q=9400`)).body).toHaveLength(0); // shipped orders are closed out of the default list
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders?q=9400&status=SHIPPED`)).body.map((o: any) => o.id)).toEqual([a]);
  });
});

describe("problems and wrong transitions", () => {
  it("flags a problem with a note, reopens it, and refuses steps out of order", async () => {
    const id = (await webCheckout()).json().orderId as string;
    expect((await act(id, "problem", {})).status).toBe(400);
    const flagged = await act(id, "problem", { note: "Card is damaged; emailing the customer" });
    expect(flagged.status).toBe(200);
    expect(flagged.body).toMatchObject({ fulfillmentStatus: "PROBLEM", problemNote: "Card is damaged; emailing the customer" });
    expect(flagged.body.timeline.at(-1)).toMatchObject({ event: "ORDER_PROBLEM", by: "MANAGER", note: "Card is damaged; emailing the customer" });
    const queue = await w.as(w.cashier, "GET", `/fulfillment/queue`);
    expect(queue.body.counts).toMatchObject({ PROBLEM: 1, NEW: 0, total: 1 });
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders?status=PROBLEM`)).body[0]).toMatchObject({ id, problemNote: "Card is damaged; emailing the customer" });

    // Parked orders can't be picked or made ready until reopened.
    expect((await act(id, "acknowledge")).status).toBe(409);
    expect((await act(id, "ready", { force: true })).status).toBe(409);
    const reopened = await act(id, "reopen");
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ fulfillmentStatus: "ACKNOWLEDGED", problemNote: null });
    expect(reopened.body.acknowledgedAt).toBeTruthy();
    expect((await prisma.auditEvent.findMany({ where: { action: { in: ["ORDER_PROBLEM", "ORDER_REOPENED"] } } })).length).toBe(2);

    // Wrong order of steps → 409 with the current status.
    const pickedUp = await act(id, "picked-up");
    expect(pickedUp.status).toBe(409);
    expect(pickedUp.body.error).toBe("FULFILLMENT_STATE");
    expect(pickedUp.body.details).toMatchObject({ status: "ACKNOWLEDGED", allowed: ["READY"] });
    expect((await act(id, "acknowledge")).status).toBe(409); // already acknowledged
    expect((await act(id, "reopen")).status).toBe(409); // nothing to reopen
    expect((await act(id, "ship", { carrier: "USPS" })).status).toBe(409); // not picked yet (and a pickup order, but state is checked first)

    // A register sale isn't an online order.
    const pos = (await posSale()).body.order;
    expect((await act(pos.id, "acknowledge")).status).toBe(404);
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders/${pos.id}`)).status).toBe(404);
  });

  it("a refunded order leaves the queue", async () => {
    const placed = (await webCheckout()).json();
    const id = placed.orderId as string;
    await act(id, "acknowledge");
    const lines = (await prisma.orderLine.findMany({ where: { orderId: id } })).map((l) => ({ orderLineId: l.id, quantity: l.quantity }));
    const refund = await w.as(w.manager, "POST", `/orders/${id}/refund`, { lines });
    expect(refund.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe("REFUNDED");
    expect((await w.as(w.cashier, "GET", `/fulfillment/queue`)).body.counts.total).toBe(0);
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders`)).body).toHaveLength(0);
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders?includeClosed=true`)).body.map((o: any) => o.id)).toEqual([id]);
    const blocked = await act(id, "ready", { force: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({ status: "ACKNOWLEDGED", orderStatus: "REFUNDED" });
    // The refund shows in the order's history.
    const detail = await w.as(w.cashier, "GET", `/fulfillment/orders/${id}`);
    expect(detail.body.timeline.map((t: any) => t.event)).toEqual(["ORDER_PLACED", "ORDER_ACKNOWLEDGED", "REFUND"]);
  });
});

describe("permissions", () => {
  it("cashiers fulfill by default; with FULFILL_ORDERS denied they can look but not act", async () => {
    const id = (await webCheckout()).json().orderId as string;
    expect((await act(id, "acknowledge", undefined, w.cashier)).status).toBe(200);
    const cashier = await prisma.staff.findUniqueOrThrow({ where: { email: "cashier@shop.test" } });
    expect((await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { FULFILL_ORDERS: "DENY" } })).status).toBe(200);
    const denied = await act(id, "ready", { force: true }, w.cashier);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("PERMISSION_DENIED");
    expect((await w.as(w.cashier, "GET", `/fulfillment/queue`)).status).toBe(200);
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders/${id}`)).status).toBe(200);
    expect((await act(id, "ready", { force: true }, w.manager)).status).toBe(200);
  });
});

describe("pick ticket", () => {
  it("renders text and HTML and prints on the register's receipt printer", async () => {
    await settings({ onlineShippingFlatCents: 599, receiptFooter: "Thanks!" });
    const pickup = (await webCheckout({ lines: [{ variantId: v.nm, quantity: 2 }], amountCents: 2165, note: "Gift, please no prices" })).json();
    const auth = { authorization: `Bearer ${w.cashier}` };
    const lines = (await w.as(w.cashier, "GET", `/fulfillment/orders/${pickup.orderId}`)).body.lines;
    await act(pickup.orderId, "pick", { pickedLineIds: [lines[0].id] });

    const json = await w.as(w.cashier, "GET", `/fulfillment/orders/${pickup.orderId}/pick-ticket`);
    expect(json.status).toBe(200);
    expect(json.body).toMatchObject({
      orderNumber: pickup.orderNumber,
      channel: "STOREFRONT",
      fulfillment: "PICKUP",
      customer: { name: "Red", email: "red@example.com" },
      customerNote: "Gift, please no prices",
      items: 2,
      subtotalCents: 2000,
      taxCents: 165,
      shippingCents: 0,
      totalCents: 2165,
      setAsideBy: null,
      lines: [{ sku: "PKM-OBF-125-NM", quantity: 2, picked: true, unitCents: 1000, totalCents: 2000 }],
      payments: [{ label: "Card", amountCents: 2165, detail: "VISA •••• 4242" }],
    });

    const text = await w.app.inject({ method: "GET", url: `/fulfillment/orders/${pickup.orderId}/pick-ticket?format=text`, headers: auth });
    expect(text.statusCode).toBe(200);
    expect(text.headers["content-type"]).toContain("text/plain");
    expect(text.body).toContain(`PICK TICKET  Order #${pickup.orderNumber}`);
    expect(text.body).toContain("IN-STORE PICKUP");
    expect(text.body).toContain("[x] 2 x Charizard ex (NM / HOLO)");
    expect(text.body).toContain("PKM-OBF-125-NM");
    expect(text.body).toContain("Gift, please no prices");
    expect(text.body).toMatch(/TOTAL PAID\s+\$21\.65/);
    expect(text.body).toContain("Set aside by");
    expect(text.body).toContain("Thanks!");
    for (const line of text.body.split("\n")) expect(line.length).toBeLessThanOrEqual(42);
    const narrow = await w.app.inject({ method: "GET", url: `/fulfillment/orders/${pickup.orderId}/pick-ticket?format=text&width=32`, headers: auth });
    for (const line of narrow.body.split("\n")) expect(line.length).toBeLessThanOrEqual(32);

    const html = await w.app.inject({ method: "GET", url: `/fulfillment/orders/${pickup.orderId}/pick-ticket?format=html`, headers: auth });
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain(`Pick ticket · Order #${pickup.orderNumber}`);
    expect(html.body).toContain("PKM-OBF-125-NM");
    expect(html.body).toContain("$21.65");

    // A shipping order gets a packing slip with the address.
    const ship = (await webCheckout({ fulfillment: "SHIP", shippingAddress: address, amountCents: 1682, email: "ship@example.com", name: "Shipper" })).json();
    const slip = await w.app.inject({ method: "GET", url: `/fulfillment/orders/${ship.orderId}/pick-ticket?format=text`, headers: auth });
    expect(slip.body).toContain(`PACKING SLIP  Order #${ship.orderNumber}`);
    expect(slip.body).toContain("SHIP TO");
    expect(slip.body).toContain("1 Pallet Town Rd");
    expect(slip.body).toContain("Pallet Town, KS 66002");
    expect(slip.body).toMatch(/Shipping\s+\$5\.99/);
    expect(slip.body).toContain("[ ] 1 x Charizard ex (NM / HOLO)");
    const slipHtml = await w.app.inject({ method: "GET", url: `/fulfillment/orders/${ship.orderId}/pick-ticket?format=html`, headers: auth });
    expect(slipHtml.body).toContain("Packing slip");
    expect(slipHtml.body).toContain("SHIP TO");

    // Once ready, the ticket names who set it aside.
    await act(pickup.orderId, "pick", { pickedLineIds: [lines[0].id] });
    await act(pickup.orderId, "ready");
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders/${pickup.orderId}/pick-ticket`)).body.setAsideBy).toBe("MANAGER");

    // Printing needs a receipt printer on a register at this location.
    const t1 = await prisma.terminal.create({ data: { locationId: w.locationId, name: "Front", gatewayRef: "T1" } });
    const noPrinter = await w.as(w.cashier, "POST", `/fulfillment/orders/${pickup.orderId}/pick-ticket/print`, { terminalId: t1.id });
    expect(noPrinter.status).toBe(400);
    expect(noPrinter.body.error).toBe("NO_PRINTER");
    expect((await w.as(w.cashier, "POST", `/fulfillment/orders/${pickup.orderId}/pick-ticket/print`, { terminalId: "nope" })).status).toBe(404);
    const other = await prisma.location.create({ data: { name: "Annex" } });
    const t2 = await prisma.terminal.create({ data: { locationId: other.id, name: "Annex", gatewayRef: "T2" } });
    expect((await w.as(w.cashier, "POST", `/fulfillment/orders/${pickup.orderId}/pick-ticket/print`, { terminalId: t2.id })).body.error).toBe("TERMINAL");
    const pos = (await posSale()).body.order;
    expect((await w.as(w.cashier, "GET", `/fulfillment/orders/${pos.id}/pick-ticket`)).status).toBe(404);
  });
});

describe("dashboard and report", () => {
  const range = () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    return `from=${from}&to=${to}`;
  };

  it("the dashboard counts online orders waiting", async () => {
    await settings({ onlineShippingFlatCents: 599 });
    const a = (await webCheckout()).json().orderId as string;
    const b = (await webCheckout({ fulfillment: "SHIP", shippingAddress: address, amountCents: 1682, email: "b@example.com", name: "Bee" })).json().orderId as string;
    await webCheckout({ email: "c@example.com", name: "Cee" });
    await posSale();
    await act(a, "ready", { force: true });
    await act(b, "problem", { note: "Address incomplete" });
    const d = await w.as(w.manager, "GET", `/dashboard?locationId=${w.locationId}`);
    expect(d.status).toBe(200);
    expect(d.body.onlineOrders).toEqual({ open: 3, new: 1, ready: 1 });
    await act(a, "picked-up");
    expect((await w.as(w.manager, "GET", `/dashboard`)).body.onlineOrders).toEqual({ open: 2, new: 1, ready: 0 });
  });

  it("the fulfillment report groups by channel and method with times, and downloads as CSV", async () => {
    await settings({ onlineShippingFlatCents: 599 });
    const a = (await webCheckout()).json();
    const b = (await webCheckout({ fulfillment: "SHIP", shippingAddress: address, amountCents: 1682, email: "b@example.com", name: "Bee" })).json();
    await webCheckout({ email: "c@example.com", name: "Cee" });
    await posSale();
    await act(a.orderId, "ready", { force: true });
    await act(a.orderId, "picked-up");
    await act(b.orderId, "ship", { carrier: "USPS" }); // 409: not picked
    const bLines = (await w.as(w.cashier, "GET", `/fulfillment/orders/${b.orderId}`)).body.lines;
    await act(b.orderId, "pick", { pickedLineIds: bLines.map((l: any) => l.id) });
    await act(b.orderId, "ship", { carrier: "USPS", trackingNumber: "TRK1" });
    // Make the first order look like it took 30 minutes to be ready and 45 to hand over.
    const placed = new Date(Date.now() - 45 * 60_000);
    await prisma.order.update({ where: { id: a.orderId }, data: { createdAt: placed, readyAt: new Date(placed.getTime() + 30 * 60_000), pickedUpAt: new Date(placed.getTime() + 45 * 60_000) } });

    const r = await w.as(w.manager, "GET", `/reports/fulfillment?${range()}&locationId=${w.locationId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ orders: 3, done: 2, open: 1, openNow: 1, avgMinutesToReady: 15, avgMinutesToDone: 23 });
    expect(r.body.byChannel).toEqual([
      { channel: "STOREFRONT", method: "PICKUP", orders: 2, done: 1, open: 1, problems: 0, avgMinutesToReady: 30, avgMinutesToDone: 45, totalCents: 2166 },
      { channel: "STOREFRONT", method: "SHIP", orders: 1, done: 1, open: 0, problems: 0, avgMinutesToReady: 0, avgMinutesToDone: 0, totalCents: 1682 },
    ]);
    expect(r.body.rows.map((x: any) => x.number)).toEqual([a.orderNumber, b.orderNumber, a.orderNumber + 2]);
    expect(r.body.rows[0]).toMatchObject({ channel: "STOREFRONT", method: "PICKUP", status: "PICKED_UP", customer: "Red", minutesToReady: 30, minutes: 45, open: false });
    expect(r.body.rows[1]).toMatchObject({ method: "SHIP", status: "SHIPPED", minutes: 0, open: false, shippingCents: 599 });
    expect(r.body.rows[2]).toMatchObject({ status: "NEW", ready: null, done: null, minutes: null, open: true });
    expect(r.body.rows.some((x: any) => x.method === null)).toBe(false); // POS sales aren't in it

    const csv = await w.app.inject({ method: "GET", url: `/reports/fulfillment?${range()}&format=csv`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const [header, ...body] = csv.body.split("\n");
    expect(header).toBe("number,channel,method,status,orderStatus,customer,created,acknowledged,ready,done,minutesToReady,minutes,open,shippingCents,totalCents");
    expect(body).toHaveLength(3);
    expect(body[0]).toContain(`${a.orderNumber},STOREFRONT,PICKUP,PICKED_UP,PAID,Red,`);
    expect((await w.as(w.cashier, "GET", `/reports/fulfillment?${range()}`)).status).toBe(403);
  });
});
