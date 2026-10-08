import { createServer } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
  // Card price = cash + 4%
  await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { cardPriceBps: 400, receiptFooter: "Thanks for shopping local!" });
});
afterAll(() => prisma.$disconnect());

// 2 x $10.00 cash -> $21.65 with tax; card -> 2 x $10.40 = $20.80 + $1.72 = $22.52
const sell = (tenders: object[], lines: object[] = [{ variantId: v.nm, quantity: 2 }]) =>
  w.as(w.cashier, "POST", "/orders/checkout", { locationId: w.locationId, lines, tenders, idempotencyKey: key() });

describe("dual pricing settings", () => {
  it("only the owner sets the percentage, capped at 10%", async () => {
    expect((await w.as(w.manager, "PATCH", `/locations/${w.locationId}`, { cardPriceBps: 300 })).status).toBe(403);
    expect((await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { cardPriceBps: 1500 })).status).toBe(400);
  });

  it("every settings change is logged with what changed", async () => {
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { cardPriceBps: 350, taxRateBps: 825 });
    const log = await w.as(w.manager, "GET", "/audit?action=SETTINGS_UPDATED");
    expect(log.body).toHaveLength(2);
    // Only what actually changed: the tax rate was already 825.
    expect(log.body[0]).toMatchObject({ staffName: "OWNER", locationId: w.locationId, details: { changes: { cardPriceBps: { from: 400, to: 350 } } } });
    expect(log.body[0].details.changes).not.toHaveProperty("taxRateBps");
    expect(log.body[1].details.changes).toEqual({ cardPriceBps: { from: 0, to: 400 }, receiptFooter: { from: null, to: "Thanks for shopping local!" } });
  });
});

describe("checkout", () => {
  it("cash pays the cash price", async () => {
    const res = await sell([{ type: "CASH", amountCents: 2165 }]);
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ totalCents: 2165, cardAdjustmentCents: 0, cardTotalCents: 2252 });
  });

  it("card pays the card price, and the cash price is rejected", async () => {
    const atCash = await sell([{ type: "CARD", amountCents: 2165, paymentToken: "tok_ok" }]);
    expect(atCash.status).toBe(400);
    expect(atCash.body.details).toMatchObject({ cashTotalCents: 2165, cardTotalCents: 2252, cardDueCents: 2252 });
    expect(w.gateway.calls).toHaveLength(0);

    const res = await sell([{ type: "CARD", amountCents: 2252, paymentToken: "tok_ok" }]);
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ totalCents: 2165, cardAdjustmentCents: 87, cardAdjustmentTaxCents: 7, cardPriceBps: 400 });
    expect(res.body.order.payments[0].amountCents).toBe(2252);
  });

  it("splits: the card share pays card price on what's left", async () => {
    const res = await sell([{ type: "CASH", amountCents: 1000 }, { type: "CARD", amountCents: 1212, paymentToken: "tok_ok" }]);
    expect(res.status).toBe(201);
    expect(res.body.order.cardAdjustmentCents).toBe(47);
  });

  it("store credit pays the cash price", async () => {
    const c = await w.as(w.cashier, "POST", "/customers", { name: "Ash" });
    await w.as(w.manager, "POST", `/customers/${c.body.id}/credit`, { amountCents: 5000, reason: "Trade-in" });
    const res = await w.as(w.cashier, "POST", "/orders/checkout", {
      locationId: w.locationId,
      customerId: c.body.id,
      lines: [{ variantId: v.nm, quantity: 2 }],
      tenders: [{ type: "STORE_CREDIT", amountCents: 2165 }],
      idempotencyKey: key(),
    });
    expect(res.status).toBe(201);
  });
});

describe("refunds", () => {
  it("refund a card-priced sale at what was paid, exactly", async () => {
    const res = await sell([{ type: "CARD", amountCents: 2252, paymentToken: "tok_ok" }]);
    const lineId = res.body.order.lines[0].id;
    const a = await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: lineId, quantity: 1 }] });
    const b = await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: lineId, quantity: 1 }] });
    expect(a.body.refundCents).toBe(1126);
    expect(a.body.refundCents + b.body.refundCents).toBe(2252);
  });

  it("a cash sale refunds at the cash price", async () => {
    const res = await sell([{ type: "CASH", amountCents: 2165 }]);
    const r = await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: res.body.order.lines[0].id, quantity: 2 }] });
    expect(r.body.refundCents).toBe(2165);
  });
});

describe("receipts", () => {
  it("a card sale shows card prices and both totals", async () => {
    const res = await sell([{ type: "CARD", amountCents: 2252, paymentToken: "tok_ok" }]);
    const r = await w.as(w.cashier, "GET", `/orders/${res.body.order.id}/receipt`);
    expect(r.body).toMatchObject({
      pricedAt: "CARD",
      subtotalCents: 2080,
      taxCents: 172,
      totalCents: 2252,
      dualPricing: { percent: "4%", cashTotalCents: 2165, cardTotalCents: 2252, cardAdjustmentCents: 0 },
    });
    expect(r.body.lines[0]).toMatchObject({ unitCents: 1040, totalCents: 2080 });

    const text = await w.app.inject({ method: "GET", url: `/orders/${res.body.order.id}/receipt?format=text`, headers: { authorization: `Bearer ${w.cashier}` } });
    expect(text.body).toContain("TOTAL (card price)");
    expect(text.body).toMatch(/Cash price total\s+\$21\.65/);
    expect(text.body).toMatch(/Card price total\s+\$22\.52/);
    expect(text.body).toContain("Thanks for shopping local!");
    expect(text.body.split("\n").every((l) => l.length <= 42)).toBe(true);
  });

  it("a cash sale shows cash prices and what card would have cost", async () => {
    const res = await sell([{ type: "CASH", amountCents: 2165, tenderedCents: 3000 }]);
    const r = await w.as(w.cashier, "GET", `/orders/${res.body.order.id}/receipt`);
    expect(r.body).toMatchObject({ pricedAt: "CASH", totalCents: 2165, changeCents: 835, dualPricing: { cashTotalCents: 2165, cardTotalCents: 2252 } });
  });

  it("a split sale shows the card adjustment line", async () => {
    const res = await sell([{ type: "CASH", amountCents: 1000 }, { type: "CARD", amountCents: 1212, paymentToken: "tok_ok" }]);
    const html = await w.app.inject({ method: "GET", url: `/orders/${res.body.order.id}/receipt?format=html`, headers: { authorization: `Bearer ${w.cashier}` } });
    expect(html.body).toContain("Card price adjustment (4%)");
    expect(html.body).toContain("$22.12");
  });

  it("prints on the PAX terminal in Handpoint's HTML format", async () => {
    const t = await prisma.terminal.create({ data: { locationId: w.locationId, name: "Front", gatewayRef: "1850025030", model: "PAXA920PRO" } });
    const res = await sell([{ type: "CASH", amountCents: 2165 }]);
    const p = await w.as(w.cashier, "POST", `/orders/${res.body.order.id}/receipt/print`, { terminalId: t.id });
    expect(p.status).toBe(200);
    expect(w.gateway.printed[0]!.terminal).toBe("1850025030");
    expect(w.gateway.printed[0]!.html).toMatch(/<header>.*<\/header>\s*<main>.*Card price total.*<\/main>/s);
  });
});

describe("labels", () => {
  const items = () => [{ variantId: v.nm, copies: 2 }];
  const post = (url: string, body: object) => w.app.inject({ method: "POST", url, payload: body, headers: { authorization: `Bearer ${w.cashier}` } });

  it("ZPL labels show both prices", async () => {
    const res = await post("/labels", { locationId: w.locationId, items: items(), format: "zpl" });
    expect(res.body).toContain("^FDCASH^FS");
    expect(res.body).toContain("^FD$10.00^FS");
    expect(res.body).toContain("^FD$10.40^FS");
    expect(res.body).toContain("^FDPKM-OBF-125-NM^FS");
    expect(res.body).toContain("^PQ2");
  });

  it("HTML labels include a scannable barcode", async () => {
    const res = await post("/labels", { locationId: w.locationId, items: items(), format: "html" });
    expect(res.body.match(/<section>/g)).toHaveLength(2);
    expect(res.body).toContain("<svg");
    expect(res.body).toContain("CARD</small><b>$10.40");
  });

  it("show a single price when dual pricing is off", async () => {
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { cardPriceBps: 0 });
    const res = await post("/labels", { locationId: w.locationId, items: items(), format: "zpl" });
    expect(res.body).not.toContain("CARD");
  });

  it("send ZPL to the store's network label printer", async () => {
    let received = "";
    const printer = createServer((s) => s.on("data", (d) => (received += d.toString())));
    await new Promise<void>((r) => printer.listen(0, "127.0.0.1", r));
    const port = (printer.address() as { port: number }).port;
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { labelPrinterHost: `127.0.0.1:${port}` });
    const res = await post("/labels/print", { locationId: w.locationId, items: items() });
    expect(res.json()).toEqual({ printed: 2 });
    await new Promise((r) => setTimeout(r, 50));
    printer.close();
    expect(received).toContain("^XA");
  });
});

describe("storefront and reports", () => {
  it("online shows and charges card prices", async () => {
    const list = await w.app.inject({ method: "GET", url: "/storefront/products" });
    expect(list.json().products[0].variants[0]).toMatchObject({ priceCents: 1040, cashPriceCents: 1000 });
    // $10.40 + 8.25% = $11.26
    const res = await w.app.inject({
      method: "POST",
      url: "/storefront/checkout",
      payload: { email: "red@example.com", name: "Red", lines: [{ variantId: v.nm, quantity: 1 }], paymentToken: "tok_ok", amountCents: 1126, idempotencyKey: key() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().totalCents).toBe(1126);
  });

  it("the daily report includes tax on card prices and the card adjustment total", async () => {
    await sell([{ type: "CARD", amountCents: 2252, paymentToken: "tok_ok" }]);
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const r = await w.as(w.manager, "GET", `/reports/daily?locationId=${w.locationId}&date=${date}`);
    expect(r.body).toMatchObject({ cardPriceAdjustmentCents: 87, tax: { collectedCents: 172 } });
  });
});

describe("customer display", () => {
  it("relays the register's cart to the display", async () => {
    expect((await w.as(w.cashier, "GET", "/displays/front")).body).toEqual({ state: "IDLE" });
    await w.as(w.cashier, "PUT", "/displays/front", { state: "CART", cashTotalCents: 2165, cardTotalCents: 2252 });
    expect((await w.as(w.cashier, "GET", "/displays/front")).body).toMatchObject({ state: "CART", cardTotalCents: 2252 });
  });
});
