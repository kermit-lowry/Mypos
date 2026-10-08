import { CONFIGURABLE_PRICED_TENDERS } from "@mypos/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { parse, requirePermission, requireRole } from "../http.js";
import type { Ctx } from "../services/context.js";
import { resolveTerminal } from "../services/charges.js";
import { labelData, labelsHtml, labelsZpl, sendToPrinter } from "../services/labels.js";
import { drawerKickBytes, receiptEscPos } from "../services/escpos.js";
import { audit } from "../services/permissions.js";
import { buildReceipt, receiptHtml, receiptTerminalHtml, receiptText } from "../services/receipts.js";

/** Store settings, receipts, price labels, and the customer-facing display. */
export function pricingRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma, gateway } = base;
  const staff = { preHandler: requireRole("CASHIER") };

  /** Owner settings per location, including the dual pricing percentage. */
  app.patch("/locations/:id", { preHandler: requirePermission("MANAGE_SETTINGS") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(
      z.object({
        name: z.string().min(1).optional(),
        taxRateBps: z.number().int().min(0).max(3_000).optional(),
        /** Card price = cash price + this (399 = 3.99%). 0 turns dual pricing off. */
        cardPriceBps: z.number().int().min(0).max(1_000).optional(),
        /** Which of gift card / store credit / check / rewards pay the card price (default: none, they pay cash price). */
        cardPricedTenders: z.array(z.enum(CONFIGURABLE_PRICED_TENDERS)).optional(),
        labelPrinterHost: z.string().max(255).nullable().optional(),
        receiptHeader: z.string().max(500).nullable().optional(),
        receiptFooter: z.string().max(500).nullable().optional(),
      }),
      req.body,
    );
    return prisma.location.update({ where: { id }, data });
  });

  // ── Receipts ───────────────────────────────────────────────
  app.get("/orders/:id/receipt", staff, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { format, width } = parse(
      z.object({ format: z.enum(["json", "text", "html", "terminal"]).default("json"), width: z.coerce.number().int().min(24).max(64).default(42) }),
      req.query,
    );
    const r = await buildReceipt(prisma, id);
    if (format === "text") return reply.type("text/plain; charset=utf-8").send(receiptText(r, width));
    if (format === "html") return reply.type("text/html; charset=utf-8").send(receiptHtml(r));
    if (format === "terminal") return reply.type("text/html; charset=utf-8").send(receiptTerminalHtml(r));
    return r;
  });

  /**
   * Print a receipt at a register: on its ESC/POS receipt printer if it has
   * one, else on the PAX terminal's built-in printer. `openDrawer` also pops
   * the cash drawer plugged into the receipt printer (cash sales).
   */
  app.post("/orders/:id/receipt/print", staff, async (req) => {
    const { id } = req.params as { id: string };
    const { terminalId, target, openDrawer } = parse(
      z.object({ terminalId: z.string(), target: z.enum(["auto", "printer", "terminal"]).default("auto"), openDrawer: z.boolean().default(false) }),
      req.body,
    );
    const order = await prisma.order.findUniqueOrThrow({ where: { id } });
    const terminal = await resolveTerminal(prisma, terminalId, order.locationId);
    const { receiptPrinterHost } = await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } });
    const receipt = await buildReceipt(prisma, id);

    const usePrinter = target === "printer" || (target === "auto" && !!receiptPrinterHost);
    if (usePrinter) {
      if (!receiptPrinterHost) throw badRequest("NO_PRINTER", "No receipt printer set up for this register");
      await sendToPrinter(receiptPrinterHost, receiptEscPos(receipt, { openDrawer }));
      return { printed: true, on: "printer" };
    }
    if (openDrawer) throw badRequest("NO_DRAWER", "Cash drawers open through a receipt printer; none is set up for this register");
    if (!gateway.printReceipt) throw badRequest("NO_PRINTER", "This terminal can't print");
    const r = await gateway.printReceipt(receiptTerminalHtml(receipt), terminal);
    if (!r.approved) throw badRequest("PRINT_FAILED", r.message ?? "The terminal couldn't print");
    return { printed: true, on: "terminal" };
  });

  /** "No sale": open the register's cash drawer. Managers only, and logged. */
  app.post("/terminals/:id/drawer", { preHandler: requirePermission("NO_SALE") }, async (req) => {
    const { id } = req.params as { id: string };
    const t = await prisma.terminal.findUniqueOrThrow({ where: { id } });
    if (!t.receiptPrinterHost) throw badRequest("NO_DRAWER", "No receipt printer (and drawer) set up for this register");
    await sendToPrinter(t.receiptPrinterHost, drawerKickBytes());
    await audit(prisma, { action: "NO_SALE", staffId: req.user.sub, approverId: req.approverId, locationId: t.locationId, details: { terminalId: id } });
    return { opened: true };
  });

  // ── Price labels ───────────────────────────────────────────
  const LabelRequest = z.object({
    locationId: z.string(),
    items: z.array(z.object({ variantId: z.string(), copies: z.number().int().min(1).max(500).default(1) })).min(1).max(500),
  });

  app.post("/labels", staff, async (req, reply) => {
    const body = parse(LabelRequest.extend({ format: z.enum(["zpl", "html", "json"]).default("html") }), req.body);
    const labels = await labelData(prisma, body.locationId, body.items);
    if (body.format === "zpl") return reply.type("text/plain; charset=utf-8").send(labelsZpl(labels));
    if (body.format === "html") return reply.type("text/html; charset=utf-8").send(labelsHtml(labels));
    return labels;
  });

  /** Send labels straight to the location's network Zebra printer. */
  app.post("/labels/print", staff, async (req) => {
    const body = parse(LabelRequest, req.body);
    const location = await prisma.location.findUniqueOrThrow({ where: { id: body.locationId } });
    if (!location.labelPrinterHost) throw badRequest("PRINTER", "No label printer set up for this location");
    const labels = await labelData(prisma, body.locationId, body.items);
    await sendToPrinter(location.labelPrinterHost, labelsZpl(labels));
    return { printed: labels.reduce((a, l) => a + l.copies, 0) };
  });

  // ── Customer-facing display ────────────────────────────────
  // The register publishes its cart here; the display device polls it.
  app.put("/displays/:channel", staff, async (req) => {
    const { channel } = req.params as { channel: string };
    const payload = parse(z.record(z.unknown()), req.body);
    await prisma.customerDisplay.upsert({
      where: { channel },
      create: { channel, payload: payload as object },
      update: { payload: payload as object },
    });
    return { ok: true };
  });

  app.get("/displays/:channel", staff, async (req) => {
    const { channel } = req.params as { channel: string };
    const d = await prisma.customerDisplay.findUnique({ where: { channel } });
    return d ? { ...(d.payload as object), updatedAt: d.updatedAt } : { state: "IDLE" };
  });
}
