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
  lines: PoLineInput[];
}

const include = { vendor: true, location: true, lines: { include: { variant: { include: { product: true } } } } } as const;

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
  if (po.status !== "DRAFT" && (lines || fields.vendorId || fields.locationId)) throw conflict("PO_LOCKED", `A ${po.status.toLowerCase()} order only takes notes and dates`);
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
  await audit(prisma, { action: `PO_${status}`, staffId: actor?.id, locationId: po.locationId, details: { poId: id, number: po.number } });
  return updated;
}

/**
 * Receive some or all of an order into stock at the PO's location. Each
 * received unit is costed at the PO's unit cost (weighted into the variant).
 */
export async function receivePurchaseOrder(ctx: Ctx, id: string, received: { variantId: string; quantity: number }[]) {
  const { prisma, actor } = ctx;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} FOR UPDATE`;
    const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
    if (!po) throw notFound("Purchase order");
    if (po.status !== "ORDERED" && po.status !== "PARTIAL") throw conflict("PO_STATE", `Can't receive a ${po.status.toLowerCase()} order`);
    const items: { variantId: string; quantity: number }[] = [];
    for (const r of received) {
      if (r.quantity <= 0) continue;
      const line = po.lines.find((l) => l.variantId === r.variantId);
      if (!line) throw badRequest("PO_LINE", "That item isn't on this order");
      const left = line.quantity - line.receivedQty;
      if (r.quantity > left) throw badRequest("PO_OVER", `Only ${left} left to receive on that item`);
      await receiveCost(tx, line.variantId, r.quantity, line.unitCostCents);
      await moveInventory(tx, { variantId: line.variantId, locationId: po.locationId, delta: r.quantity, reason: "RECEIVE", note: `PO #${po.number}`, staffId: actor?.id });
      await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { receivedQty: { increment: r.quantity } } });
      items.push(r);
    }
    if (items.length === 0) throw badRequest("PO_NOTHING", "Nothing to receive");
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

/** Items at or below their low-stock level, with a suggested order quantity. */
export async function reorderSuggestions(db: Db, locationId: string) {
  const levels = await db.inventoryLevel.findMany({
    where: { locationId, lowStockQty: { not: null } },
    include: { variant: { include: { product: true } } },
  });
  return levels
    .filter((l) => l.onHand <= (l.lowStockQty ?? 0))
    .map((l) => ({
      variantId: l.variantId,
      sku: l.variant.sku,
      title: l.variant.product.title,
      onHand: l.onHand,
      lowStockQty: l.lowStockQty!,
      // Bring it back to double the trigger level.
      suggestedQty: Math.max(1, (l.lowStockQty ?? 0) * 2 - l.onHand),
      lastCostCents: l.variant.costCents,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
