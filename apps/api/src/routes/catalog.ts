import type { Prisma } from "@prisma/client";
import { CardConditions, compareSizes, GradingCompanies, InventoryAdjustInput, NEW_OR_USED_KINDS, ProductInput, buylistOffer, sellPrice } from "@mypos/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../errors.js";
import { actorOf, parse, requirePermission, requireRole } from "../http.js";
import { repriceSingles } from "../pricing/reprice.js";
import { defaultProviders } from "../pricing/providers.js";
import { marketTrends, withMarket } from "../pricing/trends.js";
import { brandData, mergeBrands, renameBrand } from "../services/brands.js";
import type { Ctx } from "../services/context.js";
import { moveInventory } from "../services/inventory.js";
import { audit, changes } from "../services/permissions.js";

/** Fields a PATCH actually changed, as { field: { from, to } }, for the activity log. */
export function catalogRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireRole("CASHIER") };

  /** Comma-separated multi-select filter: "10,10.5" -> ["10", "10.5"]. */
  const list = <T extends string>(values?: readonly T[]) =>
    z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []))
      .refine((xs) => !values || xs.every((x) => (values as readonly string[]).includes(x)), { message: "Unknown filter value" }) as unknown as z.ZodType<T[], z.ZodTypeDef, string | undefined>;

  const SearchQuery = z.object({
    /** Free text: name, set, collector #, style code, brand. Optional when filters are set. */
    q: z.string().optional(),
    kind: z.string().optional(),
    locationId: z.string().optional(),
    /** Multi-select filters, comma separated. */
    sizes: list(),
    grades: list(),
    gradingCompanies: list(GradingCompanies),
    conditions: list(CardConditions),
    /** DS, VNDS, USED, DAMAGED; or NEW / USED_ANY. */
    itemConditions: list(["DS", "VNDS", "USED", "DAMAGED", "NEW", "USED_ANY"] as const),
    /** true = slabs only, false = raw only. */
    graded: z.enum(["true", "false"]).optional(),
    /** Only items with stock at `locationId` (or anywhere). */
    inStock: z.enum(["true", "false"]).optional(),
    /** Brand ids (from /catalog/facets) or names; combine with sizes etc. */
    brands: list(),
    /** Only products this vendor supplies (building a purchase order). */
    vendorId: z.string().optional(),
    categoryId: z.string().optional(),
    // Single-value forms kept for older register builds.
    condition: z.enum(CardConditions).optional(),
    itemCondition: z.enum(["DS", "VNDS", "USED", "DAMAGED", "NEW", "USED_ANY"]).optional(),
  });

  function variantFilter(f: z.infer<typeof SearchQuery>): Prisma.VariantWhereInput {
    const conditions = [...f.conditions, ...(f.condition ? [f.condition] : [])];
    const itemConds = new Set<string>();
    for (const c of [...f.itemConditions, ...(f.itemCondition ? [f.itemCondition] : [])]) {
      if (c === "NEW") itemConds.add("DS");
      else if (c === "USED_ANY") ["VNDS", "USED", "DAMAGED"].forEach((x) => itemConds.add(x));
      else itemConds.add(c);
    }
    const and: Prisma.VariantWhereInput[] = [];
    if (f.sizes.length) and.push({ size: { in: f.sizes, mode: "insensitive" } });
    if (f.grades.length) and.push({ grade: { in: f.grades, mode: "insensitive" } });
    if (f.gradingCompanies.length) and.push({ gradingCompany: { in: f.gradingCompanies } });
    if (conditions.length) and.push({ condition: { in: conditions } });
    if (itemConds.size) and.push({ itemCondition: { in: [...itemConds] as ("DS" | "VNDS" | "USED" | "DAMAGED")[] } });
    if (f.graded === "true") and.push({ gradingCompany: { not: null } });
    if (f.graded === "false") and.push({ gradingCompany: null });
    if (f.inStock === "true") and.push({ inventory: { some: { onHand: { gt: 0 }, ...(f.locationId ? { locationId: f.locationId } : {}) } } });
    return and.length ? { AND: and } : {};
  }

  /**
   * Register search: a barcode, SKU, or slab cert number goes straight to that
   * item; otherwise text and/or filters (e.g. every size 10 and 10.5 shoe in stock).
   */
  app.get("/catalog/search", staff, async (req) => {
    const f = parse(SearchQuery, req.query);
    const q = f.q?.trim() ?? "";
    const variantWhere = variantFilter(f);
    const filtered = Object.keys(variantWhere).length > 0;
    const productFilter = f.brands.length > 0 || !!f.vendorId || !!f.categoryId;
    if (!q && !filtered && !f.kind && !productFilter) throw badRequest("SEARCH_EMPTY", "Type something to search for, or pick a filter");

    const productWhere: Prisma.ProductWhereInput = {
      ...(f.kind ? { kind: f.kind as Prisma.ProductWhereInput["kind"] } : {}),
      ...(f.brands.length ? { OR: [{ brandId: { in: f.brands } }, { brand: { in: f.brands, mode: "insensitive" } }] } : {}),
      ...(f.vendorId ? { vendors: { some: { vendorId: f.vendorId } } } : {}),
      ...(f.categoryId ? { categoryId: f.categoryId } : {}),
    };
    const vendors = { select: { vendorId: true, vendorSku: true, costCents: true, preferred: true } } as const;

    if (q) {
      const exact = await prisma.variant.findFirst({
        where: { OR: [{ barcode: q }, { sku: q }, { certNumber: q }], product: productWhere },
        include: { product: { include: { vendors } }, inventory: true },
      });
      if (exact) return { results: await withMarket(prisma, [{ ...exact.product, variants: [exact] }]) };
    }

    const where: Prisma.ProductWhereInput = {
      AND: [
        productWhere,
        q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { setName: { contains: q, mode: "insensitive" } },
                { setCode: { equals: q, mode: "insensitive" } },
                { collectorNumber: q },
                { styleCode: { equals: q, mode: "insensitive" } },
                { brand: { contains: q, mode: "insensitive" } },
                { vendors: { some: { vendorSku: { equals: q, mode: "insensitive" } } } },
              ],
            }
          : {},
        filtered ? { variants: { some: variantWhere } } : {},
      ],
    };
    const results = await prisma.product.findMany({
      where,
      take: 50,
      orderBy: { title: "asc" },
      include: {
        vendors,
        variants: {
          where: filtered ? variantWhere : undefined,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          include: { inventory: f.locationId ? { where: { locationId: f.locationId } } : true },
        },
      },
    });
    return { results: await withMarket(prisma, results) };
  });

  // ── Brands ─────────────────────────────────────────────────
  const BrandBody = z.object({ name: z.string().min(1).max(80), active: z.boolean().optional() });

  /** Every brand with how many products carry it. */
  app.get("/catalog/brands", staff, async (req) => {
    const { q } = parse(z.object({ q: z.string().optional() }), req.query);
    const brands = await prisma.brand.findMany({
      where: q ? { name: { contains: q, mode: "insensitive" } } : {},
      orderBy: { name: "asc" },
      include: { _count: { select: { products: true } } },
    });
    return brands.map(({ _count, ...b }) => ({ ...b, products: _count.products }));
  });
  app.post("/catalog/brands", { preHandler: requirePermission("MANAGE_CATALOG") }, async (req, reply) => {
    const body = parse(BrandBody, req.body);
    const existing = await prisma.brand.findFirst({ where: { name: { equals: body.name.trim(), mode: "insensitive" } } });
    if (existing) throw conflict("BRAND_EXISTS", `${existing.name} already exists`);
    const brand = await prisma.brand.create({ data: { name: body.name.trim(), active: body.active ?? true } });
    await audit(prisma, { action: "BRAND_CREATED", staffId: req.user.sub, details: { brandId: brand.id, name: brand.name } });
    return reply.code(201).send(brand);
  });
  app.patch("/catalog/brands/:id", { preHandler: requirePermission("MANAGE_CATALOG") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(BrandBody.partial(), req.body);
    const before = await prisma.brand.findUnique({ where: { id } });
    if (!before) throw notFound("Brand");
    const renamed = body.name !== undefined && body.name.trim() !== before.name ? await renameBrand(prisma, id, body.name) : before;
    const after = body.active !== undefined ? await prisma.brand.update({ where: { id }, data: { active: body.active } }) : renamed;
    if (renamed.name !== before.name) await audit(prisma, { action: "BRAND_RENAMED", staffId: req.user.sub, details: { brandId: id, from: before.name, to: renamed.name } });
    return after;
  });
  /** Fold one brand into another (typos, "Nike" vs "Nike SB" clean-up). */
  app.post("/catalog/brands/:id/merge", { preHandler: requirePermission("MANAGE_CATALOG") }, async (req) => {
    const { id } = req.params as { id: string };
    const { intoId } = parse(z.object({ intoId: z.string() }), req.body);
    const from = await prisma.brand.findUnique({ where: { id } });
    if (!from) throw notFound("Brand");
    const r = await mergeBrands(prisma, id, intoId);
    await audit(prisma, { action: "BRAND_MERGED", staffId: req.user.sub, details: { from: from.name, into: r.into.name, products: r.moved } });
    return r;
  });

  /** Filter choices for the register: the sizes, grades, and conditions actually stocked. */
  app.get("/catalog/facets", staff, async (req) => {
    const { kind, locationId } = parse(z.object({ kind: z.string().optional(), locationId: z.string().optional() }), req.query);
    const variants = await prisma.variant.findMany({
      where: { ...(kind ? { product: { kind: kind as never } } : {}) },
      select: {
        size: true,
        grade: true,
        gradingCompany: true,
        condition: true,
        itemCondition: true,
        product: { select: { brandId: true, brand: true } },
        inventory: { where: locationId ? { locationId } : {}, select: { onHand: true } },
      },
    });
    const tally = (pick: (v: (typeof variants)[number]) => string | null, labelOf: (v: (typeof variants)[number]) => string | null = pick) => {
      const m = new Map<string, { value: string; label: string; variants: number; inStock: number }>();
      for (const v of variants) {
        const value = pick(v);
        if (!value) continue;
        const e = m.get(value) ?? { value, label: labelOf(v) ?? value, variants: 0, inStock: 0 };
        e.variants++;
        e.inStock += v.inventory.reduce((a, l) => a + Math.max(0, l.onHand), 0);
        m.set(value, e);
      }
      return [...m.values()];
    };
    return {
      sizes: tally((v) => v.size).sort((a, b) => compareSizes(a.value, b.value)),
      grades: tally((v) => v.grade).sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0) || a.value.localeCompare(b.value)),
      gradingCompanies: tally((v) => v.gradingCompany),
      conditions: tally((v) => v.condition).sort((a, b) => CardConditions.indexOf(a.value as never) - CardConditions.indexOf(b.value as never)),
      itemConditions: tally((v) => v.itemCondition),
      /** value = brand id, label = name. */
      brands: tally((v) => v.product.brandId, (v) => v.product.brand).sort((a, b) => a.label.localeCompare(b.label)),
    };
  });

  // ── Product ↔ vendor links ─────────────────────────────────
  const ProductVendorBody = z.object({
    vendorSku: z.string().max(80).nullable().optional(),
    costCents: z.number().int().nonnegative().nullable().optional(),
    preferred: z.boolean().optional(),
    leadDays: z.number().int().min(0).max(365).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  });
  const productVendors = (productId: string) => prisma.productVendor.findMany({ where: { productId }, include: { vendor: true }, orderBy: [{ preferred: "desc" }, { createdAt: "asc" }] });

  app.get("/catalog/products/:id/vendors", staff, async (req) => productVendors((req.params as { id: string }).id));
  /** Add or update one vendor on a product. Marking it preferred un-prefers the others. */
  app.put("/catalog/products/:id/vendors/:vendorId", { preHandler: requirePermission("MANAGE_CATALOG") }, async (req) => {
    const { id, vendorId } = req.params as { id: string; vendorId: string };
    const body = parse(ProductVendorBody, req.body ?? {});
    const [product, vendor] = await Promise.all([prisma.product.findUnique({ where: { id } }), prisma.vendor.findUnique({ where: { id: vendorId } })]);
    if (!product) throw notFound("Product");
    if (!vendor) throw notFound("Vendor");
    await prisma.$transaction(async (tx) => {
      if (body.preferred) await tx.productVendor.updateMany({ where: { productId: id, vendorId: { not: vendorId } }, data: { preferred: false } });
      await tx.productVendor.upsert({
        where: { productId_vendorId: { productId: id, vendorId } },
        create: { productId: id, vendorId, ...body },
        update: body,
      });
    });
    await audit(prisma, { action: "PRODUCT_VENDOR_SET", staffId: req.user.sub, details: { productId: id, item: product.title, vendor: vendor.name, ...body } });
    return productVendors(id);
  });
  app.delete("/catalog/products/:id/vendors/:vendorId", { preHandler: requirePermission("MANAGE_CATALOG") }, async (req) => {
    const { id, vendorId } = req.params as { id: string; vendorId: string };
    const link = await prisma.productVendor.findUnique({ where: { productId_vendorId: { productId: id, vendorId } }, include: { vendor: true, product: true } });
    if (!link) throw notFound("Vendor link");
    await prisma.productVendor.delete({ where: { id: link.id } });
    await audit(prisma, { action: "PRODUCT_VENDOR_REMOVED", staffId: req.user.sub, details: { productId: id, item: link.product.title, vendor: link.vendor.name } });
    return productVendors(id);
  });

  app.post("/catalog/products", { preHandler: requirePermission("MANAGE_CATALOG") }, async (req) => {
    const input = parse(ProductInput.and(z.object({ brandId: z.string().optional(), vendors: z.array(ProductVendorBody.extend({ vendorId: z.string() })).max(20).optional() })), req.body);
    const { variants, vendors: vendorLinks, brandId, ...rest } = input;
    const product = { ...rest, ...(await brandData(prisma, { brand: rest.brand, ...(brandId ? { brandId } : {}) })) };
    const normalized = variants.map((v) => ({
      ...v,
      // A slab is one physical card identified by its cert; it isn't priced from the raw-card feed.
      ...(v.gradingCompany ? { serialized: true, autoPrice: false } : {}),
      // Sneakers and apparel are new unless said otherwise.
      ...((NEW_OR_USED_KINDS as readonly string[]).includes(product.kind) && !v.itemCondition ? { itemCondition: "DS" as const } : {}),
    }));
    for (const v of normalized) {
      if (v.gradingCompany && v.certNumber && (await prisma.variant.findFirst({ where: { gradingCompany: v.gradingCompany, certNumber: v.certNumber } }))) {
        throw conflict("CERT_EXISTS", `${v.gradingCompany} cert ${v.certNumber} is already in inventory`);
      }
    }
    if (vendorLinks?.length) {
      const known = await prisma.vendor.findMany({ where: { id: { in: vendorLinks.map((v) => v.vendorId) } }, select: { id: true } });
      if (known.length !== new Set(vendorLinks.map((v) => v.vendorId)).size) throw notFound("Vendor");
    }
    const created = await prisma.product.create({
      data: { ...product, variants: { create: normalized }, ...(vendorLinks?.length ? { vendors: { create: vendorLinks } } : {}) },
      include: { variants: true, vendors: { include: { vendor: true } } },
    });
    await audit(prisma, {
      action: "PRODUCT_CREATED",
      staffId: req.user.sub,
      details: { productId: created.id, title: created.title, kind: created.kind, brand: created.brand, variants: created.variants.length },
    });
    return created;
  });

  app.get("/catalog/products/:id", staff, async (req) => {
    const { id } = req.params as { id: string };
    const p = await prisma.product.findUnique({
      where: { id },
      include: {
        brandRef: true,
        vendors: { include: { vendor: true }, orderBy: [{ preferred: "desc" }, { createdAt: "asc" }] },
        variants: { include: { inventory: true, authentication: true, consignment: { where: { status: "ACTIVE" } } } },
      },
    });
    if (!p) throw notFound("Product");
    return p;
  });

  app.patch("/catalog/products/:id", { preHandler: requirePermission("MANAGE_CATALOG") }, async (req) => {
    const { id } = req.params as { id: string };
    const { brand, brandId, ...data } = parse(
      z.object({
        title: z.string().min(1).optional(),
        imageUrl: z.string().url().nullable().optional(),
        categoryId: z.string().nullable().optional(),
        channels: z.array(z.enum(["POS", "STOREFRONT", "SHOPIFY", "TCGPLAYER", "EBAY"])).optional(),
        /** Brand by name (created if new) or by id; null clears it. */
        brand: z.string().max(80).nullable().optional(),
        brandId: z.string().nullable().optional(),
        styleCode: z.string().max(60).nullable().optional(),
        description: z.string().max(5000).nullable().optional(),
      }),
      req.body,
    );
    const before = await prisma.product.findUnique({ where: { id } });
    if (!before) throw notFound("Product");
    const update = { ...data, ...(await brandData(prisma, { brand, brandId })) };
    const updated = await prisma.product.update({ where: { id }, data: update, include: { vendors: { include: { vendor: true } } } });
    await audit(prisma, { action: "PRODUCT_UPDATED", staffId: req.user.sub, details: { productId: id, title: updated.title, changes: changes(before, update) } });
    return updated;
  });

  app.patch("/catalog/variants/:id", { preHandler: requirePermission("MANAGE_CATALOG") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(
      z.object({
        priceCents: z.number().int().nonnegative().optional(),
        costCents: z.number().int().nonnegative().nullable().optional(),
        autoPrice: z.boolean().optional(),
        barcode: z.string().optional(),
        imageUrl: z.string().url().nullable().optional(),
      }),
      req.body,
    );
    const before = await prisma.variant.findUniqueOrThrow({ where: { id }, include: { product: true } });
    const updated = await prisma.variant.update({ where: { id }, data });
    if (data.priceCents !== undefined && data.priceCents !== before.priceCents) {
      await audit(prisma, {
        action: "PRICE_CHANGE",
        staffId: req.user.sub,
        details: { variantId: id, sku: before.sku, item: before.product.title, fromCents: before.priceCents, toCents: data.priceCents },
      });
    }
    // Everything but the price (which has its own event above).
    const { priceCents, ...rest } = data;
    const changed = changes(before, rest);
    if (Object.keys(changed).length) {
      await audit(prisma, { action: "VARIANT_UPDATED", staffId: req.user.sub, details: { variantId: id, sku: before.sku, item: before.product.title, changes: changed } });
    }
    return updated;
  });

  app.post("/inventory/adjust", { preHandler: requirePermission("INVENTORY_ADJUST") }, async (req) => {
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
    const trend = (await marketTrends(prisma, [v.id])).get(v.id) ?? null;
    return {
      trend,
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

  app.post("/pricing/reprice", { preHandler: requirePermission("MANAGE_CATALOG") }, async (req) => {
    const { productIds } = parse(z.object({ productIds: z.array(z.string()).optional() }), req.body ?? {});
    return repriceSingles(prisma, defaultProviders, undefined, { productIds, actorId: req.user.sub, trigger: "manual" });
  });
}
