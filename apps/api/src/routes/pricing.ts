import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { parse, requireRole } from "../http.js";
import type { Ctx } from "../services/context.js";
import { resolveTerminal } from "../services/charges.js";
import { labelData, labelsHtml, labelsZpl, sendToPrinter } from "../services/labels.js";
import { buildReceipt, receiptHtml, receiptTerminalHtml, receiptText } from "../services/receipts.js";

/** Store settings, receipts, price labels, and the customer-facing display. */
export function pricingRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma, gateway } = base;
  const staff = { preHandler: requireRole("CASHIER") };
  const owner = { preHandler: requireRole("OWNER") };

  /** Owner settings per location, including the dual pricing percentage. */
  app.patch("/locations/:id", owner, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(
      z.object({
        name: z.string().min(1).optional(),
        taxRateBps: z.number().int().min(0).max(3_000).optional(),
        /** Card price = cash price + this (399 = 3.99%). 0 turns dual pricing off. */
        cardPriceBps: z.number().int().min(0).max(1_000).optional(),
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

  /** Print the receipt on the PAX terminal's built-in printer. */
  app.post("/orders/:id/receipt/print", staff, async (req) => {
    const { id } = req.params as { id: string };
    const { terminalId } = parse(z.object({ terminalId: z.string() }), req.body);
    const order = await prisma.order.findUniqueOrThrow({ where: { id } });
    const terminal = await resolveTerminal(prisma, terminalId, order.locationId);
    if (!gateway.printReceipt) throw badRequest("NO_PRINTER", "This terminal can't print");
    const r = await gateway.printReceipt(receiptTerminalHtml(await buildReceipt(prisma, id)), terminal);
    if (!r.approved) throw badRequest("PRINT_FAILED", r.message ?? "The terminal couldn't print");
    return { printed: true };
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
