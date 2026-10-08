import type { MovementReason } from "@prisma/client";
import type { Tx } from "../db.js";
import { conflict } from "../errors.js";

export interface MoveInput {
  variantId: string;
  locationId: string;
  delta: number;
  reason: MovementReason;
  note?: string;
  orderId?: string;
  buylistId?: string;
  staffId?: string;
  /** Reject the move if it would take available stock below zero. */
  strict?: boolean;
}

/**
 * The only way inventory changes. Writes the level and an audit row in the
 * caller's transaction. Decrements use a conditional UPDATE so two registers
 * selling the last copy of a card can't both succeed.
 */
export async function moveInventory(tx: Tx, m: MoveInput): Promise<number> {
  if (m.delta < 0 && m.strict !== false) {
    const updated = await tx.inventoryLevel.updateMany({
      where: { variantId: m.variantId, locationId: m.locationId, onHand: { gte: -m.delta } },
      data: { onHand: { increment: m.delta } },
    });
    if (updated.count === 0) {
      const level = await tx.inventoryLevel.findUnique({
        where: { variantId_locationId: { variantId: m.variantId, locationId: m.locationId } },
      });
      throw conflict("INSUFFICIENT_STOCK", "Not enough stock", {
        variantId: m.variantId,
        onHand: level?.onHand ?? 0,
        requested: -m.delta,
      });
    }
  } else {
    await tx.inventoryLevel.upsert({
      where: { variantId_locationId: { variantId: m.variantId, locationId: m.locationId } },
      create: { variantId: m.variantId, locationId: m.locationId, onHand: m.delta },
      update: { onHand: { increment: m.delta } },
    });
  }

  await tx.inventoryMovement.create({
    data: {
      variantId: m.variantId,
      locationId: m.locationId,
      delta: m.delta,
      reason: m.reason,
      note: m.note,
      orderId: m.orderId,
      buylistId: m.buylistId,
      staffId: m.staffId,
    },
  });

  const level = await tx.inventoryLevel.findUniqueOrThrow({
    where: { variantId_locationId: { variantId: m.variantId, locationId: m.locationId } },
  });
  return level.onHand;
}

/** Weighted-average cost after receiving `qty` units at `unitCostCents`. */
export async function receiveCost(tx: Tx, variantId: string, qty: number, unitCostCents: number): Promise<void> {
  const v = await tx.variant.findUniqueOrThrow({ where: { id: variantId }, include: { inventory: true } });
  const onHand = v.inventory.reduce((a, l) => a + Math.max(0, l.onHand), 0);
  const prevCost = v.costCents ?? unitCostCents;
  const newCost = onHand + qty > 0 ? Math.round((prevCost * onHand + unitCostCents * qty) / (onHand + qty)) : unitCostCents;
  await tx.variant.update({ where: { id: variantId }, data: { costCents: newCost } });
}
