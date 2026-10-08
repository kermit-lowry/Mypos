import { createServer } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;
let terminalId: string;

/** A fake network printer that records what it receives. */
async function fakePrinter() {
  const chunks: Buffer[] = [];
  const server = createServer((s) => s.on("data", (d) => chunks.push(d)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    host,
    received: async () => {
      await new Promise((r) => setTimeout(r, 50));
      return Buffer.concat(chunks);
    },
    close: () => server.close(),
  };
}

const has = (buf: Buffer, bytes: number[]) => buf.includes(Buffer.from(bytes));
const DRAWER_KICK = [0x1b, 0x70, 0, 25, 250];
const CUT = [0x1d, 0x56, 66, 3];

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
  terminalId = (await prisma.terminal.create({ data: { locationId: w.locationId, name: "Front", gatewayRef: "1850025030", model: "PAXA920PRO" } })).id;
});
afterAll(() => prisma.$disconnect());

const cashSale = () =>
  w.as(w.cashier, "POST", "/orders/checkout", {
    locationId: w.locationId,
    lines: [{ variantId: v.nm, quantity: 1 }],
    tenders: [{ type: "CASH", amountCents: 1083, tenderedCents: 2000 }],
    idempotencyKey: key(),
  });

describe("ESC/POS receipt printer", () => {
  it("prints on the register's receipt printer and pops the drawer for cash", async () => {
    const printer = await fakePrinter();
    await w.as(w.manager, "PATCH", `/terminals/${terminalId}`, { receiptPrinterHost: printer.host });
    const sale = await cashSale();
    const res = await w.as(w.cashier, "POST", `/orders/${sale.body.order.id}/receipt/print`, { terminalId, openDrawer: true });
    expect(res.body).toEqual({ printed: true, on: "printer" });
    const bytes = await printer.received();
    printer.close();
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(has(bytes, DRAWER_KICK)).toBe(true);
    expect(has(bytes, CUT)).toBe(true);
    expect(bytes.toString("latin1")).toContain("Change");
    expect(w.gateway.printed).toHaveLength(0);
  });

  it("sends plain ASCII text, never UTF-8, to the printer", async () => {
    const printer = await fakePrinter();
    await w.as(w.manager, "PATCH", `/terminals/${terminalId}`, { receiptPrinterHost: printer.host });
    // A card sale's receipt includes "Visa •••• 4242", which must be mapped.
    const sale = await w.as(w.cashier, "POST", "/orders/checkout", {
      locationId: w.locationId,
      lines: [{ variantId: v.nm, quantity: 2 }],
      tenders: [{ type: "CARD", amountCents: 2165, paymentToken: "tok_ok" }],
      idempotencyKey: key(),
    });
    await w.as(w.cashier, "POST", `/orders/${sale.body.order.id}/receipt/print`, { terminalId });
    const bytes = await printer.received();
    printer.close();
    expect([...bytes].every((b) => b < 0x80)).toBe(true);
    expect(bytes.toString("latin1")).toContain("VISA **** 4242");
  });

  it("falls back to the PAX terminal's printer when the register has none", async () => {
    const sale = await cashSale();
    const res = await w.as(w.cashier, "POST", `/orders/${sale.body.order.id}/receipt/print`, { terminalId });
    expect(res.body.on).toBe("terminal");
  });

  it("won't pretend to open a drawer without a printer", async () => {
    const sale = await cashSale();
    const res = await w.as(w.cashier, "POST", `/orders/${sale.body.order.id}/receipt/print`, { terminalId, openDrawer: true });
    expect(res.body.error).toBe("NO_DRAWER");
  });

  it("reports an unreachable printer clearly", async () => {
    await w.as(w.manager, "PATCH", `/terminals/${terminalId}`, { receiptPrinterHost: "127.0.0.1:1" });
    const sale = await cashSale();
    const res = await w.as(w.cashier, "POST", `/orders/${sale.body.order.id}/receipt/print`, { terminalId });
    expect(res.body.error).toBe("PRINTER_UNREACHABLE");
  });
});

describe("no-sale drawer open", () => {
  it("managers can open the drawer; cashiers can't", async () => {
    const printer = await fakePrinter();
    await w.as(w.manager, "PATCH", `/terminals/${terminalId}`, { receiptPrinterHost: printer.host });
    expect((await w.as(w.cashier, "POST", `/terminals/${terminalId}/drawer`)).status).toBe(403);
    expect((await w.as(w.manager, "POST", `/terminals/${terminalId}/drawer`)).body).toEqual({ opened: true });
    const bytes = await printer.received();
    printer.close();
    expect(has(bytes, DRAWER_KICK)).toBe(true);
  });
});
