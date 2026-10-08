import { CartLine, ShippingAddress, cardPrice } from "@mypos/shared";
import type { Location } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { availableFor } from "../channels/sync.js";
import { marketTrends } from "../pricing/trends.js";
import { badRequest, notFound } from "../errors.js";
import { parse } from "../http.js";
import { checkout } from "../services/checkout.js";
import { quoteCart } from "../services/quote.js";
import type { Ctx } from "../services/context.js";

/**
 * Public API for the built-in web store. Same inventory and checkout as the
 * register, but cards only, no price overrides, and only STOREFRONT products.
 */
export function storefrontRoutes(app: FastifyInstance, base: Ctx, opts: { fulfillmentLocationId: () => Promise<string> }) {
  const { prisma } = base;

  /** Online orders pay by card, so the store shows card prices (cash price alongside, for disclosure). */
  const cardBps = async () => (await prisma.location.findUniqueOrThrow({ where: { id: await opts.fulfillmentLocationId() } })).cardPriceBps;

  app.get("/storefront/products", async (req) => {
    const { q, kind, game, cursor } = parse(
      z.object({ q: z.string().optional(), kind: z.string().optional(), game: z.string().optional(), cursor: z.string().optional() }),
      req.query,
    );
    const bps = await cardBps();
    const products = await prisma.product.findMany({
      where: {
        channels: { has: "STOREFRONT" },
        ...(kind ? { kind: kind as never } : {}),
        ...(game ? { game } : {}),
        ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      },
      take: 48,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      include: { variants: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { inventory: true } } },
    });
    const trends = await marketTrends(prisma, products.flatMap((p) => p.variants.map((v) => v.id)));
    return {
      products: products.map((p) => ({
        id: p.id,
        kind: p.kind,
        title: p.title,
        brand: p.brand,
        imageUrl: p.imageUrl,
        game: p.game,
        setName: p.setName,
        variants: p.variants.map((v) => ({
          id: v.id,
          imageUrl: v.imageUrl ?? p.imageUrl,
          priceCents: cardPrice(v.priceCents, bps),
          cashPriceCents: v.priceCents,
          condition: v.condition,
          gradingCompany: v.gradingCompany,
          grade: v.grade,
          certNumber: v.certNumber,
          finish: v.finish,
          size: v.size,
          colorway: v.colorway,
          itemCondition: v.itemCondition,
          newOrUsed: v.itemCondition ? (v.itemCondition === "DS" ? "NEW" : "USED") : null,
          available: Math.max(0, v.inventory.reduce((a, l) => a + l.onHand - l.reserved, 0)),
          /** Market price and 7-day change, for items with a price feed. */
          market: trends.get(v.id)?.marketCents != null ? trends.get(v.id) : null,
        })),
      })),
      nextCursor: products.length === 48 ? products.at(-1)!.id : null,
    };
  });

  app.get("/storefront/products/:id", async (req) => {
    const { id } = req.params as { id: string };
    const bps = await cardBps();
    const p = await prisma.product.findFirst({ where: { id, channels: { has: "STOREFRONT" } }, include: { variants: true } });
    if (!p) throw notFound("Product");
    return {
      ...p,
      variants: await Promise.all(
        p.variants.map(async (v) => ({
          ...v,
          costCents: undefined,
          priceCents: cardPrice(v.priceCents, bps),
          cashPriceCents: v.priceCents,
          available: await availableFor(prisma, v.id),
        })),
      ),
    };
  });

  // ── Fulfillment: pickup or shipping ────────────────────────
  const Fulfillment = z.enum(["PICKUP", "SHIP"]).default("PICKUP");
  const StoreLines = z.array(CartLine.omit({ unitPriceCents: true, discountCents: true })).min(1);

  /**
   * Shipping for an order: the location's flat rate, free once the goods
   * (after discounts, at the card price the shopper pays) reach the
   * threshold; nothing for pickup. Rejects a method the store turned off.
   */
  function shippingFor(location: Location, method: "PICKUP" | "SHIP", goodsCents: number): number {
    if (method === "PICKUP" && !location.onlinePickupEnabled) throw badRequest("FULFILLMENT_DISABLED", "In-store pickup isn't offered", { fulfillment: method });
    if (method === "SHIP" && !location.onlineShippingEnabled) throw badRequest("FULFILLMENT_DISABLED", "Shipping isn't offered", { fulfillment: method });
    if (method !== "SHIP") return 0;
    if (location.onlineFreeShippingOverCents !== null && goodsCents >= location.onlineFreeShippingOverCents) return 0;
    return location.onlineShippingFlatCents;
  }

  /** What the store offers, so the checkout page can render the choice. */
  app.get("/storefront/fulfillment", async () => {
    const loc = await prisma.location.findUniqueOrThrow({ where: { id: await opts.fulfillmentLocationId() } });
    return {
      pickup: loc.onlinePickupEnabled,
      shipping: loc.onlineShippingEnabled,
      shippingFlatCents: loc.onlineShippingFlatCents,
      freeShippingOverCents: loc.onlineFreeShippingOverCents,
      pickupInstructions: loc.pickupInstructions,
    };
  });

  /** Cart totals with online deals applied, plus shipping for the chosen method. Online orders pay the card price. */
  app.post("/storefront/quote", async (req) => {
    const { lines, fulfillment } = parse(z.object({ lines: StoreLines, fulfillment: Fulfillment }), req.body);
    const locationId = await opts.fulfillmentLocationId();
    const [loc, q] = await Promise.all([
      prisma.location.findUniqueOrThrow({ where: { id: locationId } }),
      quoteCart(prisma, { locationId, channel: "STOREFRONT", lines: lines.map((l) => ({ ...l, discountCents: 0 })), rewardIds: [] }),
    ]);
    const shippingCents = shippingFor(loc, fulfillment, q.card.subtotalCents - q.card.discountCents);
    return {
      fulfillment,
      subtotalCents: q.card.subtotalCents,
      discountCents: q.card.discountCents,
      taxCents: q.card.taxCents,
      shippingCents,
      totalCents: q.card.totalCents + shippingCents,
      promotions: q.promotions,
      pickupInstructions: fulfillment === "PICKUP" ? loc.pickupInstructions : null,
    };
  });

  app.post("/storefront/checkout", async (req, reply) => {
    const body = parse(
      z.object({
        email: z.string().email(),
        name: z.string().min(1),
        phone: z.string().trim().max(40).optional(),
        lines: StoreLines,
        fulfillment: Fulfillment,
        shippingAddress: ShippingAddress.optional(),
        note: z.string().trim().max(500).optional(),
        paymentToken: z.string().min(1),
        /** Goods at the card price + shipping; must match what the server computes. */
        amountCents: z.number().int().positive(),
        idempotencyKey: z.string().min(8),
      }),
      req.body,
    );
    if (body.fulfillment === "SHIP" && !body.shippingAddress) throw badRequest("SHIPPING_ADDRESS", "Shipping needs an address", { fulfillment: body.fulfillment });
    const locationId = await opts.fulfillmentLocationId();
    const loc = await prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const lines = body.lines.map((l) => ({ ...l, discountCents: 0 }));
    const q = await quoteCart(prisma, { locationId, channel: "STOREFRONT", lines, rewardIds: [] });
    const shippingCents = shippingFor(loc, body.fulfillment, q.card.subtotalCents - q.card.discountCents);
    const customer = await prisma.customer.upsert({
      where: { email: body.email },
      create: { email: body.email, name: body.name, phone: body.phone || undefined },
      update: body.phone ? { phone: body.phone } : {},
    });
    const result = await checkout(
      { ...base, actor: undefined },
      {
        locationId,
        channel: "STOREFRONT",
        customerId: customer.id,
        lines,
        tenders: [{ type: "CARD", amountCents: body.amountCents, paymentToken: body.paymentToken }],
        idempotencyKey: `web:${body.idempotencyKey}`,
        rewardIds: [],
        fulfillment: body.fulfillment,
        shippingCents,
        shippingAddress: body.fulfillment === "SHIP" ? body.shippingAddress : undefined,
        customerPhone: body.phone || body.shippingAddress?.phone || undefined,
        customerNote: body.note || undefined,
      },
      { allowedTenders: ["CARD"] },
    );
    const o = result.order;
    return reply.code(result.replayed ? 200 : 201).send({
      orderId: o.id,
      orderNumber: o.number,
      status: o.status,
      fulfillment: o.fulfillment,
      fulfillmentStatus: o.fulfillmentStatus,
      shippingCents: o.shippingCents,
      shippingAddress: o.shippingAddress,
      pickupInstructions: o.fulfillment === "PICKUP" ? loc.pickupInstructions : null,
      totalCents: o.totalCents + o.cardAdjustmentCents,
      lines: o.lines.map((l) => ({ title: l.title, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
    });
  });
}
