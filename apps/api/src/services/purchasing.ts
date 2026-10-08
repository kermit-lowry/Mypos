import type { PurchaseOrderStatus } from "@prisma/client";
import type { Db } from "../db.js";
import { badRequest, conflict, notFound } from "../errors.js";
import type { Ctx } from "./context.js";
import { moveInventory, receiveCost } from "./inventory.js";
import { audit } from "./permissions.js";

export interface PoLineInput {
  variantId: string;
  quantity: number;
  unitCostCents: number;
}

export interface PoInput {
  vendorId: string;
  locationId: string;
  reference?: string;
  notes?: string;
  expectedAt?: Date;
  shippingCents?: number;
  lines: PoLineInput[];
}

const include = {
  vendor: true,
  location: true,
  lines: { include: { variant: { include: { product: true } } } },
  receipts: { include: { lines: true }, orderBy: { receivedAt: "desc" as const } },
} as const;

function mergeLines(lines: PoLineInput[]): PoLineInput[] {
  const by = new Map<string, PoLineInput>();
  for (const l of lines) {
    const e = by.get(l.variantId);
    by.set(l.variantId, e ? { ...e, quantity: e.quantity + l.quantity } : { ...l });
  }
  return [...by.values()];
}

export async function createPurchaseOrder(ctx: Ctx, input: PoInput) {
  const { prisma, actor } = ctx;
  if (!(await prisma.vendor.findUnique({ where: { id: input.vendorId } }))) throw notFound("Vendor");
  const lines = mergeLines(input.lines);
  const po = await prisma.purchaseOrder.create({
    data: { ...input, createdById: actor?.id, lines: { create: lines } },
    include,
  });
  await audit(prisma, { action: "PO_CREATED", staffId: actor?.id, locationId: po.locationId, details: { poId: po.id, number: po.number, vendor: po.vendor.name, lines: lines.length } });
  return po;
}

/** Drafts can change freely; an ordered PO only takes notes/expected date changes. */
export async function updatePurchaseOrder(ctx: Ctx, id: string, input: Partial<PoInput>) {
  const { prisma, actor } = ctx;
  const po = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw notFound("Purchase order");
  const { lines, ...fields } = input;
  if (po.status !== "DRAFT" && (lines || fields.vendorId || fields.locationId)) throw conflict("PO_LOCKED", `A ${po.status.toLowerCase()} order only takes notes, dates, and shipping`);
  const updated = await prisma.purchaseOrder.update({
    where: { id },
    data: { ...fields, ...(lines ? { lines: { deleteMany: {}, create: mergeLines(lines) } } : {}) },
    include,
  });
  await audit(prisma, { action: "PO_UPDATED", staffId: actor?.id, locationId: po.locationId, details: { poId: id, number: po.number, fields: Object.keys(input) } });
  return updated;
}

export async function setPurchaseOrderStatus(ctx: Ctx, id: string, status: Extract<PurchaseOrderStatus, "ORDERED" | "CANCELLED">) {
  const { prisma, actor } = ctx;
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
  if (!po) throw notFound("Purchase order");
  if (status === "ORDERED" && po.status !== "DRAFT") throw conflict("PO_STATE", `Order is already ${po.status.toLowerCase()}`);
  if (status === "ORDERED" && po.lines.length === 0) throw badRequest("PO_EMPTY", "Add items before ordering");
  if (status === "CANCELLED" && po.lines.some((l) => l.receivedQty > 0)) throw conflict("PO_RECEIVED", "Some items were received; close it instead");
  const updated = await prisma.purchaseOrder.update({ where: { id }, data: { status, ...(status === "ORDERED" ? { orderedAt: new Date() } : {}) }, include });
  if (status === "ORDERED") await linkVendor(prisma, po.vendorId, po.lines.map((l) => ({ variantId: l.variantId, unitCostCents: l.unitCostCents })), false);
  await audit(prisma, { action: `PO_${status}`, staffId: actor?.id, locationId: po.locationId, details: { poId: id, number: po.number } });
  return updated;
}

/**
 * Ordering from a vendor makes them one of the product's vendors; receiving
 * records what they actually charged. A product's first vendor is preferred.
 */
export async function linkVendor(db: Db, vendorId: string, items: { variantId: string; unitCostCents: number }[], updateCost: boolean) {
  const variants = await db.variant.findMany({ where: { id: { in: items.map((i) => i.variantId) } }, select: { id: true, productId: true } });
  const productOf = new Map(variants.map((v) => [v.id, v.productId]));
  const costByProduct = new Map<string, number>();
  for (const i of items) {
    const productId = productOf.get(i.variantId);
    if (productId) costByProduct.set(productId, i.unitCostCents);
  }
  for (const [productId, costCents] of costByProduct) {
    const existing = await db.productVendor.findUnique({ where: { productId_vendorId: { productId, vendorId } } });
    if (!existing) {
      const others = await db.productVendor.count({ where: { productId } });
      await db.productVendor.create({ data: { productId, vendorId, costCents, preferred: others === 0 } });
    } else if (updateCost || existing.costCents == null) {
      await db.productVendor.update({ where: { id: existing.id }, data: { costCents } });
    }
  }
}

/**
 * Receive a delivery against an order into stock at the PO's location. Each
 * delivery is kept as a receipt. Units are costed at the PO's unit cost unless
 * the delivery says otherwise (the invoice price), weighted into the variant.
 */
export async function receivePurchaseOrder(
  ctx: Ctx,
  id: string,
  received: { variantId: string; quantity: number; unitCostCents?: number }[],
  reference?: string,
) {
  const { prisma, actor } = ctx;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} FOR UPDATE`;
    const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!po) throw notFound("Purchase order");
    if (po.status !== "ORDERED" && po.status !== "PARTIAL") throw conflict("PO_STATE", `Can't receive a ${po.status.toLowerCase()} order`);
    const items: { variantId: string; quantity: number; unitCostCents: number }[] = [];
    for (const r of received) {
      if (r.quantity <= 0) continue;
      const line = po.lines.find((l) => l.variantId === r.variantId);
      if (!line) throw badRequest("PO_LINE", "That item isn't on this order");
      const left = line.quantity - line.receivedQty;
      if (r.quantity > left) throw badRequest("PO_OVER", `Only ${left} left to receive on that item`);
      const unitCostCents = r.unitCostCents ?? line.unitCostCents;
      await receiveCost(tx, line.variantId, r.quantity, unitCostCents);
      await moveInventory(tx, { variantId: line.variantId, locationId: po.locationId, delta: r.quantity, reason: "RECEIVE", note: `PO #${po.number}`, staffId: actor?.id });
      await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { receivedQty: { increment: r.quantity } } });
      items.push({ variantId: r.variantId, quantity: r.quantity, unitCostCents });
    }
    if (items.length === 0) throw badRequest("PO_NOTHING", "Nothing to receive");
    await tx.purchaseReceipt.create({ data: { purchaseOrderId: id, reference, staffId: actor?.id, lines: { create: items } } });
    await linkVendor(tx, po.vendorId, items, true);
    const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: id } });
    const complete = lines.every((l) => l.receivedQty >= l.quantity);
    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: { status: complete ? "RECEIVED" : "PARTIAL", ...(complete ? { receivedAt: new Date() } : {}) },
      include,
    });
    await audit(tx, { action: "PO_RECEIVED", staffId: actor?.id, locationId: po.locationId, details: { poId: id, number: po.number, items, complete } });
    return updated;
  });
}

/**
 * Items at or below their low-stock level, with a suggested order quantity
 * and who supplies them. With `vendorId`, only that vendor's items (plus
 * items with no vendor yet), costed at that vendor's price when known.
 */
export async function reorderSuggestions(db: Db, locationId: string, vendorId?: string) {
  const levels = await db.inventoryLevel.findMany({
    where: { locationId, lowStockQty: { not: null }, ...(vendorId ? { variant: { product: { OR: [{ vendors: { some: { vendorId } } }, { vendors: { none: {} } }] } } } : {}) },
    include: { variant: { include: { product: { include: { vendors: { include: { vendor: true }, orderBy: [{ preferred: "desc" }, { createdAt: "asc" }] } } } } } },
  });
  return levels
    .filter((l) => l.onHand <= (l.lowStockQty ?? 0))
    .map((l) => {
      const vendors = l.variant.product.vendors.map((v) => ({ vendorId: v.vendorId, name: v.vendor.name, vendorSku: v.vendorSku, costCents: v.costCents, preferred: v.preferred }));
      const chosen = (vendorId && vendors.find((v) => v.vendorId === vendorId)) || vendors[0] || null;
      return {
        variantId: l.variantId,
        sku: l.variant.sku,
        title: l.variant.product.title,
        onHand: l.onHand,
        lowStockQty: l.lowStockQty!,
        // Bring it back to double the trigger level.
        suggestedQty: Math.max(1, (l.lowStockQty ?? 0) * 2 - l.onHand),
        lastCostCents: chosen?.costCents ?? l.variant.costCents,
        vendors,
        vendorId: chosen?.vendorId ?? null,
        vendor: chosen?.name ?? null,
      };
    })
    .sort((a, b) => (a.vendor ?? "").localeCompare(b.vendor ?? "") || a.title.localeCompare(b.title));
}
