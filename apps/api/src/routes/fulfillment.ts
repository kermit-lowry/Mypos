import { FulfillmentMethod, FulfillmentStatus } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "../errors.js";
import { actorOf, parse, requirePermission, requireStaff } from "../http.js";
import type { Ctx } from "../services/context.js";
import { pickTicketHtml } from "../services/documents.js";
import { pickTicketEscPos, pickTicketText } from "../services/escpos.js";
import * as F from "../services/fulfillment.js";
import { sendToPrinter } from "../services/labels.js";

/** Online orders: the pickup/shipping queue the register watches, set-aside, ready, shipped and picked-up steps, pick tickets. */
export function fulfillmentRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireStaff() };
  const act = { preHandler: requirePermission("FULFILL_ORDERS") };
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  const ctx = (req: FastifyRequest): Ctx => ({ ...base, actor: actorOf(req), perms: req.perms });

  /** Cheap poll for the register (every ~20 s): open counts, new orders since `since`, the newest ten. */
  app.get("/fulfillment/queue", staff, async (req) => {
    const q = parse(z.object({ locationId: z.string().optional(), since: z.coerce.date().optional() }), req.query);
    return F.fulfillmentQueue(prisma, q);
  });

  /** Open orders newest first; `status` is a comma list (default: every open status), `q` an order number, customer, or tracking number. */
  app.get("/fulfillment/orders", staff, async (req) => {
    const q = parse(
      z.object({
        locationId: z.string().optional(),
        status: z.string().optional(),
        fulfillment: z.nativeEnum(FulfillmentMethod).optional(),
        q: z.string().trim().optional(),
        includeClosed: z.enum(["true", "false"]).optional(),
        take: z.coerce.number().int().positive().max(200).default(50),
      }),
      req.query,
    );
    const statuses = q.status
      ?.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const bad = statuses?.filter((s) => !(s in FulfillmentStatus));
    if (bad?.length) throw badRequest("VALIDATION", `Unknown status: ${bad.join(", ")}`);
    return F.listFulfillmentOrders(prisma, {
      locationId: q.locationId,
      status: statuses as FulfillmentStatus[] | undefined,
      fulfillment: q.fulfillment,
      q: q.q || undefined,
      includeClosed: q.includeClosed === "true",
      take: q.take,
    });
  });

  app.get("/fulfillment/orders/:id", staff, async (req) => F.getFulfillmentOrder(prisma, id(req)));

  app.post("/fulfillment/orders/:id/acknowledge", act, async (req) => F.acknowledgeOrder(ctx(req), id(req)));

  app.post("/fulfillment/orders/:id/pick", act, async (req) => {
    const { pickedLineIds } = parse(z.object({ pickedLineIds: z.array(z.string().min(1)).max(500) }), req.body);
    return F.pickOrder(ctx(req), id(req), pickedLineIds);
  });

  app.post("/fulfillment/orders/:id/ready", act, async (req) => {
    const { force } = parse(z.object({ force: z.boolean().default(false) }).default({}), req.body ?? {});
    return F.readyOrder(ctx(req), id(req), { force });
  });

  app.post("/fulfillment/orders/:id/ship", act, async (req) => {
    const body = parse(z.object({ carrier: z.string().trim().min(1).max(60), trackingNumber: z.string().trim().max(120).optional(), note: z.string().trim().max(500).optional() }), req.body);
    return F.shipOrder(ctx(req), id(req), { carrier: body.carrier, trackingNumber: body.trackingNumber || undefined, note: body.note || undefined });
  });

  app.post("/fulfillment/orders/:id/picked-up", act, async (req) => {
    const body = parse(z.object({ note: z.string().trim().max(500).optional() }).default({}), req.body ?? {});
    return F.pickedUpOrder(ctx(req), id(req), { note: body.note || undefined });
  });

  app.post("/fulfillment/orders/:id/problem", act, async (req) => {
    const body = parse(z.object({ note: z.string().trim().min(1).max(500) }), req.body);
    return F.problemOrder(ctx(req), id(req), body);
  });

  app.post("/fulfillment/orders/:id/reopen", act, async (req) => {
    const body = parse(z.object({ note: z.string().trim().max(500).optional() }).default({}), req.body ?? {});
    return F.reopenOrder(ctx(req), id(req), { note: body.note || undefined });
  });

  /** Pick ticket / packing slip: JSON, thermal text (`width` columns) or printable HTML. */
  app.get("/fulfillment/orders/:id/pick-ticket", staff, async (req, reply) => {
    const q = parse(z.object({ format: z.enum(["json", "text", "html"]).default("json"), width: z.coerce.number().int().min(24).max(64).default(42) }), req.query);
    const t = await F.buildPickTicket(prisma, id(req));
    if (q.format === "text") return reply.type("text/plain; charset=utf-8").send(pickTicketText(t, q.width));
    if (q.format === "html") return reply.type("text/html; charset=utf-8").send(pickTicketHtml(t));
    return t;
  });

  /** Print the pick ticket on a register's ESC/POS receipt printer. */
  app.post("/fulfillment/orders/:id/pick-ticket/print", staff, async (req) => {
    const body = parse(z.object({ terminalId: z.string(), width: z.coerce.number().int().min(24).max(64).default(42) }), req.body);
    const o = await prisma.order.findUnique({ where: { id: id(req) }, select: { locationId: true, fulfillment: true } });
    if (!o || !o.fulfillment) throw notFound("Online order");
    const terminal = await prisma.terminal.findUnique({ where: { id: body.terminalId } });
    if (!terminal) throw notFound("Terminal");
    if (terminal.locationId !== o.locationId) throw badRequest("TERMINAL", "That register isn't at this order's location");
    if (!terminal.receiptPrinterHost) throw badRequest("NO_PRINTER", "No receipt printer set up for this register");
    await sendToPrinter(terminal.receiptPrinterHost, pickTicketEscPos(await F.buildPickTicket(prisma, id(req)), body.width));
    return { printed: true, on: "printer" };
  });
}
