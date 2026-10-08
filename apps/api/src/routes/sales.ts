import { CheckoutInput, CustomerInput, RefundInput } from "@mypos/shared";
import { OrderStatus, type Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conflict, notFound } from "../errors.js";
import { actorOf, approvalTokenOf, parse, requirePermission, requireRole } from "../http.js";
import { checkout } from "../services/checkout.js";
import type { Ctx } from "../services/context.js";
import { audit } from "../services/permissions.js";
import { refundOrder } from "../services/refunds.js";
import { loyaltyBalances } from "../services/loyalty.js";
import { creditBalance, postCredit } from "../services/storeCredit.js";

export function salesRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireRole("CASHIER") };

  app.post("/orders/checkout", staff, async (req, reply) => {
    const input = parse(CheckoutInput, req.body);
    const result = await checkout({ ...base, actor: actorOf(req), perms: req.perms, approvalToken: approvalTokenOf(req) }, input);
    if (result.replayed && result.order.status === "VOID") {
      throw conflict("ORDER_VOID", "This sale failed earlier; start a new sale", { orderId: result.order.id });
    }
    if (result.replayed && result.order.status === "OPEN") {
      // The first attempt is still waiting on the card terminal.
      throw conflict("SALE_IN_PROGRESS", "Still waiting for the card terminal", { orderId: result.order.id });
    }
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  /** Sales history. `q` is an order number ("#12" or "12") or part of a customer's name/email. */
  app.get("/orders", staff, async (req) => {
    const q = parse(
      z.object({
        locationId: z.string().optional(),
        customerId: z.string().optional(),
        q: z.string().trim().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        status: z.nativeEnum(OrderStatus).optional(),
        take: z.coerce.number().int().positive().max(500).default(50),
      }),
      req.query,
    );
    const number = q.q && /^#?\d+$/.test(q.q) ? Number(q.q.replace("#", "")) : undefined;
    const where: Prisma.OrderWhereInput = {
      locationId: q.locationId,
      customerId: q.customerId,
      status: q.status,
      createdAt: q.from || q.to ? { gte: q.from, lt: q.to } : undefined,
      ...(number !== undefined
        ? { number }
        : q.q
          ? { customer: { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { email: { contains: q.q, mode: "insensitive" } }] } }
          : {}),
    };
    return prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: q.take,
      include: { lines: true, payments: true, customer: { select: { id: true, name: true, email: true } }, staff: { select: { id: true, name: true } }, location: { select: { name: true } } },
    });
  });

  app.get("/orders/:id", staff, async (req) => {
    const { id } = req.params as { id: string };
    const o = await prisma.order.findUnique({
      where: { id },
      include: {
        lines: { include: { variant: { select: { imageUrl: true, product: { select: { imageUrl: true } } } } } },
        payments: true,
        customer: true,
        staff: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
      },
    });
    if (!o) throw notFound("Order");
    return { ...o, lines: o.lines.map(({ variant, ...l }) => ({ ...l, imageUrl: variant.imageUrl ?? variant.product.imageUrl })) };
  });

  app.post("/orders/:id/refund", { preHandler: requirePermission("REFUND") }, async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(RefundInput, { ...(req.body as object), orderId: id });
    const result = await refundOrder({ ...base, actor: actorOf(req) }, input);
    const order = await prisma.order.findUniqueOrThrow({ where: { id } });
    await audit(prisma, {
      action: "REFUND",
      staffId: req.user.sub,
      approverId: req.approverId,
      locationId: order.locationId,
      details: { orderId: id, orderNumber: order.number, amountCents: result.refundCents, legs: result.legs, reason: input.reason ?? null } as object,
    });
    return result;
  });

  // ── Customers & store credit ───────────────────────────────
  app.post("/customers", staff, async (req) => prisma.customer.create({ data: parse(CustomerInput, req.body) }));

  app.patch("/customers/:id", { preHandler: requirePermission("MANAGE_CUSTOMERS") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(z.object({ name: z.string().min(1).max(120).optional(), email: z.string().email().nullable().optional(), phone: z.string().max(40).nullable().optional(), playerIds: z.record(z.string()).optional() }), req.body);
    const c = await prisma.customer.update({ where: { id }, data });
    await audit(prisma, { action: "CUSTOMER_UPDATED", staffId: req.user.sub, details: { customerId: id, fields: Object.keys(data) } });
    return c;
  });

  app.get("/customers", staff, async (req) => {
    const { q } = parse(z.object({ q: z.string().min(1) }), req.query);
    return prisma.customer.findMany({
      where: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] },
      take: 25,
    });
  });

  app.get("/customers/:id", staff, async (req) => {
    const { id } = req.params as { id: string };
    const c = await prisma.customer.findUnique({ where: { id }, include: { consignor: true } });
    if (!c) throw notFound("Customer");
    const [storeCreditCents, loyalty] = await Promise.all([creditBalance(prisma, id), loyaltyBalances(prisma, id)]);
    return { ...c, storeCreditCents, loyalty };
  });

  app.post("/customers/:id/credit", { preHandler: requirePermission("ADJUST_BALANCES") }, async (req) => {
    const { id } = req.params as { id: string };
    const { amountCents, reason } = parse(z.object({ amountCents: z.number().int(), reason: z.string().min(1) }), req.body);
    const balance = await prisma.$transaction(async (tx) => {
      const balanceAfter = await postCredit(tx, { customerId: id, amountCents, reason });
      await audit(tx, {
        action: "BALANCE_ADJUSTED",
        staffId: req.user.sub,
        approverId: req.approverId,
        details: { customerId: id, kind: "STORE_CREDIT", amount: amountCents, reason, balanceAfter },
      });
      return balanceAfter;
    });
    return { storeCreditCents: balance };
  });

  app.post("/gift-cards", { preHandler: requirePermission("GIFT_CARD_ISSUE") }, async (req) => {
    const { code, amountCents } = parse(z.object({ code: z.string().min(6), amountCents: z.number().int().positive() }), req.body);
    const card = await prisma.giftCard.create({ data: { code, balanceCents: amountCents } });
    // Only the last 4 of the code: the activity log is readable by anyone with VIEW_REPORTS.
    await audit(prisma, { action: "GIFT_CARD_ISSUED", staffId: req.user.sub, approverId: req.approverId, details: { giftCardId: card.id, last4: code.slice(-4), amountCents } });
    return card;
  });

  app.get("/gift-cards/:code", staff, async (req) => {
    const { code } = req.params as { code: string };
    const g = await prisma.giftCard.findUnique({ where: { code } });
    if (!g) throw notFound("Gift card");
    return g;
  });
}
