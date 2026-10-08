import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../errors.js";
import { parse, requirePermission, requireRole } from "../http.js";
import type { TerminalRef } from "../payments/gateway.js";
import type { Ctx } from "../services/context.js";
import { audit, changes } from "../services/permissions.js";
import { reconcilePayment } from "../services/reconcile.js";

/** Fields a PATCH actually changed, as { field: { from, to } }, for the activity log. */
export function terminalRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma, gateway } = base;
  const staff = { preHandler: requireRole("CASHIER") };

  app.get("/terminals", staff, async (req) => {
    const { locationId } = parse(z.object({ locationId: z.string().optional() }), req.query);
    return prisma.terminal.findMany({ where: { locationId, active: true }, orderBy: { name: "asc" } });
  });

  /** Pull the merchant's PAX terminals from Handpoint. New ones are added to `locationId`; existing ones keep their name and location. */
  app.post("/terminals/sync", { preHandler: requirePermission("MANAGE_TERMINALS") }, async (req) => {
    const { locationId } = parse(z.object({ locationId: z.string() }), req.body);
    const list = (gateway as { listTerminals?: () => Promise<TerminalRef[]> }).listTerminals;
    if (!list) return { added: 0, terminals: [] };
    const devices = await list.call(gateway);
    let added = 0;
    for (const d of devices) {
      const existing = await prisma.terminal.findUnique({ where: { gatewayRef: d.ref } });
      if (existing) {
        await prisma.terminal.update({ where: { id: existing.id }, data: { model: d.model } });
      } else {
        await prisma.terminal.create({ data: { locationId, gatewayRef: d.ref, model: d.model, name: `${d.model ?? "Terminal"} ${d.ref.slice(-4)}` } });
        added++;
      }
    }
    await audit(prisma, { action: "TERMINAL_SYNCED", staffId: req.user.sub, locationId, details: { count: devices.length, added } });
    return { added, terminals: await prisma.terminal.findMany({ where: { gatewayRef: { in: devices.map((d) => d.ref) } } }) };
  });

  app.patch("/terminals/:id", { preHandler: requirePermission("MANAGE_TERMINALS") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(
      z.object({
        name: z.string().min(1).optional(),
        locationId: z.string().optional(),
        active: z.boolean().optional(),
        receiptPrinterHost: z.string().max(255).nullable().optional(),
      }),
      req.body,
    );
    const before = await prisma.terminal.findUnique({ where: { id } });
    if (!before) throw notFound("Terminal");
    const t = await prisma.terminal.update({ where: { id }, data });
    await audit(prisma, { action: "TERMINAL_UPDATED", staffId: req.user.sub, locationId: t.locationId, details: { terminalId: id, name: t.name, changes: changes(before, data) } });
    return t;
  });

  /** Card payments a manager needs to look at: unknown outcomes, failed voids, failed refunds. */
  app.get("/payments/pending", { preHandler: requirePermission("RESOLVE_PAYMENTS") }, async () =>
    prisma.payment.findMany({ where: { status: "PENDING", tender: "CARD" }, orderBy: { createdAt: "desc" }, take: 100 }),
  );

  app.post("/payments/:id/resolve", { preHandler: requirePermission("RESOLVE_PAYMENTS") }, async (req) => {
    const { id } = req.params as { id: string };
    // Resolving can zero the amount (declined/voided), so read it first.
    const before = await prisma.payment.findUnique({ where: { id } });
    const r = await reconcilePayment(base, id);
    await audit(prisma, {
      action: "PAYMENT_RESOLVED",
      staffId: req.user.sub,
      approverId: req.approverId,
      details: {
        paymentId: id,
        orderId: r.payment.orderId,
        preorderId: r.payment.preorderId,
        outcome: r.outcome,
        amountCents: before?.amountCents ?? r.payment.amountCents,
        message: r.message ?? null,
      },
    });
    return r;
  });
}
