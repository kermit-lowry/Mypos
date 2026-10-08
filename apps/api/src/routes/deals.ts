import { DiscountPresetInput, DiscountReasonInput, PromotionInput } from "@mypos/shared";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../errors.js";
import { parse, requirePermission, requireRole } from "../http.js";
import { audit, changes } from "../services/permissions.js";
import type { Ctx } from "../services/context.js";
import { categoryLineage, runningPromotions } from "../services/promotions.js";

/** Fields a PATCH actually changed, as { field: { from, to } }, for the activity log. */
/** Back office: categories and automated deals. */
export function dealRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireRole("CASHIER") };

  // ── Categories ─────────────────────────────────────────────
  /** "Pokémon > Sealed > Booster Boxes" for one category. */
  const pathOf = async (id: string) => {
    const [lineage, all] = await Promise.all([categoryLineage(prisma), prisma.category.findMany({ select: { id: true, name: true } })]);
    const names = new Map(all.map((c) => [c.id, c.name]));
    return (lineage.get(id) ?? [id]).map((x) => names.get(x) ?? "?").reverse().join(" > ");
  };

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

  app.post("/categories", { preHandler: requirePermission("MANAGE_DEALS") }, async (req, reply) => {
    const { name, parentId } = parse(z.object({ name: z.string().min(1).max(80), parentId: z.string().nullable().optional() }), req.body);
    if (parentId && !(await prisma.category.findUnique({ where: { id: parentId } }))) throw notFound("Parent category");
    // NULL parents aren't unique in Postgres, so check top-level names by hand.
    if (await prisma.category.findFirst({ where: { name, parentId: parentId ?? null } })) throw conflict("DUPLICATE", "That category already exists here");
    const c = await prisma.category.create({ data: { name, parentId: parentId ?? null } });
    await audit(prisma, { action: "CATEGORY_CREATED", staffId: req.user.sub, details: { categoryId: c.id, name: c.name, path: await pathOf(c.id) } });
    return reply.code(201).send(c);
  });

  app.patch("/categories/:id", { preHandler: requirePermission("MANAGE_DEALS") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(z.object({ name: z.string().min(1).max(80).optional(), parentId: z.string().nullable().optional() }), req.body);
    if (data.parentId) {
      // Moving a category under its own descendant would create a loop.
      const lineage = await categoryLineage(prisma);
      if ((lineage.get(data.parentId) ?? []).includes(id)) throw badRequest("CATEGORY_LOOP", "A category can't go inside itself");
    }
    const before = await prisma.category.findUnique({ where: { id } });
    if (!before) throw notFound("Category");
    const c = await prisma.category.update({ where: { id }, data });
    await audit(prisma, { action: "CATEGORY_UPDATED", staffId: req.user.sub, details: { categoryId: id, name: c.name, path: await pathOf(id), changes: changes(before, data) } });
    return c;
  });

  app.delete("/categories/:id", { preHandler: requirePermission("MANAGE_DEALS") }, async (req) => {
    const { id } = req.params as { id: string };
    const c = await prisma.category.findUnique({ where: { id } });
    if (!c) throw notFound("Category");
    const [children, products] = await Promise.all([prisma.category.count({ where: { parentId: id } }), prisma.product.count({ where: { categoryId: id } })]);
    if (children || products) throw conflict("CATEGORY_IN_USE", "Move its products and subcategories first", { children, products });
    const path = await pathOf(id);
    await prisma.category.delete({ where: { id } });
    await audit(prisma, { action: "CATEGORY_DELETED", staffId: req.user.sub, details: { categoryId: id, name: c.name, path } });
    return { deleted: true };
  });

  /** Put products in a category (or take them out with categoryId null). */
  app.post("/categories/assign", { preHandler: requirePermission("MANAGE_DEALS") }, async (req) => {
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

  const promoSummary = (p: { id: string; name: string; type: string; active: boolean }) => ({ promotionId: p.id, name: p.name, type: p.type, active: p.active });

  app.post("/promotions", { preHandler: requirePermission("MANAGE_DEALS") }, async (req, reply) => {
    const p = await prisma.promotion.create({ data: parse(PromotionInput, req.body) });
    await audit(prisma, { action: "PROMOTION_CREATED", staffId: req.user.sub, details: promoSummary(p) });
    return reply.code(201).send(p);
  });

  app.put("/promotions/:id", { preHandler: requirePermission("MANAGE_DEALS") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(PromotionInput, req.body);
    // Full replace, so clearing an optional field (e.g. an end date) sticks.
    const nulls = Object.fromEntries(
      ["description", "percentBps", "amountCents", "priceCents", "buyQty", "getQty", "getDiscountBps", "minQty", "minSubtotalCents", "maxApplications", "startsAt", "endsAt", "startTime", "endTime"].map((k) => [k, null]),
    );
    const before = await prisma.promotion.findUnique({ where: { id } });
    if (!before) throw notFound("Promotion");
    const update = { ...nulls, ...data };
    const p = await prisma.promotion.update({ where: { id }, data: update });
    await audit(prisma, { action: "PROMOTION_UPDATED", staffId: req.user.sub, details: { ...promoSummary(p), changes: changes(before, update) } });
    return p;
  });

  app.patch("/promotions/:id", { preHandler: requirePermission("MANAGE_DEALS") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(z.object({ active: z.boolean().optional(), priority: z.number().int().min(0).max(10_000).optional() }), req.body);
    const before = await prisma.promotion.findUnique({ where: { id } });
    if (!before) throw notFound("Promotion");
    const p = await prisma.promotion.update({ where: { id }, data });
    await audit(prisma, { action: "PROMOTION_UPDATED", staffId: req.user.sub, details: { ...promoSummary(p), changes: changes(before, data) } });
    return p;
  });

  app.delete("/promotions/:id", { preHandler: requirePermission("MANAGE_DEALS") }, async (req) => {
    const { id } = req.params as { id: string };
    const p = await prisma.promotion.findUnique({ where: { id } });
    if (!p) throw notFound("Promotion");
    await prisma.promotion.delete({ where: { id } });
    await audit(prisma, { action: "PROMOTION_DELETED", staffId: req.user.sub, details: promoSummary(p) });
    return { deleted: true };
  });

  // ── Manual discount setup: reasons and one-tap buttons ─────
  app.get("/discount-reasons", staff, async (req) => {
    const { all } = parse(z.object({ all: z.coerce.boolean().default(false) }), req.query);
    return prisma.discountReason.findMany({ where: all ? {} : { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  });
  app.post("/discount-reasons", { preHandler: requirePermission("MANAGE_DEALS") }, async (req, reply) => {
    const r = await prisma.discountReason.create({ data: parse(DiscountReasonInput, req.body) });
    await audit(prisma, { action: "DISCOUNT_REASON_CREATED", staffId: req.user.sub, details: { reasonId: r.id, name: r.name, active: r.active, requiresNote: r.requiresNote } });
    return reply.code(201).send(r);
  });
  app.patch("/discount-reasons/:id", { preHandler: requirePermission("MANAGE_DEALS") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(DiscountReasonInput.partial(), req.body);
    const before = await prisma.discountReason.findUnique({ where: { id } });
    if (!before) throw notFound("Discount reason");
    // Reasons are only turned off, never deleted, so old sales keep their history.
    const r = await prisma.discountReason.update({ where: { id }, data });
    await audit(prisma, {
      action: "DISCOUNT_REASON_UPDATED",
      staffId: req.user.sub,
      details: { reasonId: id, name: r.name, active: r.active, requiresNote: r.requiresNote, changes: changes(before, data) },
    });
    return r;
  });

  app.get("/discount-presets", staff, async (req) => {
    const { all } = parse(z.object({ all: z.coerce.boolean().default(false) }), req.query);
    return prisma.discountPreset.findMany({ where: all ? {} : { active: true }, orderBy: [{ sortOrder: "asc" }, { label: "asc" }] });
  });
  app.post("/discount-presets", { preHandler: requirePermission("MANAGE_DEALS") }, async (req, reply) => {
    const data = parse(DiscountPresetInput, req.body);
    if (data.reasonId && !(await prisma.discountReason.findUnique({ where: { id: data.reasonId } }))) throw notFound("Discount reason");
    const p = await prisma.discountPreset.create({ data });
    await audit(prisma, {
      action: "DISCOUNT_PRESET_CREATED",
      staffId: req.user.sub,
      details: { presetId: p.id, label: p.label, kind: p.kind, value: p.value, reasonId: p.reasonId, active: p.active },
    });
    return reply.code(201).send(p);
  });
  app.patch("/discount-presets/:id", { preHandler: requirePermission("MANAGE_DEALS") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(z.object({ label: z.string().min(1).max(30).optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional(), reasonId: z.string().nullable().optional() }), req.body);
    const before = await prisma.discountPreset.findUnique({ where: { id } });
    if (!before) throw notFound("Discount preset");
    const p = await prisma.discountPreset.update({ where: { id }, data });
    await audit(prisma, { action: "DISCOUNT_PRESET_UPDATED", staffId: req.user.sub, details: { presetId: id, label: p.label, active: p.active, changes: changes(before, data) } });
    return p;
  });
}
