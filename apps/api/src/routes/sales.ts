import { CheckoutInput, CustomerInput, RefundInput } from "@mypos/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conflict, notFound } from "../errors.js";
import { actorOf, parse, requireRole } from "../http.js";
import { checkout } from "../services/checkout.js";
import type { Ctx } from "../services/context.js";
import { refundOrder } from "../services/refunds.js";
import { creditBalance, postCredit } from "../services/storeCredit.js";

export function salesRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireRole("CASHIER") };
  const manager = { preHandler: requireRole("MANAGER") };

  app.post("/orders/checkout", staff, async (req, reply) => {
    const input = parse(CheckoutInput, req.body);
    const result = await checkout({ ...base, actor: actorOf(req) }, input);
    if (result.replayed && result.order.status === "VOID") {
      throw conflict("ORDER_VOID", "This sale failed earlier; start a new sale", { orderId: result.order.id });
    }
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get("/orders", staff, async (req) => {
    const { locationId, customerId, take } = parse(
      z.object({ locationId: z.string().optional(), customerId: z.string().optional(), take: z.coerce.number().int().max(200).default(50) }),
      req.query,
    );
    return prisma.order.findMany({ where: { locationId, customerId }, orderBy: { createdAt: "desc" }, take, include: { lines: true } });
  });

  app.get("/orders/:id", staff, async (req) => {
    const { id } = req.params as { id: string };
    const o = await prisma.order.findUnique({ where: { id }, include: { lines: true, payments: true, customer: true } });
    if (!o) throw notFound("Order");
    return o;
  });

  app.post("/orders/:id/refund", manager, async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(RefundInput, { ...(req.body as object), orderId: id });
    return refundOrder({ ...base, actor: actorOf(req) }, input);
  });

  // ── Customers & store credit ───────────────────────────────
  app.post("/customers", staff, async (req) => prisma.customer.create({ data: parse(CustomerInput, req.body) }));

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
    return { ...c, storeCreditCents: await creditBalance(prisma, id) };
  });

  app.post("/customers/:id/credit", manager, async (req) => {
    const { id } = req.params as { id: string };
    const { amountCents, reason } = parse(z.object({ amountCents: z.number().int(), reason: z.string().min(1) }), req.body);
    const balance = await prisma.$transaction((tx) => postCredit(tx, { customerId: id, amountCents, reason }));
    return { storeCreditCents: balance };
  });

  app.post("/gift-cards", manager, async (req) => {
    const { code, amountCents } = parse(z.object({ code: z.string().min(6), amountCents: z.number().int().positive() }), req.body);
    return prisma.giftCard.create({ data: { code, balanceCents: amountCents } });
  });

  app.get("/gift-cards/:code", staff, async (req) => {
    const { code } = req.params as { code: string };
    const g = await prisma.giftCard.findUnique({ where: { code } });
    if (!g) throw notFound("Gift card");
    return g;
  });
}
