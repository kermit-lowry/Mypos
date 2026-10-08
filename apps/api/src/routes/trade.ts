import {
  AuthenticationInput,
  BuylistAcceptInput,
  BuylistPolicyInput,
  CardConditions,
  CardFinishes,
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
import { actorOf, approvalTokenOf, authorize, parse, requirePermission, requireRole } from "../http.js";
import { forbidden } from "../errors.js";
import type { CardSource } from "../pricing/cardSources.js";
import { withMarket } from "../pricing/trends.js";
import { acceptBuylist, quoteBuylist, rejectBuylist, savePolicies, suggestLines } from "../services/buylist.js";
import { importCard } from "../services/cardImport.js";
import { audit } from "../services/permissions.js";
import * as consignment from "../services/consignment.js";
import type { Ctx } from "../services/context.js";
import { checkIn, createEvent, eventRoster } from "../services/events.js";
import * as preorders from "../services/preorders.js";

/** Buylist, consignment & authentication, events, preorders. */
export function tradeRoutes(app: FastifyInstance, base: Ctx, cardSources: CardSource[] = []) {
  const { prisma } = base;
  const staff = { preHandler: requireRole("CASHIER") };
  const ctx = (req: Parameters<typeof actorOf>[0]): Ctx => ({ ...base, actor: actorOf(req), perms: req.perms, approvalToken: approvalTokenOf(req) });
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  // ── Buylist ────────────────────────────────────────────────
  /** Suggested offers for items on the counter, without making a ticket. */
  app.post("/buylist/suggest", staff, async (req) => {
    const input = parse(BuylistQuoteInput.pick({ locationId: true, lines: true }), req.body);
    return suggestLines(prisma, input.locationId, input.lines);
  });
  app.post("/buylist/quote", staff, async (req, reply) =>
    reply.code(201).send(await quoteBuylist(ctx(req), parse(BuylistQuoteInput, req.body), () => authorize(req, "BUYLIST_OVERRIDE", "buylist offer above suggestion"))),
  );
  // Paying out cash/credit is a manager action at most stores.
  // Paying cash and issuing store credit are separate permissions.
  app.post("/buylist/:id/accept", staff, async (req) => {
    const input = parse(BuylistAcceptInput, req.body);
    await authorize(req, input.payout === "CASH" ? "BUYLIST_PAYOUT" : "BUYLIST_CREDIT", `buylist ${input.payout}`);
    const ticket = await acceptBuylist(ctx(req), id(req), input);
    await audit(prisma, {
      action: input.payout === "CASH" ? "BUYLIST_CASH" : "BUYLIST_CREDIT",
      staffId: req.user.sub,
      approverId: req.approverId,
      locationId: ticket.locationId,
      details: { ticketId: ticket.id, number: ticket.number, paidCents: ticket.paidCents, customerId: ticket.customerId, items: ticket.lines.map((l) => ({ description: l.description, quantity: l.quantity })) },
    });
    return ticket;
  });

  /**
   * Find what a customer brought in: the store's catalog plus Scryfall
   * (Magic) and pokemontcg.io (Pokémon) for cards not stocked yet.
   */
  app.get("/buylist/lookup", staff, async (req) => {
    const { q, locationId } = parse(z.object({ q: z.string().min(2), locationId: z.string().optional() }), req.query);
    const [catalog, ...external] = await Promise.all([
      prisma.product.findMany({
        where: {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { styleCode: { equals: q, mode: "insensitive" } },
            { setCode: { equals: q, mode: "insensitive" } },
            { variants: { some: { OR: [{ sku: q }, { barcode: q }, { certNumber: q }] } } },
          ],
        },
        take: 30,
        orderBy: { title: "asc" },
        include: { variants: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { inventory: locationId ? { where: { locationId } } : true } } },
      }),
      ...cardSources.map((s) => s.search(q).then((cards) => ({ cards, error: null as string | null })).catch((e: unknown) => ({ cards: [], error: `${s.source}: ${e instanceof Error ? e.message : e}` }))),
    ]);
    const stocked = new Set(catalog.flatMap((p) => [p.scryfallId, p.pokemonTcgId]).filter(Boolean));
    const others = await prisma.product.findMany({
      where: { OR: [{ scryfallId: { in: external.flatMap((e) => e.cards.map((c) => c.externalId)) } }, { pokemonTcgId: { in: external.flatMap((e) => e.cards.map((c) => c.externalId)) } }] },
      select: { scryfallId: true, pokemonTcgId: true },
    });
    others.forEach((p) => [p.scryfallId, p.pokemonTcgId].forEach((x) => x && stocked.add(x)));
    return {
      catalog: await withMarket(prisma, catalog),
      external: external.flatMap((e) => e.cards).filter((c) => !stocked.has(c.externalId)),
      errors: external.flatMap((e) => (e.error ? [e.error] : [])),
    };
  });

  /** Add a looked-up card to the catalog in a given condition/finish (for the trade-in ticket). */
  app.post("/catalog/import-card", staff, async (req, reply) => {
    const levels = req.perms!.levels;
    const allowed = levels.MANAGE_CATALOG === "ALLOW" || levels.BUYLIST_PAYOUT !== "DENY" || levels.BUYLIST_CREDIT !== "DENY";
    if (!allowed) throw forbidden("You can't add cards to the catalog");
    const input = parse(
      z.object({
        source: z.enum(["scryfall", "pokemontcg"]),
        externalId: z.string().min(1),
        condition: z.enum(CardConditions),
        finish: z.enum(CardFinishes).optional(),
      }),
      req.body,
    );
    const r = await importCard(prisma, cardSources, input);
    if (r.created) await audit(prisma, { action: "CARD_IMPORTED", staffId: req.user.sub, details: { sku: r.variant.sku, title: r.product.title, source: input.source } });
    return reply.code(r.created ? 201 : 200).send(r);
  });

  // ── Trade-in offer rules (owner) ───────────────────────────
  app.get("/buylist/policies", staff, async () => prisma.buylistPolicy.findMany({ orderBy: [{ kind: "asc" }, { categoryId: "asc" }] }));
  app.put("/buylist/policies", { preHandler: requirePermission("MANAGE_BUYLIST") }, async (req) =>
    savePolicies(prisma, parse(z.array(BuylistPolicyInput).max(200), req.body)),
  );
  app.post("/buylist/:id/reject", staff, async (req) => {
    await rejectBuylist(ctx(req), id(req));
    return { ok: true };
  });
  app.get("/buylist/:id", staff, async (req) => prisma.buylistTicket.findUniqueOrThrow({ where: { id: id(req) }, include: { lines: true } }));

  // ── Consignment & authentication ───────────────────────────
  app.post("/consignors", { preHandler: requirePermission("MANAGE_CONSIGNMENT") }, async (req) => consignment.createConsignor(ctx(req), parse(ConsignorInput, req.body)));
  app.post("/consignment", { preHandler: requirePermission("MANAGE_CONSIGNMENT") }, async (req) => consignment.consignItem(ctx(req), parse(ConsignInput, req.body)));
  app.post("/consignment/:id/return", { preHandler: requirePermission("MANAGE_CONSIGNMENT") }, async (req) => consignment.returnConsignment(ctx(req), id(req)));
  app.get("/consignors/:id/statement", { preHandler: requirePermission("MANAGE_CONSIGNMENT") }, async (req) => consignment.consignorStatement(ctx(req), id(req)));
  app.post("/consignors/:id/settle", { preHandler: requirePermission("CONSIGNOR_SETTLE") }, async (req) => consignment.settleConsignor(ctx(req), id(req)));
  app.post("/authentications", staff, async (req) => consignment.recordAuthentication(ctx(req), parse(AuthenticationInput, req.body)));

  // ── Events ─────────────────────────────────────────────────
  app.post("/events", { preHandler: requirePermission("MANAGE_EVENTS") }, async (req, reply) => reply.code(201).send(await createEvent(ctx(req), parse(EventInput, req.body))));
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
  app.post("/preorder-products", { preHandler: requirePermission("MANAGE_CATALOG") }, async (req) => preorders.createPreorderProduct(ctx(req), parse(PreorderProductInput, req.body)));
  app.get("/preorder-products/:id", staff, async (req) => preorders.preorderAvailability(ctx(req), id(req)));
  app.post("/preorders", staff, async (req, reply) => reply.code(201).send(await preorders.placePreorder(ctx(req), parse(PreorderInput, req.body))));
  app.post("/preorders/:id/fulfill", staff, async (req) =>
    preorders.fulfillPreorder(
      ctx(req),
      id(req),
      parse(z.object({ locationId: z.string(), tenders: z.array(TenderInput), idempotencyKey: z.string().min(8) }), req.body),
    ),
  );
  app.post("/preorders/:id/cancel", { preHandler: requirePermission("PREORDER_CANCEL") }, async (req) => {
    const { toStoreCredit, terminalId } = parse(
      z.object({ toStoreCredit: z.boolean().default(false), terminalId: z.string().optional() }),
      req.body ?? {},
    );
    return preorders.cancelPreorder(ctx(req), id(req), toStoreCredit, terminalId);
  });
}
