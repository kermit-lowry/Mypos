import { badRequest, conflict, notFound } from "../errors.js";
import type { Ctx } from "./context.js";
import { moveInventory } from "./inventory.js";
import { audit } from "./permissions.js";

export interface TransferInput {
  fromLocationId: string;
  toLocationId: string;
  reference?: string;
  notes?: string;
  expectedAt?: Date;
  lines: { variantId: string; quantity: number }[];
}

const include = { fromLocation: true, toLocation: true, lines: { include: { variant: { include: { product: true } } } } } as const;

export async function createTransfer(ctx: Ctx, input: TransferInput) {
  const { prisma, actor } = ctx;
  if (input.fromLocationId === input.toLocationId) throw badRequest("TRANSFER_SAME", "Pick two different locations");
  const by = new Map<string, number>();
  for (const l of input.lines) by.set(l.variantId, (by.get(l.variantId) ?? 0) + l.quantity);
  const t = await prisma.transfer.create({
    data: { ...input, createdById: actor?.id, lines: { create: [...by].map(([variantId, quantity]) => ({ variantId, quantity })) } },
    include,
  });
  await audit(prisma, { action: "TRANSFER_CREATED", staffId: actor?.id, locationId: t.fromLocationId, details: { transferId: t.id, number: t.number, to: t.toLocation.name, lines: by.size } });
  return t;
}

export async function updateTransfer(ctx: Ctx, id: string, input: Partial<TransferInput>) {
  const { prisma, actor } = ctx;
  const t = await prisma.transfer.findUnique({ where: { id } });
  if (!t) throw notFound("Transfer");
  if (t.status !== "DRAFT") throw conflict("TRANSFER_LOCKED", "Only drafts can be changed");
  const { lines, ...fields } = input;
  const updated = await prisma.transfer.update({
    where: { id },
    data: { ...fields, ...(lines ? { lines: { deleteMany: {}, create: lines } } : {}) },
    include,
  });
  await audit(prisma, { action: "TRANSFER_UPDATED", staffId: actor?.id, locationId: t.fromLocationId, details: { transferId: id, number: t.number } });
  return updated;
}

/** Take the stock out of the source. It's in transit until received. */
export async function sendTransfer(ctx: Ctx, id: string) {
  const { prisma, actor } = ctx;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Transfer" WHERE id = ${id} FOR UPDATE`;
    const t = await tx.transfer.findUnique({ where: { id }, include: { lines: true } });
    if (!t) throw notFound("Transfer");
    if (t.status !== "DRAFT") throw conflict("TRANSFER_STATE", `Transfer is already ${t.status.toLowerCase()}`);
    if (t.lines.length === 0) throw badRequest("TRANSFER_EMPTY", "Add items first");
    for (const l of t.lines) {
      await moveInventory(tx, { variantId: l.variantId, locationId: t.fromLocationId, delta: -l.quantity, reason: "TRANSFER", note: `Transfer #${t.number} out`, staffId: actor?.id });
    }
    const updated = await tx.transfer.update({ where: { id }, data: { status: "SENT", sentAt: new Date() }, include });
    await audit(tx, { action: "TRANSFER_SENT", staffId: actor?.id, locationId: t.fromLocationId, details: { transferId: id, number: t.number, units: t.lines.reduce((a, l) => a + l.quantity, 0) } });
    return updated;
  });
}

/**
 * Put the stock into the destination. Receiving fewer than sent records a
 * shortage in the activity log; those units stay out of stock.
 */
export async function receiveTransfer(ctx: Ctx, id: string, received?: { variantId: string; quantity: number }[]) {
  const { prisma, actor } = ctx;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Transfer" WHERE id = ${id} FOR UPDATE`;
    const t = await tx.transfer.findUnique({ where: { id }, include: { lines: true } });
    if (!t) throw notFound("Transfer");
    if (t.status !== "SENT") throw conflict("TRANSFER_STATE", `Can't receive a ${t.status.toLowerCase()} transfer`);
    const short: { variantId: string; sent: number; received: number }[] = [];
    for (const l of t.lines) {
      const qty = received ? (received.find((r) => r.variantId === l.variantId)?.quantity ?? 0) : l.quantity;
      if (qty < 0 || qty > l.quantity) throw badRequest("TRANSFER_QTY", `Received quantity must be between 0 and ${l.quantity}`);
      if (qty > 0) {
        await moveInventory(tx, { variantId: l.variantId, locationId: t.toLocationId, delta: qty, reason: "TRANSFER", note: `Transfer #${t.number} in`, staffId: actor?.id });
      }
      if (qty < l.quantity) short.push({ variantId: l.variantId, sent: l.quantity, received: qty });
      await tx.transferLine.update({ where: { id: l.id }, data: { receivedQty: qty } });
    }
    const updated = await tx.transfer.update({ where: { id }, data: { status: "RECEIVED", receivedAt: new Date() }, include });
    await audit(tx, { action: "TRANSFER_RECEIVED", staffId: actor?.id, locationId: t.toLocationId, details: { transferId: id, number: t.number, short } });
    if (short.length) await audit(tx, { action: "TRANSFER_SHORT", staffId: actor?.id, locationId: t.toLocationId, details: { transferId: id, number: t.number, short } });
    return updated;
  });
}

export async function cancelTransfer(ctx: Ctx, id: string) {
  const { prisma, actor } = ctx;
  const t = await prisma.transfer.findUnique({ where: { id } });
  if (!t) throw notFound("Transfer");
  if (t.status !== "DRAFT") throw conflict("TRANSFER_STATE", "Only drafts can be cancelled; receive a sent transfer instead");
  const updated = await prisma.transfer.update({ where: { id }, data: { status: "CANCELLED" }, include });
  await audit(prisma, { action: "TRANSFER_CANCELLED", staffId: actor?.id, locationId: t.fromLocationId, details: { transferId: id, number: t.number } });
  return updated;
}
