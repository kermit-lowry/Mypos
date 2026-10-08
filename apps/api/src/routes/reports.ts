import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { parse, requirePermission } from "../http.js";
import type { Ctx } from "../services/context.js";
import * as R from "../services/reports.js";

/** Reports and the back-office dashboard. Every report takes a date range and optional location; `format=csv` downloads. */
export function reportRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const reports = { preHandler: requirePermission("VIEW_REPORTS") };

  /** Item filters every stock and sales report takes: find anything by brand, category, vendor, or product type. */
  const ItemFilter = z.object({
    brandId: z.string().optional(),
    categoryId: z.string().optional(),
    vendorId: z.string().optional(),
    kind: z.string().optional(),
  });
  const StockQuery = ItemFilter.extend({ locationId: z.string().optional(), format: z.enum(["json", "csv"]).default("json") });
  const RangeQuery = StockQuery.extend({ from: z.coerce.date(), to: z.coerce.date() });
  async function range(q: z.infer<typeof RangeQuery>): Promise<R.Range & { timeZone: string }> {
    if (q.to <= q.from) throw badRequest("RANGE", "End must be after start");
    if (q.to.getTime() - q.from.getTime() > 400 * 86_400_000) throw badRequest("RANGE", "Pick a range of up to a year");
    const loc = q.locationId ? await prisma.location.findUnique({ where: { id: q.locationId } }) : await prisma.location.findFirst({ orderBy: { createdAt: "asc" } });
    return { from: q.from, to: q.to, locationId: q.locationId, brandId: q.brandId, categoryId: q.categoryId, vendorId: q.vendorId, kind: q.kind, timeZone: loc?.timezone ?? "America/New_York" };
  }
  const send = (reply: FastifyReply, format: "json" | "csv", name: string, rows: unknown) => {
    if (format !== "csv") return rows;
    const list = Array.isArray(rows) ? rows : [rows];
    return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}.csv"`).send(R.toCsv(list as Record<string, unknown>[]));
  };

  app.get("/dashboard", reports, async (req) => {
    const { locationId } = parse(z.object({ locationId: z.string().optional() }), req.query);
    const loc = locationId ? await prisma.location.findUnique({ where: { id: locationId } }) : await prisma.location.findFirst({ orderBy: { createdAt: "asc" } });
    return R.dashboard(prisma, locationId, loc?.timezone ?? "America/New_York");
  });

  app.get("/reports/summary", reports, async (req, reply) => {
    const q = parse(RangeQuery, req.query);
    return send(reply, q.format, "sales-summary", await R.salesSummary(prisma, await range(q)));
  });

  app.get("/reports/sales-by-period", reports, async (req, reply) => {
    const q = parse(RangeQuery.extend({ group: z.enum(["hour", "day", "week", "month"]).default("day") }), req.query);
    const r = await range(q);
    return send(reply, q.format, `sales-by-${q.group}`, await R.salesByPeriod(prisma, r, q.group, r.timeZone));
  });

  app.get("/reports/sales-by/:dim", reports, async (req, reply) => {
    const dim = parse(z.enum(["category", "kind", "employee", "product", "brand", "game", "vendor"]), (req.params as { dim: string }).dim);
    const q = parse(RangeQuery.extend({ limit: z.coerce.number().int().min(1).max(1000).default(100) }), req.query);
    return send(reply, q.format, `sales-by-${dim}`, await R.salesBy(prisma, await range(q), dim, q.limit));
  });

  app.get("/reports/tenders", reports, async (req, reply) => {
    const q = parse(RangeQuery, req.query);
    return send(reply, q.format, "tenders", await R.salesByTender(prisma, await range(q)));
  });

  app.get("/reports/discounts", reports, async (req, reply) => {
    const q = parse(RangeQuery, req.query);
    const r = await R.discountsReport(prisma, await range(q));
    return send(reply, q.format, "discounts", q.format === "csv" ? [...r.manual.map((m) => ({ type: "manual", name: m.reason, count: m.count, amountCents: m.amountCents })), ...r.deals.map((d) => ({ type: "deal", name: d.name, count: d.count, amountCents: d.amountCents }))] : r);
  });

  app.get("/reports/tax", reports, async (req, reply) => {
    const q = parse(RangeQuery, req.query);
    return send(reply, q.format, "tax", await R.taxReport(prisma, await range(q)));
  });

  app.get("/reports/trade-ins", reports, async (req, reply) => {
    const q = parse(RangeQuery, req.query);
    const r = await R.tradeInReport(prisma, await range(q));
    return send(reply, q.format, "trade-ins", q.format === "csv" ? r.byStaff : r);
  });

  app.get("/reports/no-sales", reports, async (req, reply) => {
    const q = parse(RangeQuery, req.query);
    return send(reply, q.format, "no-sales", await R.noSales(prisma, await range(q)));
  });

  app.get("/reports/purchases", reports, async (req, reply) => {
    const q = parse(RangeQuery.extend({ vendorId: z.string().optional() }), req.query);
    const r = await R.purchaseReport(prisma, await range(q), q.vendorId);
    return send(reply, q.format, "purchases", q.format === "csv" ? r.receipts : r);
  });

  app.get("/reports/transfers", reports, async (req, reply) => {
    const q = parse(RangeQuery, req.query);
    const r = await R.transferReport(prisma, await range(q));
    return send(reply, q.format, "transfers", q.format === "csv" ? r.rows : r);
  });

  app.get("/reports/inventory-valuation", reports, async (req, reply) => {
    const q = parse(StockQuery.extend({ by: z.enum(["category", "brand"]).default("category") }), req.query);
    const r = await R.inventoryValuation(prisma, q, q.by);
    return send(reply, q.format, "inventory-valuation", q.format === "csv" ? r.byCategory : r);
  });

  app.get("/reports/low-stock", reports, async (req, reply) => {
    const q = parse(StockQuery, req.query);
    return send(reply, q.format, "low-stock", await R.lowStock(prisma, q));
  });

  /** Inventory movements in a range: receipts, sales, counts, transfers, waste. */
  app.get("/reports/stock-movements", reports, async (req, reply) => {
    const q = parse(RangeQuery.extend({ reason: z.string().optional(), variantId: z.string().optional() }), req.query);
    const r = await range(q);
    const rows = await prisma.inventoryMovement.findMany({
      where: { createdAt: { gte: r.from, lt: r.to }, locationId: r.locationId, reason: q.reason as never, variantId: q.variantId, ...(q.brandId || q.categoryId || q.vendorId || q.kind ? { variant: { product: R.productWhere(q) } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 2000,
      include: { variant: { include: { product: true } }, staff: true },
    });
    return send(reply, q.format, "stock-movements", rows.map((m) => ({ at: m.createdAt, sku: m.variant.sku, title: m.variant.product.title, brand: m.variant.product.brand, delta: m.delta, reason: m.reason, note: m.note, staff: m.staff?.name ?? null })));
  });
}
