import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, PINS, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;
/** Two registers at the location. */
let t1: string;
let t2: string;
/** A $5 accessory with stock, so refunds can be small round amounts. */
let sleeves: string;

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
  // Round numbers: no sales tax in these tests.
  await prisma.location.update({ where: { id: w.locationId }, data: { taxRateBps: 0 } });
  t1 = (await prisma.terminal.create({ data: { locationId: w.locationId, name: "Front", gatewayRef: "T1" } })).id;
  t2 = (await prisma.terminal.create({ data: { locationId: w.locationId, name: "Back", gatewayRef: "T2" } })).id;
  const acc = await w.as(w.manager, "POST", "/catalog/products", { kind: "ACCESSORY", title: "Sleeves", variants: [{ sku: "SLV-1", priceCents: 500 }] });
  sleeves = acc.body.variants[0].id;
  await w.as(w.manager, "POST", "/inventory/adjust", { variantId: sleeves, locationId: w.locationId, delta: 10, reason: "RECEIVE" });
});
afterAll(() => prisma.$disconnect());

const staffId = async (name: string) => (await prisma.staff.findUniqueOrThrow({ where: { email: `${name.toLowerCase()}@shop.test` } })).id;
/** A manager's PIN approval for the cashier. */
const approve = async (permissions: string[]) => (await w.as(w.cashier, "POST", "/auth/approve", { pin: PINS.MANAGER, permissions })).body.token as string;
const withToken = async (as: string, token: string, method: "GET" | "POST", url: string, body?: unknown) => {
  const res = await w.app.inject({ method, url, payload: body as object, headers: { authorization: `Bearer ${as}`, "x-approval-token": token } });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
};
const cashSale = (variantId: string, quantity: number, amountCents: number, tenderedCents: number, terminalId?: string, as = w.cashier) =>
  w.as(as, "POST", "/orders/checkout", { locationId: w.locationId, lines: [{ variantId, quantity }], tenders: [{ type: "CASH", amountCents, tenderedCents }], idempotencyKey: key(), terminalId });
/** Open register 1 with a $200 float counted by denomination. */
const open = (body: object = {}, as = w.cashier) =>
  w.as(as, "POST", "/drawer/open", { locationId: w.locationId, terminalId: t1, openingFloatCents: 20000, openingCount: { "2000": 5, "1000": 5, "500": 6, "100": 15, "25": 20 }, ...body });
const current = (terminalId: string, as = w.cashier) => w.as(as, "GET", `/drawer/current?locationId=${w.locationId}&terminalId=${terminalId}`);

describe("cash drawer sessions", () => {
  it("runs a shift: float, cash sale, paid out, drop, refund, trade-in, and a blind close with a variance approval", async () => {
    const opened = await open();
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ status: "OPEN", openingFloatCents: 20000, terminalId: t1, terminalName: "Front", openedBy: { name: "CASHIER" }, movements: [] });
    const sid = opened.body.id as string;

    // $10 cash sale, $20 handed over: $10 change, $10 stays in the drawer.
    const sale = await cashSale(sleeves, 2, 1000, 2000, t1);
    expect(sale.status).toBe(201);
    expect(sale.body.changeCents).toBe(1000);
    expect(sale.body.order.payments[0]).toMatchObject({ tender: "CASH", amountCents: 1000, changeCents: 1000, drawerSessionId: sid });

    // Another register's cash sale isn't this drawer's.
    const other = await cashSale(v.nm, 1, 1000, 1000, t2);
    expect(other.status).toBe(201);
    expect(other.body.order.payments[0].drawerSessionId).toBeNull();

    // Paid out: cashiers need a manager's PIN.
    const denied = await w.as(w.cashier, "POST", `/drawer/${sid}/movements`, { kind: "PAID_OUT", amountCents: 1500, reason: "Supplies" });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: "APPROVAL_REQUIRED", details: { permission: "CASH_IN_OUT" } });
    const paidOut = await withToken(w.cashier, await approve(["CASH_IN_OUT"]), "POST", `/drawer/${sid}/movements`, { kind: "PAID_OUT", amountCents: 1500, reason: "Supplies", note: "Toner" });
    expect(paidOut.status).toBe(201);
    expect(paidOut.body).toMatchObject({ kind: "PAID_OUT", amountCents: 1500, reason: "Supplies", note: "Toner", staff: { name: "CASHIER" }, approverId: await staffId("MANAGER"), drawerOpened: false });

    const drop = await w.as(w.manager, "POST", `/drawer/${sid}/movements`, { kind: "DROP", amountCents: 10000, reason: "Safe drop" });
    expect(drop.status).toBe(201);
    expect(drop.body).toMatchObject({ kind: "DROP", amountCents: 10000, approverId: null });

    // $5 cash refund (one of the two sleeves).
    const refund = await w.as(w.manager, "POST", `/orders/${sale.body.order.id}/refund`, { lines: [{ orderLineId: sale.body.order.lines[0].id, quantity: 1 }], terminalId: t1 });
    expect(refund.status).toBe(200);
    expect(refund.body.legs).toEqual([{ tender: "CASH", amountCents: 500, status: "APPROVED" }]);
    const refundRow = await prisma.payment.findFirstOrThrow({ where: { orderId: sale.body.order.id, amountCents: { lt: 0 } } });
    expect(refundRow.drawerSessionId).toBe(sid);

    // $20 cash trade-in paid from this drawer.
    const quote = await w.as(w.cashier, "POST", "/buylist/quote", { locationId: w.locationId, lines: [{ description: "Bulk commons", quantity: 1, marketCents: 5000, cashOfferCents: 2000, creditOfferCents: 2500 }] });
    expect(quote.status).toBe(201);
    const accept = await w.as(w.manager, "POST", `/buylist/${quote.body.id}/accept`, { payout: "CASH", terminalId: t1 });
    expect(accept.status).toBe(200);
    expect(accept.body).toMatchObject({ status: "ACCEPTED", paidCents: 2000, drawerSessionId: sid });

    // Blind count: the cashier doesn't see the expected amount; a manager does.
    const cur = await current(t1);
    expect(cur.status).toBe(200);
    expect(cur.body.session.id).toBe(sid);
    expect(cur.body.session.movements).toHaveLength(2);
    expect(cur.body.expected).toBeNull();
    expect(cur.body.settings).toEqual({ requireDrawerSession: false, blindCashCount: true, cashVarianceAlertCents: 500 });
    const detail = await w.as(w.cashier, "GET", `/drawer/${sid}`);
    expect(detail.status).toBe(200);
    expect(detail.body.expected).toBeNull();
    expect(detail.body.report).toBeNull();
    const breakdown = { openingFloatCents: 20000, cashSalesCents: 1000, cashRefundsCents: 500, tradeInCashCents: 2000, paidInCents: 0, paidOutCents: 1500, dropCents: 10000, expectedCents: 7000 };
    expect((await current(t1, w.manager)).body.expected).toEqual(breakdown);
    const detailM = await w.as(w.manager, "GET", `/drawer/${sid}`);
    expect(detailM.body.expected).toEqual(breakdown);
    expect(detailM.body.report).toMatchObject({ kind: "X", cash: { ...breakdown, countedCashCents: null } });

    // One open session per register.
    const again = await open();
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "DRAWER_ALREADY_OPEN", details: { sessionId: sid, number: opened.body.number } });

    // Alert at $2: a $5 short count needs CASH_VARIANCE_OVERRIDE.
    const patched = await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { cashVarianceAlertCents: 200 });
    expect(patched.status).toBe(200);
    expect(patched.body.cashVarianceAlertCents).toBe(200);
    const short = await w.as(w.cashier, "POST", `/drawer/${sid}/close`, { countedCashCents: 6500 });
    expect(short.status).toBe(403);
    expect(short.body).toMatchObject({ error: "APPROVAL_REQUIRED", details: { permission: "CASH_VARIANCE_OVERRIDE" } });
    expect((await prisma.drawerSession.findUniqueOrThrow({ where: { id: sid } })).status).toBe("OPEN");

    const closed = await withToken(w.cashier, await approve(["CASH_VARIANCE_OVERRIDE"]), "POST", `/drawer/${sid}/close`, { countedCashCents: 6500, closingCount: { "2000": 3, "500": 1 }, notes: "Short $5" });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      status: "CLOSED",
      expectedCashCents: 7000,
      countedCashCents: 6500,
      varianceCents: -500,
      closedBy: { name: "CASHIER" },
      approvedBy: { name: "MANAGER" },
      notes: "Short $5",
      expected: breakdown,
    });
    expect(closed.body.report).toMatchObject({
      kind: "Z",
      session: { number: opened.body.number, terminalName: "Front", openedBy: "CASHIER", closedBy: "CASHIER", approvedBy: "MANAGER" },
      cash: { ...breakdown, countedCashCents: 6500, varianceCents: -500, closingCount: { "2000": 3, "500": 1 } },
      sales: {
        orders: 1,
        units: 2,
        grossCents: 1000,
        discountCents: 0,
        netSalesCents: 1000,
        taxCents: 0,
        cardAdjustmentCents: 0,
        collectedCents: 1000,
        byTender: [{ tender: "CASH", count: 1, amountCents: 1000 }],
        refunds: { count: 1, amountCents: 500, byTender: [{ tender: "CASH", count: 1, amountCents: 500 }] },
        tradeIns: { tickets: 1, paidCents: 2000, byPayout: { CASH: { tickets: 1, paidCents: 2000 }, STORE_CREDIT: { tickets: 0, paidCents: 0 } } },
      },
      byEmployee: [{ staffId: await staffId("CASHIER"), name: "CASHIER", orders: 1, netCents: 1000, collectedCents: 1000 }],
    });
    expect(closed.body.report.movements.map((m: any) => m.kind)).toEqual(["PAID_OUT", "DROP"]);

    // The activity log has the whole shift.
    const events = await prisma.auditEvent.findMany({ where: { action: { in: ["DRAWER_OPENED", "CASH_PAID_IN", "CASH_PAID_OUT", "CASH_DROP", "DRAWER_CLOSED"] } }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.action)).toEqual(["DRAWER_OPENED", "CASH_PAID_OUT", "CASH_DROP", "DRAWER_CLOSED"]);
    expect(events[0]!.details).toEqual({ sessionId: sid, number: opened.body.number, terminalId: t1, openingFloatCents: 20000 });
    expect(events[1]).toMatchObject({ staffId: await staffId("CASHIER"), approverId: await staffId("MANAGER"), details: { sessionId: sid, amountCents: 1500, reason: "Supplies" } });
    expect(events[3]).toMatchObject({ approverId: await staffId("MANAGER"), details: { sessionId: sid, number: opened.body.number, expectedCents: 7000, countedCents: 6500, varianceCents: -500 } });

    // Closed is closed.
    expect((await current(t1)).body.session).toBeNull();
    const twice = await w.as(w.manager, "POST", `/drawer/${sid}/close`, { countedCashCents: 6500 });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe("DRAWER_NOT_OPEN");
    const late = await w.as(w.manager, "POST", `/drawer/${sid}/movements`, { kind: "PAID_IN", amountCents: 100, reason: "Late" });
    expect(late.status).toBe(409);
    // Once closed, everyone can see the stored report.
    const after = await w.as(w.cashier, "GET", `/drawer/${sid}`);
    expect(after.body.report.kind).toBe("Z");
    expect(after.body.expected).toEqual(breakdown);
    // A new shift on the same register is fine now.
    expect((await open()).status).toBe(201);
  });

  it("requireDrawerSession: cash sales, cash refunds and cash trade-ins need an open drawer; cards don't", async () => {
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { requireDrawerSession: true });
    const settings = await prisma.auditEvent.findFirstOrThrow({ where: { action: "SETTINGS_UPDATED" } });
    expect(settings.details).toEqual({ changes: { requireDrawerSession: { from: false, to: true } } });

    const cash = await cashSale(v.nm, 1, 1000, 1000, t1);
    expect(cash.status).toBe(409);
    expect(cash.body.error).toBe("DRAWER_CLOSED");
    expect(await prisma.order.count()).toBe(0);

    const card = await w.as(w.cashier, "POST", "/orders/checkout", {
      locationId: w.locationId,
      lines: [{ variantId: v.nm, quantity: 1 }],
      tenders: [{ type: "CARD", amountCents: 1000, paymentToken: "tok_ok" }],
      idempotencyKey: key(),
      terminalId: t1,
    });
    expect(card.status).toBe(201);
    expect(card.body.order.payments[0].drawerSessionId).toBeNull();

    const quote = await w.as(w.cashier, "POST", "/buylist/quote", { locationId: w.locationId, lines: [{ description: "Bulk", quantity: 1, marketCents: 2000 }] });
    const payout = await w.as(w.manager, "POST", `/buylist/${quote.body.id}/accept`, { payout: "CASH", terminalId: t1 });
    expect(payout.status).toBe(409);
    expect(payout.body.error).toBe("DRAWER_CLOSED");
    expect((await prisma.buylistTicket.findUniqueOrThrow({ where: { id: quote.body.id } })).status).toBe("QUOTED");

    // A cash sale during a shift, refunded after the drawer closed: not until a drawer is open again.
    const shift = await open();
    expect(shift.status).toBe(201);
    const sale = await cashSale(sleeves, 1, 500, 500, t1);
    expect(sale.status).toBe(201);
    expect(sale.body.order.payments[0].drawerSessionId).toBe(shift.body.id);
    expect((await w.as(w.manager, "POST", `/drawer/${shift.body.id}/close`, { countedCashCents: 20500 })).status).toBe(200);
    const lineId = sale.body.order.lines[0].id;
    const refund = await w.as(w.manager, "POST", `/orders/${sale.body.order.id}/refund`, { lines: [{ orderLineId: lineId, quantity: 1 }], terminalId: t1 });
    expect(refund.status).toBe(409);
    expect(refund.body.error).toBe("DRAWER_CLOSED");
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).refundedQty).toBe(0);
    const next = await open();
    const refunded = await w.as(w.manager, "POST", `/orders/${sale.body.order.id}/refund`, { lines: [{ orderLineId: lineId, quantity: 1 }], terminalId: t1 });
    expect(refunded.status).toBe(200);
    expect((await prisma.payment.findFirstOrThrow({ where: { orderId: sale.body.order.id, amountCents: { lt: 0 } } })).drawerSessionId).toBe(next.body.id);
    // Store credit refunds aren't cash, so they don't need a drawer.
    const c = await w.as(w.cashier, "POST", "/customers", { name: "Misty" });
    const withCustomer = await w.as(w.cashier, "POST", "/orders/checkout", {
      locationId: w.locationId,
      customerId: c.body.id,
      lines: [{ variantId: sleeves, quantity: 1 }],
      tenders: [{ type: "CASH", amountCents: 500, tenderedCents: 500 }],
      idempotencyKey: key(),
      terminalId: t1,
    });
    expect(withCustomer.status).toBe(201);
    expect((await w.as(w.manager, "POST", `/drawer/${next.body.id}/close`, { countedCashCents: 20000 })).status).toBe(200);
    const credited = await w.as(w.manager, "POST", `/orders/${withCustomer.body.order.id}/refund`, { lines: [{ orderLineId: withCustomer.body.order.lines[0].id, quantity: 1 }], toStoreCredit: true });
    expect(credited.status).toBe(200);
    expect(credited.body.legs).toEqual([{ tender: "STORE_CREDIT", amountCents: 500, status: "APPROVED" }]);
    expect((await prisma.payment.findFirstOrThrow({ where: { orderId: withCustomer.body.order.id, amountCents: { lt: 0 } } })).drawerSessionId).toBeNull();
  });

  it("a register without its own session uses the location's shared drawer", async () => {
    const shared = await open({ terminalId: undefined });
    expect(shared.status).toBe(201);
    expect(shared.body.terminalId).toBeNull();
    const fromT2 = await cashSale(v.nm, 1, 1000, 1000, t2);
    expect(fromT2.body.order.payments[0].drawerSessionId).toBe(shared.body.id);
    const noTerminal = await cashSale(v.nm, 1, 1000, 1000);
    expect(noTerminal.body.order.payments[0].drawerSessionId).toBe(shared.body.id);
    expect((await current(t2)).body.session.id).toBe(shared.body.id);

    // Register 1 opens its own drawer alongside; its sales go there from now on.
    const own = await open();
    expect(own.status).toBe(201);
    const fromT1 = await cashSale(v.lp, 1, 850, 1000, t1);
    expect(fromT1.body.order.payments[0].drawerSessionId).toBe(own.body.id);
    expect((await current(t1)).body.session.id).toBe(own.body.id);
    expect((await current(t2)).body.session.id).toBe(shared.body.id);
    // The shared drawer can't be opened twice either.
    expect((await open({ terminalId: undefined })).body.error).toBe("DRAWER_ALREADY_OPEN");

    // Idempotent replays keep the original attribution.
    const body = { locationId: w.locationId, lines: [{ variantId: v.nm, quantity: 1 }], tenders: [{ type: "CASH", amountCents: 1000, tenderedCents: 1000 }], idempotencyKey: key(), terminalId: t1 };
    const first = await w.as(w.cashier, "POST", "/orders/checkout", body);
    await w.as(w.manager, "POST", `/drawer/${own.body.id}/close`, { countedCashCents: 20000 + 850 + 1000 });
    const replay = await w.as(w.cashier, "POST", "/orders/checkout", body);
    expect(replay.status).toBe(200);
    expect(replay.body.order.payments[0].drawerSessionId).toBe(own.body.id);
    expect(first.body.order.id).toBe(replay.body.order.id);
  });

  it("reports: the daily close-out and the shifts list", async () => {
    const a = await open();
    await cashSale(v.nm, 1, 1000, 1000, t1);
    await w.as(w.manager, "POST", `/drawer/${a.body.id}/movements`, { kind: "DROP", amountCents: 5000, reason: "Safe" });
    const closedA = await w.as(w.manager, "POST", `/drawer/${a.body.id}/close`, { countedCashCents: 16000 });
    expect(closedA.status).toBe(200);
    expect(closedA.body).toMatchObject({ expectedCashCents: 16000, varianceCents: 0, approvedBy: null });
    const b = await open({ terminalId: t2, openingFloatCents: 10000, openingCount: undefined });
    expect(b.status).toBe(201);

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const daily = await w.as(w.manager, "GET", `/reports/daily-close?date=${today}&locationId=${w.locationId}`);
    expect(daily.status).toBe(200);
    expect(daily.body.date).toBe(today);
    expect(daily.body.sessions.map((s: any) => s.number)).toEqual([a.body.number, b.body.number]);
    expect(daily.body.sessions[0]).toMatchObject({ status: "CLOSED", register: "Front", openedBy: "CASHIER", closedBy: "MANAGER", floatCents: 20000, cashSalesCents: 1000, dropCents: 5000, expectedCents: 16000, countedCents: 16000, varianceCents: 0 });
    expect(daily.body.sessions[1]).toMatchObject({ status: "OPEN", register: "Back", floatCents: 10000, expectedCents: 10000, countedCents: null, varianceCents: null });
    expect(daily.body.open.map((s: any) => s.number)).toEqual([b.body.number]);
    expect(daily.body.totals).toEqual({ sessions: 2, open: 1, floatCents: 30000, cashSalesCents: 1000, cashRefundsCents: 0, tradeInCashCents: 0, paidInCents: 0, paidOutCents: 0, dropCents: 5000, expectedCents: 26000, countedCents: 16000, varianceCents: 0 });
    expect(daily.body.sales).toMatchObject({ orders: 1, netSalesCents: 1000, collectedCents: 1000 });
    expect(daily.body.tenders).toEqual([{ tender: "CASH", count: 1, netCents: 1000 }]);
    expect((await w.as(w.cashier, "GET", `/reports/daily-close?date=${today}`)).status).toBe(403);
    expect((await w.as(w.manager, "GET", `/reports/daily-close?date=2000-01-01`)).body.sessions).toEqual([]);
    expect((await w.as(w.manager, "GET", `/reports/daily-close?date=today`)).status).toBe(400);

    const csv = await w.app.inject({ method: "GET", url: `/reports/daily-close?date=${today}&format=csv`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("number,status,register");

    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const shifts = await w.as(w.manager, "GET", `/reports/shifts?from=${from}&to=${to}&locationId=${w.locationId}`);
    expect(shifts.status).toBe(200);
    expect(shifts.body.rows).toHaveLength(1);
    expect(shifts.body.rows[0]).toMatchObject({ number: a.body.number, register: "Front", terminalId: t1, openedBy: "CASHIER", closedBy: "MANAGER", floatCents: 20000, cashSalesCents: 1000, cashRefundsCents: 0, tradeInCashCents: 0, paidInCents: 0, paidOutCents: 0, dropCents: 5000, expectedCents: 16000, countedCents: 16000, varianceCents: 0, approvedBy: null });
    expect(shifts.body.totals).toMatchObject({ sessions: 1, open: 0, expectedCents: 16000 });
    expect((await w.as(w.manager, "GET", `/reports/shifts?from=${to}&to=${from}`)).status).toBe(400);

    const list = await w.as(w.cashier, "GET", `/drawer/sessions?locationId=${w.locationId}`);
    expect(list.status).toBe(200);
    expect(list.body.map((s: any) => s.number)).toEqual([b.body.number, a.body.number]);
    expect(list.body[1]).toMatchObject({ status: "CLOSED", terminalName: "Front", openedBy: { name: "CASHIER" }, closedBy: { name: "MANAGER" }, expectedCashCents: 16000, countedCashCents: 16000, varianceCents: 0, movements: 1 });
    expect(list.body[1].closingReport).toBeUndefined();
    expect((await w.as(w.cashier, "GET", `/drawer/sessions?status=CLOSED`)).body).toHaveLength(1);
    expect((await w.as(w.cashier, "GET", `/drawer/sessions?terminalId=${t2}`)).body.map((s: any) => s.number)).toEqual([b.body.number]);
  });

  it("closing and X reports as JSON, printable HTML and thermal text, and printing", async () => {
    const opened = await open();
    const sid = opened.body.id as string;
    await cashSale(v.nm, 1, 1000, 1000, t1);

    // Blind: the cashier can't pull the X report mid-shift, a manager can.
    const blind = await w.as(w.cashier, "GET", `/drawer/${sid}/report`);
    expect(blind.status).toBe(403);
    expect(blind.body.error).toBe("BLIND_COUNT");
    const x = await w.as(w.manager, "GET", `/drawer/${sid}/report`);
    expect(x.status).toBe(200);
    expect(x.body).toMatchObject({ kind: "X", cash: { expectedCents: 21000, countedCashCents: null } });
    // With blind counting off, the cashier sees it too.
    await w.as(w.owner, "PATCH", `/locations/${w.locationId}`, { blindCashCount: false });
    expect((await w.as(w.cashier, "GET", `/drawer/${sid}/report`)).body.kind).toBe("X");
    expect((await current(t1)).body.expected.expectedCents).toBe(21000);

    const closed = await w.as(w.cashier, "POST", `/drawer/${sid}/close`, { countedCashCents: 21000 });
    expect(closed.status).toBe(200);
    const json = await w.as(w.cashier, "GET", `/drawer/${sid}/report`);
    expect(json.body).toEqual(closed.body.report);
    expect(json.body.kind).toBe("Z");

    const auth = { authorization: `Bearer ${w.cashier}` };
    const text = await w.app.inject({ method: "GET", url: `/drawer/${sid}/report?format=text&width=32`, headers: auth });
    expect(text.statusCode).toBe(200);
    expect(text.headers["content-type"]).toContain("text/plain");
    expect(text.body).toContain(`Drawer #${opened.body.number}`);
    expect(text.body).toContain("CLOSING REPORT");
    expect(text.body).toMatch(/EXPECTED\s+\$210\.00/);
    expect(text.body).toMatch(/COUNTED\s+\$210\.00/);
    expect(text.body).toMatch(/CASH \(1\)\s+\$10\.00/);
    expect(text.body).toContain("Register: Front");
    for (const line of text.body.split("\n")) expect(line.length).toBeLessThanOrEqual(32);

    const html = await w.app.inject({ method: "GET", url: `/drawer/${sid}/report?format=html`, headers: auth });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain(`Closing report · Drawer #${opened.body.number}`);
    expect(html.body).toContain("$210.00");
    expect(html.body).toContain("CASHIER");

    // Printing needs a receipt printer on the register.
    const noPrinter = await w.as(w.cashier, "POST", `/drawer/${sid}/report/print`, { terminalId: t1 });
    expect(noPrinter.status).toBe(400);
    expect(noPrinter.body.error).toBe("NO_PRINTER");
    expect((await w.as(w.cashier, "POST", `/drawer/${sid}/report/print`, { terminalId: "nope" })).status).toBe(404);
    expect((await w.as(w.cashier, "GET", `/drawer/nope/report`)).status).toBe(404);
  });

  it("movements are validated, and the drawer kick is best effort", async () => {
    await prisma.terminal.update({ where: { id: t1 }, data: { receiptPrinterHost: "127.0.0.1:1" } });
    const opened = await open();
    const sid = opened.body.id as string;
    const zero = await w.as(w.manager, "POST", `/drawer/${sid}/movements`, { kind: "PAID_IN", amountCents: 0, reason: "x" });
    expect(zero.status).toBe(400);
    const noReason = await w.as(w.manager, "POST", `/drawer/${sid}/movements`, { kind: "PAID_IN", amountCents: 100, reason: " " });
    expect(noReason.status).toBe(400);
    // The printer at 127.0.0.1:1 refuses the connection; the paid-in still goes through.
    const paidIn = await w.as(w.manager, "POST", `/drawer/${sid}/movements`, { kind: "PAID_IN", amountCents: 2500, reason: "Change from the bank" });
    expect(paidIn.status).toBe(201);
    expect(paidIn.body).toMatchObject({ kind: "PAID_IN", amountCents: 2500, drawerOpened: false });
    expect((await current(t1, w.manager)).body.expected).toMatchObject({ paidInCents: 2500, expectedCents: 22500 });

    // Denominations have to add up.
    const mismatch = await open({ terminalId: t2, openingFloatCents: 5000, openingCount: { "100": 1 } });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({ error: "COUNT_MISMATCH", details: { countedCents: 100, enteredCents: 5000 } });
    const badCount = await w.as(w.manager, "POST", `/drawer/${sid}/close`, { countedCashCents: 22500, closingCount: { "2000": 1 } });
    expect(badCount.status).toBe(400);
    expect(badCount.body.error).toBe("COUNT_MISMATCH");
    // A register at another location can't open a drawer here.
    const elsewhere = await prisma.location.create({ data: { name: "Mall" } });
    const foreign = await prisma.terminal.create({ data: { locationId: elsewhere.id, name: "Kiosk", gatewayRef: "T9" } });
    const wrong = await open({ terminalId: foreign.id });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("TERMINAL");
    expect((await w.as(w.cashier, "GET", `/drawer/current?locationId=${elsewhere.id}`)).body).toEqual({ session: null, expected: null, settings: { requireDrawerSession: false, blindCashCount: true, cashVarianceAlertCents: 500 } });
  });
});
