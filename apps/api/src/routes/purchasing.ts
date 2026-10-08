import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../errors.js";
import { actorOf, parse, requirePermission, requireStaff } from "../http.js";
import type { Ctx } from "../services/context.js";
import { purchaseOrderHtml, transferHtml } from "../services/documents.js";
import { labelData, labelsHtml, labelsZpl } from "../services/labels.js";
import { audit } from "../services/permissions.js";
import { createPurchaseOrder, receivePurchaseOrder, reorderSuggestions, setPurchaseOrderStatus, updatePurchaseOrder } from "../services/purchasing.js";
import { cancelTransfer, createTransfer, receiveTransfer, sendTransfer, updateTransfer } from "../services/transfers.js";

const PoLine = z.object({ variantId: z.string(), quantity: z.number().int().positive().max(100_000), unitCostCents: z.number().int().nonnegative() });
const PoBody = z.object({
  vendorId: z.string(),
  locationId: z.string(),
  reference: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  expectedAt: z.coerce.date().optional(),
  shippingCents: z.number().int().nonnegative().optional(),
  lines: z.array(PoLine).max(1000).default([]),
});
const Received = z.object({
  reference: z.string().max(100).optional(),
  lines: z.array(z.object({ variantId: z.string(), quantity: z.number().int().nonnegative(), unitCostCents: z.number().int().nonnegative().optional() })).min(1),
});
const TransferBody = z.object({
  fromLocationId: z.string(),
  toLocationId: z.string(),
  reference: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  expectedAt: z.coerce.date().optional(),
  lines: z.array(z.object({ variantId: z.string(), quantity: z.number().int().positive().max(100_000) })).max(1000).default([]),
});
const VendorBody = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  accountNumber: z.string().max(60).nullable().optional(),
  contactName: z.string().max(100).nullable().optional(),
  website: z.string().max(200).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  defaultCategoryId: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

/** Back office: locations, vendors, purchase orders, transfers. */
export function purchasingRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireStaff() };
  const purchasing = { preHandler: requirePermission("MANAGE_PURCHASING") };
  const receiving = { preHandler: requirePermission("RECEIVE_STOCK") };
  const transfers = { preHandler: requirePermission("MANAGE_TRANSFERS") };
  const ctx = (req: Parameters<typeof actorOf>[0]): Ctx => ({ ...base, actor: actorOf(req), perms: req.perms });
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  // ── Locations ──────────────────────────────────────────────
  app.get("/locations/all", { preHandler: requirePermission("MANAGE_SETTINGS") }, async () => prisma.location.findMany({ orderBy: { name: "asc" } }));
  app.post("/locations", { preHandler: requirePermission("MANAGE_SETTINGS") }, async (req, reply) => {
    const data = parse(z.object({ name: z.string().min(1).max(80), taxRateBps: z.number().int().min(0).max(3000).default(0), timezone: z.string().default("America/New_York"), address: z.string().max(200).optional(), phone: z.string().max(40).optional() }), req.body);
    const loc = await prisma.location.create({ data });
    await audit(prisma, { action: "LOCATION_CREATED", staffId: req.user.sub, locationId: loc.id, details: { name: loc.name } });
    return reply.code(201).send(loc);
  });

  // ── Vendors ────────────────────────────────────────────────
  app.get("/vendors", staff, async () => {
    const vendors = await prisma.vendor.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }], include: { _count: { select: { products: true, purchaseOrders: true } } } });
    return vendors.map(({ _count, ...v }) => ({ ...v, products: _count.products, purchaseOrders: _count.purchaseOrders }));
  });
  app.get("/vendors/:id", staff, async (req) => {
    const v = await prisma.vendor.findUnique({ where: { id: id(req) }, include: { _count: { select: { products: true, purchaseOrders: true } } } });
    if (!v) throw notFound("Vendor");
    const { _count, ...vendor } = v;
    return { ...vendor, products: _count.products, purchaseOrders: _count.purchaseOrders };
  });
  /** Everything this vendor supplies, with their item numbers and prices. */
  app.get("/vendors/:id/products", staff, async (req) => {
    const { q } = parse(z.object({ q: z.string().optional() }), req.query);
    const links = await prisma.productVendor.findMany({
      where: { vendorId: id(req), ...(q ? { OR: [{ vendorSku: { contains: q, mode: "insensitive" } }, { product: { title: { contains: q, mode: "insensitive" } } }] } : {}) },
      include: { product: { include: { variants: { include: { inventory: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } } },
      orderBy: { product: { title: "asc" } },
      take: 500,
    });
    return links.map((l) => ({ vendorSku: l.vendorSku, costCents: l.costCents, preferred: l.preferred, leadDays: l.leadDays, notes: l.notes, product: l.product }));
  });
  app.post("/vendors", purchasing, async (req, reply) => {
    const v = await prisma.vendor.create({ data: parse(VendorBody, req.body) });
    await audit(prisma, { action: "VENDOR_CREATED", staffId: req.user.sub, details: { vendorId: v.id, name: v.name } });
    return reply.code(201).send(v);
  });
  app.patch("/vendors/:id", purchasing, async (req) => {
    const data = parse(VendorBody.partial(), req.body);
    const v = await prisma.vendor.update({ where: { id: id(req) }, data });
    await audit(prisma, { action: "VENDOR_UPDATED", staffId: req.user.sub, details: { vendorId: v.id, name: v.name, fields: Object.keys(data) } });
    return v;
  });

  // ── Purchase orders ────────────────────────────────────────
  app.get("/purchase-orders", staff, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(["DRAFT", "ORDERED", "PARTIAL", "RECEIVED", "CANCELLED"]).optional(),
        locationId: z.string().optional(),
        vendorId: z.string().optional(),
        /** Search by PO number or reference. */
        q: z.string().optional(),
        open: z.enum(["true"]).optional(),
      }),
      req.query,
    );
    const n = q.q && /^#?\d+$/.test(q.q) ? Number(q.q.replace("#", "")) : undefined;
    return prisma.purchaseOrder.findMany({
      where: {
        status: q.open ? { in: ["DRAFT", "ORDERED", "PARTIAL"] } : q.status,
        locationId: q.locationId,
        vendorId: q.vendorId,
        ...(q.q ? { OR: [{ reference: { contains: q.q, mode: "insensitive" } }, ...(n !== undefined ? [{ number: n }] : []), { vendor: { name: { contains: q.q, mode: "insensitive" } } }] } : {}),
      },
      orderBy: { number: "desc" },
      take: 200,
      include: { vendor: true, location: true, lines: true, receipts: { select: { id: true, receivedAt: true } } },
    });
  });
  app.get("/purchase-orders/:id/print", staff, async (req, reply) => reply.type("text/html; charset=utf-8").send(await purchaseOrderHtml(prisma, id(req))));
  app.get("/purchase-orders/reorder", purchasing, async (req) => {
    const { locationId, vendorId } = parse(z.object({ locationId: z.string(), vendorId: z.string().optional() }), req.query);
    return reorderSuggestions(prisma, locationId, vendorId);
  });
  app.get("/purchase-orders/:id", staff, async (req) => {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: id(req) }, include: { vendor: true, location: true, lines: { include: { variant: { include: { product: true } } } } } });
    if (!po) throw notFound("Purchase order");
    return po;
  });
  app.post("/purchase-orders", purchasing, async (req, reply) => reply.code(201).send(await createPurchaseOrder(ctx(req), parse(PoBody, req.body))));
  app.put("/purchase-orders/:id", purchasing, async (req) => updatePurchaseOrder(ctx(req), id(req), parse(PoBody.partial(), req.body)));
  app.post("/purchase-orders/:id/order", purchasing, async (req) => setPurchaseOrderStatus(ctx(req), id(req), "ORDERED"));
  app.post("/purchase-orders/:id/cancel", purchasing, async (req) => setPurchaseOrderStatus(ctx(req), id(req), "CANCELLED"));
  app.post("/purchase-orders/:id/receive", receiving, async (req) => {
    const body = parse(Received, req.body);
    return receivePurchaseOrder(ctx(req), id(req), body.lines, body.reference);
  });

  // ── Transfers ──────────────────────────────────────────────
  app.get("/transfers", staff, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(["DRAFT", "SENT", "RECEIVED", "CANCELLED"]).optional(),
        locationId: z.string().optional(),
        fromLocationId: z.string().optional(),
        toLocationId: z.string().optional(),
        q: z.string().optional(),
      }),
      req.query,
    );
    const n = q.q && /^#?\d+$/.test(q.q) ? Number(q.q.replace("#", "")) : undefined;
    return prisma.transfer.findMany({
      where: {
        status: q.status,
        fromLocationId: q.fromLocationId,
        toLocationId: q.toLocationId,
        ...(q.locationId ? { OR: [{ fromLocationId: q.locationId }, { toLocationId: q.locationId }] } : {}),
        ...(q.q ? { OR: [{ reference: { contains: q.q, mode: "insensitive" } }, ...(n !== undefined ? [{ number: n }] : [])] } : {}),
      },
      orderBy: { number: "desc" },
      take: 200,
      include: { fromLocation: true, toLocation: true, lines: { include: { variant: { select: { priceCents: true, costCents: true } } } } },
    });
  });
  app.get("/transfers/:id/print", staff, async (req, reply) => reply.type("text/html; charset=utf-8").send(await transferHtml(prisma, id(req))));
  /** Shelf labels for everything on a transfer, priced for the destination. */
  app.get("/transfers/:id/labels", staff, async (req, reply) => {
    const t = await prisma.transfer.findUnique({ where: { id: id(req) }, include: { lines: true } });
    if (!t) throw notFound("Transfer");
    const labels = await labelData(prisma, t.toLocationId, t.lines.map((l) => ({ variantId: l.variantId, copies: Math.max(1, l.receivedQty || l.quantity) })));
    const { format } = parse(z.object({ format: z.enum(["html", "zpl"]).default("html") }), req.query);
    return format === "zpl" ? reply.type("text/plain; charset=utf-8").send(labelsZpl(labels)) : reply.type("text/html; charset=utf-8").send(labelsHtml(labels));
  });
  app.get("/transfers/:id", staff, async (req) => {
    const t = await prisma.transfer.findUnique({ where: { id: id(req) }, include: { fromLocation: true, toLocation: true, lines: { include: { variant: { include: { product: true } } } } } });
    if (!t) throw notFound("Transfer");
    return t;
  });
  app.post("/transfers", transfers, async (req, reply) => reply.code(201).send(await createTransfer(ctx(req), parse(TransferBody, req.body))));
  app.put("/transfers/:id", transfers, async (req) => updateTransfer(ctx(req), id(req), parse(TransferBody.partial(), req.body)));
  app.post("/transfers/:id/send", transfers, async (req) => sendTransfer(ctx(req), id(req)));
  app.post("/transfers/:id/cancel", transfers, async (req) => cancelTransfer(ctx(req), id(req)));
  app.post("/transfers/:id/receive", receiving, async (req) => {
    const body = parse(z.object({ lines: z.array(z.object({ variantId: z.string(), quantity: z.number().int().nonnegative() })).optional() }), req.body ?? {});
    return receiveTransfer(ctx(req), id(req), body.lines);
  });

  /** Low-stock trigger per item and location (drives reorder suggestions and the low-stock report). */
  app.put("/inventory/:variantId/low-stock", { preHandler: requirePermission("INVENTORY_ADJUST") }, async (req) => {
    const { variantId } = req.params as { variantId: string };
    const { locationId, lowStockQty } = parse(z.object({ locationId: z.string(), lowStockQty: z.number().int().min(0).nullable() }), req.body);
    return prisma.inventoryLevel.upsert({
      where: { variantId_locationId: { variantId, locationId } },
      create: { variantId, locationId, onHand: 0, lowStockQty },
      update: { lowStockQty },
    });
  });
}
