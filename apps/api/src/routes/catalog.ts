import type { Prisma } from "@prisma/client";
import { InventoryAdjustInput, ProductInput, buylistOffer, sellPrice } from "@mypos/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../errors.js";
import { actorOf, parse, requireRole } from "../http.js";
import { repriceSingles } from "../pricing/reprice.js";
import { defaultProviders } from "../pricing/providers.js";
import type { Ctx } from "../services/context.js";
import { moveInventory } from "../services/inventory.js";

export function catalogRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireRole("CASHIER") };
  const manager = { preHandler: requireRole("MANAGER") };

  /** Register search: barcode/SKU exact match first, then title / set / number. */
  app.get("/catalog/search", staff, async (req) => {
    const { q, kind, locationId } = parse(
      z.object({ q: z.string().min(1), kind: z.string().optional(), locationId: z.string().optional() }),
      req.query,
    );
    const exact = await prisma.variant.findFirst({
      where: { OR: [{ barcode: q }, { sku: q }] },
      include: { product: true, inventory: true },
    });
    if (exact) return { results: [{ ...exact.product, variants: [exact] }] };

    const where: Prisma.ProductWhereInput = {
      ...(kind ? { kind: kind as Prisma.ProductWhereInput["kind"] } : {}),
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { setName: { contains: q, mode: "insensitive" } },
        { setCode: { equals: q, mode: "insensitive" } },
        { collectorNumber: q },
        { styleCode: { equals: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
      ],
    };
    const results = await prisma.product.findMany({
      where,
      take: 50,
      orderBy: { title: "asc" },
      include: { variants: { include: { inventory: locationId ? { where: { locationId } } : true } } },
    });
    return { results };
  });

  app.post("/catalog/products", manager, async (req) => {
    const input = parse(ProductInput, req.body);
    const { variants, ...product } = input;
    return prisma.product.create({ data: { ...product, variants: { create: variants } }, include: { variants: true } });
  });

  app.get("/catalog/products/:id", staff, async (req) => {
    const { id } = req.params as { id: string };
    const p = await prisma.product.findUnique({
      where: { id },
      include: { variants: { include: { inventory: true, authentication: true, consignment: { where: { status: "ACTIVE" } } } } },
    });
    if (!p) throw notFound("Product");
    return p;
  });

  app.patch("/catalog/variants/:id", manager, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(
      z.object({ priceCents: z.number().int().nonnegative().optional(), autoPrice: z.boolean().optional(), barcode: z.string().optional() }),
      req.body,
    );
    return prisma.variant.update({ where: { id }, data });
  });

  app.post("/inventory/adjust", manager, async (req) => {
    const input = parse(InventoryAdjustInput, req.body);
    const onHand = await prisma.$transaction((tx) =>
      moveInventory(tx, { ...input, staffId: actorOf(req)?.id, strict: input.reason !== "COUNT" }),
    );
    return { onHand };
  });

  app.get("/inventory/:variantId/history", staff, async (req) => {
    const { variantId } = req.params as { variantId: string };
    return prisma.inventoryMovement.findMany({ where: { variantId }, orderBy: { createdAt: "desc" }, take: 100 });
  });

  /** Market price, suggested sell price and buylist offer for one variant. */
  app.get("/pricing/variants/:id", staff, async (req) => {
    const { id } = req.params as { id: string };
    const v = await prisma.variant.findUnique({
      where: { id },
      include: { priceHistory: { orderBy: { capturedAt: "desc" }, take: 30 } },
    });
    if (!v) throw notFound("Variant");
    const market = v.marketCents;
    return {
      variantId: v.id,
      priceCents: v.priceCents,
      marketCents: market,
      marketSource: v.marketSource,
      marketAt: v.marketAt,
      suggestedCents: market !== null ? sellPrice(market) : null,
      buylist: market !== null ? buylistOffer(market) : null,
      history: v.priceHistory,
    };
  });

  app.post("/pricing/reprice", manager, async (req) => {
    const { productIds } = parse(z.object({ productIds: z.array(z.string()).optional() }), req.body ?? {});
    return repriceSingles(prisma, defaultProviders, undefined, { productIds });
  });
}
