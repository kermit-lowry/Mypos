import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../errors.js";
import { actorOf, parse, requirePermission, requireStaff } from "../http.js";
import type { Ctx } from "../services/context.js";
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
  lines: z.array(PoLine).max(1000).default([]),
});
const Received = z.object({ lines: z.array(z.object({ variantId: z.string(), quantity: z.number().int().nonnegative() })).min(1) });
const TransferBody = z.object({
  fromLocationId: z.string(),
  toLocationId: z.string(),
  notes: z.string().max(2000).optional(),
  lines: z.array(z.object({ variantId: z.string(), quantity: z.number().int().positive().max(100_000) })).max(1000).default([]),
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
  app.get("/vendors", staff, async () => prisma.vendor.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }));
  app.post("/vendors", purchasing, async (req, reply) => {
    const data = parse(z.object({ name: z.string().min(1).max(100), email: z.string().email().optional(), phone: z.string().max(40).optional(), notes: z.string().max(2000).optional() }), req.body);
    return reply.code(201).send(await prisma.vendor.create({ data }));
  });
  app.patch("/vendors/:id", purchasing, async (req) => {
    const data = parse(z.object({ name: z.string().min(1).max(100).optional(), email: z.string().email().nullable().optional(), phone: z.string().max(40).nullable().optional(), notes: z.string().max(2000).nullable().optional(), active: z.boolean().optional() }), req.body);
    return prisma.vendor.update({ where: { id: id(req) }, data });
  });

  // ── Purchase orders ────────────────────────────────────────
  app.get("/purchase-orders", staff, async (req) => {
    const q = parse(z.object({ status: z.enum(["DRAFT", "ORDERED", "PARTIAL", "RECEIVED", "CANCELLED"]).optional(), locationId: z.string().optional(), open: z.enum(["true"]).optional() }), req.query);
    return prisma.purchaseOrder.findMany({
      where: { status: q.open ? { in: ["DRAFT", "ORDERED", "PARTIAL"] } : q.status, locationId: q.locationId },
      orderBy: { number: "desc" },
      take: 200,
      include: { vendor: true, location: true, lines: true },
    });
  });
  app.get("/purchase-orders/reorder", purchasing, async (req) => {
    const { locationId } = parse(z.object({ locationId: z.string() }), req.query);
    return reorderSuggestions(prisma, locationId);
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
  app.post("/purchase-orders/:id/receive", receiving, async (req) => receivePurchaseOrder(ctx(req), id(req), parse(Received, req.body).lines));

  // ── Transfers ──────────────────────────────────────────────
  app.get("/transfers", staff, async (req) => {
    const q = parse(z.object({ status: z.enum(["DRAFT", "SENT", "RECEIVED", "CANCELLED"]).optional(), locationId: z.string().optional() }), req.query);
    return prisma.transfer.findMany({
      where: { status: q.status, ...(q.locationId ? { OR: [{ fromLocationId: q.locationId }, { toLocationId: q.locationId }] } : {}) },
      orderBy: { number: "desc" },
      take: 200,
      include: { fromLocation: true, toLocation: true, lines: true },
    });
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
  app.put("/inventory/:variantId/low-stock", purchasing, async (req) => {
    const { variantId } = req.params as { variantId: string };
    const { locationId, lowStockQty } = parse(z.object({ locationId: z.string(), lowStockQty: z.number().int().min(0).nullable() }), req.body);
    return prisma.inventoryLevel.upsert({
      where: { variantId_locationId: { variantId, locationId } },
      create: { variantId, locationId, onHand: 0, lowStockQty },
      update: { lowStockQty },
    });
  });
}
