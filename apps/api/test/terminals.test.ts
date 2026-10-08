import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RoutingGateway } from "../src/payments/router.js";
import { MockGateway } from "../src/payments/mock.js";
import { key, onHand, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;
let terminalId: string;

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
  terminalId = (await prisma.terminal.create({ data: { locationId: w.locationId, name: "Front counter", gatewayRef: "1850025030", model: "PAXA920PRO" } })).id;
});
afterAll(() => prisma.$disconnect());

const cardSale = (extra: object = {}) =>
  w.as(w.cashier, "POST", "/orders/checkout", {
    locationId: w.locationId,
    lines: [{ variantId: v.nm, quantity: 1 }],
    tenders: [{ type: "CARD", amountCents: 1083, terminalId }],
    idempotencyKey: key(),
    ...extra,
  });

describe("card-present checkout", () => {
  it("sends the sale to the register's terminal and records it", async () => {
    const res = await cardSale();
    expect(res.status).toBe(201);
    expect(w.gateway.lastSale?.terminal).toEqual({ id: terminalId, ref: "1850025030", model: "PAXA920PRO" });
    expect(res.body.order.payments[0]).toMatchObject({ tender: "CARD", status: "APPROVED", terminalId });
  });

  it("rejects a terminal from another location", async () => {
    const other = await prisma.location.create({ data: { name: "Mall kiosk" } });
    await prisma.terminal.update({ where: { id: terminalId }, data: { locationId: other.id } });
    const res = await cardSale();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("TERMINAL");
    expect(w.gateway.calls).toHaveLength(0);
  });

  it("an unknown outcome voids the sale, keeps stock, and flags the payment", async () => {
    w.gateway.nextSale = { approved: false, pending: true, gatewayRef: "ref:abc", message: "Terminal stopped responding" };
    const res = await cardSale();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("PAYMENT_UNKNOWN");
    expect(await onHand(v.nm, w.locationId)).toBe(3);

    const pending = await w.as(w.manager, "GET", "/payments/pending");
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]).toMatchObject({ id: res.body.details.paymentId, status: "PENDING", amountCents: 1083, terminalId });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: res.body.details.orderId } })).toMatchObject({ status: "VOID" });
  });

  it("a manager resolves it: charged after all, so it's voided on the terminal", async () => {
    w.gateway.nextSale = { approved: false, pending: true, gatewayRef: "ref:abc" };
    const res = await cardSale();
    w.gateway.lookupResult = { approved: true, gatewayRef: "hp_txn_1" };
    const resolved = await w.as(w.manager, "POST", `/payments/${res.body.details.paymentId}/resolve`);
    expect(resolved.body.outcome).toBe("VOIDED");
    expect(w.gateway.calls.at(-1)).toMatchObject({ op: "void", ref: "hp_txn_1", amountCents: 1083, terminal: "1850025030" });
    expect((await w.as(w.manager, "GET", "/payments/pending")).body).toHaveLength(0);
  });

  it("a manager resolves it: never charged", async () => {
    w.gateway.nextSale = { approved: false, pending: true, gatewayRef: "ref:abc" };
    const res = await cardSale();
    w.gateway.lookupResult = { approved: false };
    const resolved = await w.as(w.manager, "POST", `/payments/${res.body.details.paymentId}/resolve`);
    expect(resolved.body.outcome).toBe("DECLINED");
    expect(w.gateway.calls.some((c) => c.op === "void")).toBe(false);
  });

  it("cashiers can't resolve payments", async () => {
    w.gateway.nextSale = { approved: false, pending: true, gatewayRef: "ref:abc" };
    const res = await cardSale();
    expect((await w.as(w.cashier, "POST", `/payments/${res.body.details.paymentId}/resolve`)).status).toBe(403);
  });

  it("refunds run on the terminal that took the payment", async () => {
    const res = await cardSale();
    const refund = await w.as(w.manager, "POST", `/orders/${res.body.order.id}/refund`, { lines: [{ orderLineId: res.body.order.lines[0].id, quantity: 1 }] });
    expect(refund.body.legs[0]).toMatchObject({ tender: "CARD", status: "APPROVED" });
    expect(w.gateway.calls.at(-1)).toMatchObject({ op: "refund", terminal: "1850025030" });
  });

  it("a retry while the customer is still at the terminal doesn't start a second sale", async () => {
    const body = {
      locationId: w.locationId,
      lines: [{ variantId: v.nm, quantity: 1 }],
      tenders: [{ type: "CARD", amountCents: 1083, terminalId }],
      idempotencyKey: key(),
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const originalSale = w.gateway.sale.bind(w.gateway);
    w.gateway.sale = async (req) => {
      await gate;
      return originalSale(req);
    };
    const first = w.as(w.cashier, "POST", "/orders/checkout", body);
    await new Promise((r) => setTimeout(r, 100));
    const retry = await w.as(w.cashier, "POST", "/orders/checkout", body);
    expect(retry.body.error).toBe("SALE_IN_PROGRESS");
    release();
    expect((await first).status).toBe(201);
    expect(w.gateway.calls.filter((c) => c.op === "sale")).toHaveLength(1);
  });
});

describe("terminal sync", () => {
  it("imports terminals from the processor without renaming existing ones", async () => {
    const gateway = new RoutingGateway(
      Object.assign(new MockGateway(), { listTerminals: async () => [{ ref: "1850025030", model: "PAXA920PRO" }, { ref: "1850099999", model: "PAXA80" }] }),
      new MockGateway(),
    );
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp({ prisma, gateway });
    const res = await app.inject({ method: "POST", url: "/terminals/sync", payload: { locationId: w.locationId }, headers: { authorization: `Bearer ${w.manager}` } });
    expect(res.json().added).toBe(1);
    const names = (await prisma.terminal.findMany({ orderBy: { gatewayRef: "asc" } })).map((t) => t.name);
    expect(names).toEqual(["Front counter", "PAXA80 9999"]);
  });
});

describe("routing", () => {
  it("sends terminal sales to the card-present processor and online sales to the other", async () => {
    const cp = Object.assign(new MockGateway(), { name: "handpoint" as const });
    const cnp = Object.assign(new MockGateway(), { name: "nmi" as const });
    const router = new RoutingGateway(cp, cnp);
    const inStore = await router.sale({ amountCents: 100, currency: "USD", terminal: { ref: "1", model: "PAXA920" }, orderRef: "1", idempotencyKey: "k" });
    const online = await router.sale({ amountCents: 100, currency: "USD", paymentToken: "tok_ok", orderRef: "2", idempotencyKey: "k2" });
    expect([inStore.gateway, online.gateway]).toEqual(["handpoint", "nmi"]);
    await router.refund("x", 100, { gateway: "handpoint", terminal: { ref: "1", model: "PAXA920" } });
    expect(cp.calls.at(-1)?.op).toBe("refund");
    expect(cnp.calls.some((c) => c.op === "refund")).toBe(false);
  });
});
