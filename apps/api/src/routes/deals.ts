import { PromotionInput } from "@mypos/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../errors.js";
import { parse, requireRole } from "../http.js";
import type { Ctx } from "../services/context.js";
import { categoryLineage, runningPromotions } from "../services/promotions.js";

/** Back office: categories and automated deals. */
export function dealRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireRole("CASHIER") };
  const manager = { preHandler: requireRole("MANAGER") };

  // ── Categories ─────────────────────────────────────────────
  app.get("/categories", staff, async () => {
    const [all, counts] = await Promise.all([
      prisma.category.findMany({ orderBy: { name: "asc" } }),
      prisma.product.groupBy({ by: ["categoryId"], _count: true }),
    ]);
    const lineage = await categoryLineage(prisma);
    const byId = new Map(all.map((c) => [c.id, c]));
    return all
      .map((c) => ({
        ...c,
        /** "Pokémon > Sealed > Booster Boxes" */
        path: (lineage.get(c.id) ?? [c.id]).map((id) => byId.get(id)?.name ?? "?").reverse().join(" > "),
        productCount: counts.find((x) => x.categoryId === c.id)?._count ?? 0,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  });

  app.post("/categories", manager, async (req, reply) => {
    const { name, parentId } = parse(z.object({ name: z.string().min(1).max(80), parentId: z.string().nullable().optional() }), req.body);
    if (parentId && !(await prisma.category.findUnique({ where: { id: parentId } }))) throw notFound("Parent category");
    // NULL parents aren't unique in Postgres, so check top-level names by hand.
    if (await prisma.category.findFirst({ where: { name, parentId: parentId ?? null } })) throw conflict("DUPLICATE", "That category already exists here");
    return reply.code(201).send(await prisma.category.create({ data: { name, parentId: parentId ?? null } }));
  });

  app.patch("/categories/:id", manager, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(z.object({ name: z.string().min(1).max(80).optional(), parentId: z.string().nullable().optional() }), req.body);
    if (data.parentId) {
      // Moving a category under its own descendant would create a loop.
      const lineage = await categoryLineage(prisma);
      if ((lineage.get(data.parentId) ?? []).includes(id)) throw badRequest("CATEGORY_LOOP", "A category can't go inside itself");
    }
    return prisma.category.update({ where: { id }, data });
  });

  app.delete("/categories/:id", manager, async (req) => {
    const { id } = req.params as { id: string };
    const [children, products] = await Promise.all([prisma.category.count({ where: { parentId: id } }), prisma.product.count({ where: { categoryId: id } })]);
    if (children || products) throw conflict("CATEGORY_IN_USE", "Move its products and subcategories first", { children, products });
    await prisma.category.delete({ where: { id } });
    return { deleted: true };
  });

  /** Put products in a category (or take them out with categoryId null). */
  app.post("/categories/assign", manager, async (req) => {
    const { categoryId, productIds } = parse(z.object({ categoryId: z.string().nullable(), productIds: z.array(z.string()).min(1).max(1000) }), req.body);
    if (categoryId && !(await prisma.category.findUnique({ where: { id: categoryId } }))) throw notFound("Category");
    const r = await prisma.product.updateMany({ where: { id: { in: productIds } }, data: { categoryId } });
    return { updated: r.count };
  });

  // ── Deals ──────────────────────────────────────────────────
  app.get("/promotions", staff, async (req) => {
    const { active } = parse(z.object({ active: z.enum(["true", "false"]).optional() }), req.query);
    return prisma.promotion.findMany({
      where: active ? { active: active === "true" } : {},
      orderBy: [{ active: "desc" }, { priority: "asc" }, { createdAt: "asc" }],
    });
  });

  /** What's running right now at a location (for the register's "Deals today"). */
  app.get("/promotions/running", staff, async (req) => {
    const { locationId, channel } = parse(z.object({ locationId: z.string(), channel: z.enum(["POS", "STOREFRONT"]).default("POS") }), req.query);
    const location = await prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    return (await runningPromotions(prisma, location, channel)).map((p) => ({ id: p.id, name: p.name, type: p.type }));
  });

  app.post("/promotions", manager, async (req, reply) => reply.code(201).send(await prisma.promotion.create({ data: parse(PromotionInput, req.body) })));

  app.put("/promotions/:id", manager, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(PromotionInput, req.body);
    // Full replace, so clearing an optional field (e.g. an end date) sticks.
    const nulls = Object.fromEntries(
      ["description", "percentBps", "amountCents", "priceCents", "buyQty", "getQty", "getDiscountBps", "minQty", "minSubtotalCents", "maxApplications", "startsAt", "endsAt", "startTime", "endTime"].map((k) => [k, null]),
    );
    return prisma.promotion.update({ where: { id }, data: { ...nulls, ...data } });
  });

  app.patch("/promotions/:id", manager, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(z.object({ active: z.boolean().optional(), priority: z.number().int().min(0).max(10_000).optional() }), req.body);
    return prisma.promotion.update({ where: { id }, data });
  });

  app.delete("/promotions/:id", manager, async (req) => {
    const { id } = req.params as { id: string };
    await prisma.promotion.delete({ where: { id } });
    return { deleted: true };
  });
}
