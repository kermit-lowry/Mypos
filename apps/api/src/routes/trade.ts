import {
  AuthenticationInput,
  BuylistAcceptInput,
  BuylistQuoteInput,
  ConsignInput,
  ConsignorInput,
  EventInput,
  PreorderInput,
  PreorderProductInput,
  TenderInput,
} from "@mypos/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, parse, requireRole } from "../http.js";
import { acceptBuylist, quoteBuylist, rejectBuylist } from "../services/buylist.js";
import * as consignment from "../services/consignment.js";
import type { Ctx } from "../services/context.js";
import { checkIn, createEvent, eventRoster } from "../services/events.js";
import * as preorders from "../services/preorders.js";

/** Buylist, consignment & authentication, events, preorders. */
export function tradeRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireRole("CASHIER") };
  const manager = { preHandler: requireRole("MANAGER") };
  const owner = { preHandler: requireRole("OWNER") };
  const ctx = (req: Parameters<typeof actorOf>[0]): Ctx => ({ ...base, actor: actorOf(req) });
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  // ── Buylist ────────────────────────────────────────────────
  app.post("/buylist/quote", staff, async (req, reply) => reply.code(201).send(await quoteBuylist(ctx(req), parse(BuylistQuoteInput, req.body))));
  // Paying out cash/credit is a manager action at most stores.
  app.post("/buylist/:id/accept", manager, async (req) => acceptBuylist(ctx(req), id(req), parse(BuylistAcceptInput, req.body)));
  app.post("/buylist/:id/reject", staff, async (req) => {
    await rejectBuylist(ctx(req), id(req));
    return { ok: true };
  });
  app.get("/buylist/:id", staff, async (req) => prisma.buylistTicket.findUniqueOrThrow({ where: { id: id(req) }, include: { lines: true } }));

  // ── Consignment & authentication ───────────────────────────
  app.post("/consignors", manager, async (req) => consignment.createConsignor(ctx(req), parse(ConsignorInput, req.body)));
  app.post("/consignment", manager, async (req) => consignment.consignItem(ctx(req), parse(ConsignInput, req.body)));
  app.post("/consignment/:id/return", manager, async (req) => consignment.returnConsignment(ctx(req), id(req)));
  app.get("/consignors/:id/statement", manager, async (req) => consignment.consignorStatement(ctx(req), id(req)));
  app.post("/consignors/:id/settle", owner, async (req) => consignment.settleConsignor(ctx(req), id(req)));
  app.post("/authentications", staff, async (req) => consignment.recordAuthentication(ctx(req), parse(AuthenticationInput, req.body)));

  // ── Events ─────────────────────────────────────────────────
  app.post("/events", manager, async (req, reply) => reply.code(201).send(await createEvent(ctx(req), parse(EventInput, req.body))));
  app.get("/events", staff, async (req) => {
    const { locationId } = parse(z.object({ locationId: z.string().optional() }), req.query);
    return prisma.event.findMany({
      where: { locationId, startsAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
      orderBy: { startsAt: "asc" },
      include: { _count: { select: { registrations: true } } },
    });
  });
  app.get("/events/:id", staff, async (req) => eventRoster(ctx(req), id(req)));
  app.post("/events/registrations/:id/check-in", staff, async (req) => checkIn(ctx(req), id(req)));

  // ── Preorders ──────────────────────────────────────────────
  app.post("/preorder-products", manager, async (req) => preorders.createPreorderProduct(ctx(req), parse(PreorderProductInput, req.body)));
  app.get("/preorder-products/:id", staff, async (req) => preorders.preorderAvailability(ctx(req), id(req)));
  app.post("/preorders", staff, async (req, reply) => reply.code(201).send(await preorders.placePreorder(ctx(req), parse(PreorderInput, req.body))));
  app.post("/preorders/:id/fulfill", staff, async (req) =>
    preorders.fulfillPreorder(
      ctx(req),
      id(req),
      parse(z.object({ locationId: z.string(), tenders: z.array(TenderInput), idempotencyKey: z.string().min(8) }), req.body),
    ),
  );
  app.post("/preorders/:id/cancel", manager, async (req) => {
    const { toStoreCredit, terminalId } = parse(
      z.object({ toStoreCredit: z.boolean().default(false), terminalId: z.string().optional() }),
      req.body ?? {},
    );
    return preorders.cancelPreorder(ctx(req), id(req), toStoreCredit, terminalId);
  });
}
