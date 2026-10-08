import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, onHand, PINS, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;
beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
});
afterAll(() => prisma.$disconnect());

const today = () => {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).toISOString();
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2).toISOString();
  return `from=${from}&to=${to}`;
};
const sale = (lines: object[], tenders: object[], extra: object = {}) =>
  w.as(w.cashier, "POST", "/orders/checkout", { locationId: w.locationId, lines, tenders, idempotencyKey: key(), ...extra });

describe("back-office sign-in", () => {
  it("uses email + password, needs the permission, and is logged", async () => {
    const owner = await prisma.staff.findFirstOrThrow({ where: { role: "OWNER" } });
    const noPassword = await w.app.inject({ method: "POST", url: "/auth/web-login", payload: { email: owner.email, password: "whatever" } });
    expect(noPassword.json().message).toContain("No website password");

    await w.as(w.owner, "PATCH", `/staff/${owner.id}`, { password: "correct horse battery" });
    expect((await w.app.inject({ method: "POST", url: "/auth/web-login", payload: { email: owner.email, password: "wrong" } })).statusCode).toBe(401);
    const ok = await w.app.inject({ method: "POST", url: "/auth/web-login", payload: { email: owner.email, password: "correct horse battery" } });
    expect(ok.json()).toMatchObject({ staff: { role: "OWNER" }, permissions: { levels: { BACK_OFFICE_LOGIN: "ALLOW" } } });

    // Cashiers have passwords set by an owner but no back-office permission by default.
    const cashier = await prisma.staff.findFirstOrThrow({ where: { role: "CASHIER" } });
    await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { password: "cashier password 1" });
    expect((await w.app.inject({ method: "POST", url: "/auth/web-login", payload: { email: cashier.email, password: "cashier password 1" } })).statusCode).toBe(403);

    const log = await w.as(w.manager, "GET", "/audit?action=LOGIN_FAILED");
    expect(log.body.map((r: any) => r.details.method)).toContain("web");
    expect(JSON.stringify(await w.as(w.manager, "GET", "/audit?kind=requests"))).not.toContain("correct horse");
  });

  it("staff change their own password, confirming with the PIN the first time", async () => {
    expect((await w.as(w.manager, "POST", "/auth/password", { current: "0000", password: "a long new password" })).status).toBe(401);
    expect((await w.as(w.manager, "POST", "/auth/password", { current: PINS.MANAGER, password: "a long new password" })).status).toBe(200);
    const manager = await prisma.staff.findFirstOrThrow({ where: { role: "MANAGER" } });
    expect((await w.app.inject({ method: "POST", url: "/auth/web-login", payload: { email: manager.email, password: "a long new password" } })).statusCode).toBe(200);
  });
});

describe("purchase orders", () => {
  it("goes draft → ordered → partially received → received, putting stock and cost in", async () => {
    const vendor = await w.as(w.manager, "POST", "/vendors", { name: "Southern Hobby" });
    const po = await w.as(w.manager, "POST", "/purchase-orders", {
      vendorId: vendor.body.id,
      locationId: w.locationId,
      reference: "INV-1001",
      lines: [{ variantId: v.nm, quantity: 10, unitCostCents: 400 }, { variantId: v.shoe, quantity: 2, unitCostCents: 20000 }],
    });
    expect(po.status).toBe(201);
    expect(po.body).toMatchObject({ status: "DRAFT", number: 1 });

    expect((await w.as(w.cashier, "POST", `/purchase-orders/${po.body.id}/receive`, { lines: [{ variantId: v.nm, quantity: 1 }] })).status).toBe(403);
    expect((await w.as(w.manager, "POST", `/purchase-orders/${po.body.id}/receive`, { lines: [{ variantId: v.nm, quantity: 1 }] })).body.error).toBe("PO_STATE");

    expect((await w.as(w.manager, "POST", `/purchase-orders/${po.body.id}/order`)).body.status).toBe("ORDERED");
    expect((await w.as(w.manager, "PUT", `/purchase-orders/${po.body.id}`, { lines: [] })).body.error).toBe("PO_LOCKED");

    const part = await w.as(w.manager, "POST", `/purchase-orders/${po.body.id}/receive`, { lines: [{ variantId: v.nm, quantity: 4 }] });
    expect(part.body.status).toBe("PARTIAL");
    expect(await onHand(v.nm, w.locationId)).toBe(7);
    // 3 on hand at $6.50 (from seed, cost unknown -> treated as this cost) blended with 4 at $4.00
    const cost = (await prisma.variant.findUniqueOrThrow({ where: { id: v.nm } })).costCents;
    expect(cost).toBe(400);

    expect((await w.as(w.manager, "POST", `/purchase-orders/${po.body.id}/receive`, { lines: [{ variantId: v.nm, quantity: 7 }] })).body.error).toBe("PO_OVER");
    expect((await w.as(w.manager, "POST", `/purchase-orders/${po.body.id}/cancel`)).body.error).toBe("PO_RECEIVED");

    const done = await w.as(w.manager, "POST", `/purchase-orders/${po.body.id}/receive`, { lines: [{ variantId: v.nm, quantity: 6 }, { variantId: v.shoe, quantity: 2 }] });
    expect(done.body.status).toBe("RECEIVED");
    expect(await onHand(v.shoe, w.locationId)).toBe(2);
    const log = await w.as(w.manager, "GET", "/audit?action=PO_RECEIVED");
    expect(log.body).toHaveLength(2);
  });

  it("suggests reorders from low-stock levels", async () => {
    await w.as(w.manager, "PUT", `/inventory/${v.nm}/low-stock`, { locationId: w.locationId, lowStockQty: 5 });
    const s = await w.as(w.manager, "GET", `/purchase-orders/reorder?locationId=${w.locationId}`);
    expect(s.body).toEqual([expect.objectContaining({ sku: "PKM-OBF-125-NM", onHand: 3, lowStockQty: 5, suggestedQty: 7 })]);
    const low = await w.as(w.manager, "GET", `/reports/low-stock?locationId=${w.locationId}`);
    expect(low.body[0].title).toBe("Charizard ex");
  });
});

describe("transfers", () => {
  it("moves stock between locations, and logs anything that arrives short", async () => {
    const mall = await w.as(w.owner, "POST", "/locations", { name: "Mall kiosk", taxRateBps: 700 });
    expect(mall.status).toBe(201);
    const t = await w.as(w.manager, "POST", "/transfers", { fromLocationId: w.locationId, toLocationId: mall.body.id, lines: [{ variantId: v.nm, quantity: 2 }] });
    expect(t.body.status).toBe("DRAFT");
    expect((await w.as(w.manager, "POST", "/transfers", { fromLocationId: w.locationId, toLocationId: w.locationId, lines: [] })).body.error).toBe("TRANSFER_SAME");

    const sent = await w.as(w.manager, "POST", `/transfers/${t.body.id}/send`);
    expect(sent.body.status).toBe("SENT");
    expect(await onHand(v.nm, w.locationId)).toBe(1);
    expect(await onHand(v.nm, mall.body.id)).toBe(0);
    expect((await w.as(w.manager, "POST", `/transfers/${t.body.id}/cancel`)).body.error).toBe("TRANSFER_STATE");

    const received = await w.as(w.manager, "POST", `/transfers/${t.body.id}/receive`, { lines: [{ variantId: v.nm, quantity: 1 }] });
    expect(received.body.status).toBe("RECEIVED");
    expect(await onHand(v.nm, mall.body.id)).toBe(1);
    const short = await w.as(w.manager, "GET", "/audit?action=TRANSFER_SHORT");
    expect(short.body[0].details.short).toEqual([{ variantId: v.nm, sent: 2, received: 1 }]);
  });

  it("can't send more than the source has", async () => {
    const mall = await w.as(w.owner, "POST", "/locations", { name: "Kiosk" });
    const t = await w.as(w.manager, "POST", "/transfers", { fromLocationId: w.locationId, toLocationId: mall.body.id, lines: [{ variantId: v.nm, quantity: 50 }] });
    expect((await w.as(w.manager, "POST", `/transfers/${t.body.id}/send`)).body.error).toBe("INSUFFICIENT_STOCK");
    expect(await onHand(v.nm, w.locationId)).toBe(3);
  });
});

describe("reports", () => {
  beforeEach(async () => {
    await prisma.variant.update({ where: { id: v.nm }, data: { costCents: 400 } });
    const cust = (await w.as(w.cashier, "POST", "/customers", { name: "Ash" })).body.id;
    await sale([{ variantId: v.nm, quantity: 2 }], [{ type: "CASH", amountCents: 2165 }]);
    const r = await w.as(w.manager, "POST", "/discount-reasons", { name: "Damaged" });
    // $10 - $1 discount = $9 + tax $0.74
    await sale([{ variantId: v.nm, quantity: 1, discountCents: 100, discountReasonId: r.body.id }], [{ type: "CARD", amountCents: 974, paymentToken: "tok_ok" }], { customerId: cust });
  });

  it("summary: net sales, cost of goods, profit, average ticket", async () => {
    const s = await w.as(w.manager, "GET", `/reports/summary?${today()}&locationId=${w.locationId}`);
    expect(s.body).toMatchObject({ orders: 2, units: 3, grossCents: 3000, manualDiscountCents: 100, netSalesCents: 2900, taxCents: 239, costOfGoodsCents: 1200, grossProfitCents: 1700, averageTicketCents: 1450 });
    expect((await w.as(w.cashier, "GET", `/reports/summary?${today()}`)).status).toBe(403);
  });

  it("breaks sales down by day, category, employee, product, and tender", async () => {
    const byDay = await w.as(w.manager, "GET", `/reports/sales-by-period?${today()}&group=day`);
    expect(byDay.body.reduce((a: number, r: any) => a + r.netCents, 0)).toBe(2900);
    expect(byDay.body.reduce((a: number, r: any) => a + r.taxCents, 0)).toBe(239);
    const byEmp = await w.as(w.manager, "GET", `/reports/sales-by/employee?${today()}`);
    expect(byEmp.body[0]).toMatchObject({ label: "CASHIER", netCents: 2900, profitCents: 1700, orders: 2 });
    const byProduct = await w.as(w.manager, "GET", `/reports/sales-by/product?${today()}`);
    expect(byProduct.body[0].units).toBe(3);
    const tenders = await w.as(w.manager, "GET", `/reports/tenders?${today()}`);
    expect(Object.fromEntries(tenders.body.map((t: any) => [t.tender, t.netCents]))).toEqual({ CASH: 2165, CARD: 974 });
  });

  it("discounts by reason, tax, trade-ins, valuation, dead stock", async () => {
    const d = await w.as(w.manager, "GET", `/reports/discounts?${today()}`);
    expect(d.body.manual).toEqual([{ reason: "Damaged", count: 1, amountCents: 100 }]);
    const tax = await w.as(w.manager, "GET", `/reports/tax?${today()}`);
    expect(tax.body).toMatchObject({ taxableSalesCents: 2900, taxCollectedCents: 239 });
    const val = await w.as(w.manager, "GET", `/reports/inventory-valuation?locationId=${w.locationId}`);
    // NM: 0 left; LP: 3 x $8.50 retail
    expect(val.body.total).toMatchObject({ units: 3, retailCents: 2550 });
    const dead = await w.as(w.manager, "GET", `/reports/no-sales?${today()}&locationId=${w.locationId}`);
    expect(dead.body.map((x: any) => x.sku)).toEqual(["PKM-OBF-125-LP"]);
    const trade = await w.as(w.manager, "GET", `/reports/trade-ins?${today()}`);
    expect(trade.body.tickets).toBe(0);
  });

  it("downloads any report as CSV", async () => {
    const res = await w.app.inject({ method: "GET", url: `/reports/sales-by/product?${today()}&format=csv`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("sales-by-product.csv");
    const [header, first] = res.body.split("\n");
    expect(header).toBe("key,label,units,netCents,costCents,profitCents,orders");
    expect(first).toContain("Charizard ex");
  });

  it("rejects bad ranges", async () => {
    expect((await w.as(w.manager, "GET", "/reports/summary?from=2026-02-01&to=2026-01-01")).body.error).toBe("RANGE");
  });

  it("dashboard shows today at a glance", async () => {
    const d = await w.as(w.manager, "GET", `/dashboard?locationId=${w.locationId}`);
    expect(d.body.today).toMatchObject({ orders: 2, netSalesCents: 2900 });
    expect(d.body.topItems[0].label).toContain("Charizard");
    expect(d.body.hourly.length).toBeGreaterThan(0);
    expect(d.body).toMatchObject({ pendingPayments: 0, openPurchaseOrders: 0, transfersInTransit: 0 });
  });

  it("stock movement history", async () => {
    const m = await w.as(w.manager, "GET", `/reports/stock-movements?${today()}&reason=SALE`);
    expect(m.body.map((x: any) => x.delta)).toEqual([-1, -2]);
  });
});
