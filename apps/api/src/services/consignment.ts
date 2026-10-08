import type { z } from "zod";
import type { AuthenticationInput, ConsignInput, ConsignorInput } from "@mypos/shared";
import { conflict, notFound } from "../errors.js";
import type { Ctx } from "./context.js";
import { moveInventory } from "./inventory.js";

export async function createConsignor(ctx: Ctx, input: z.infer<typeof ConsignorInput>) {
  return ctx.prisma.consignor.create({ data: input });
}

/** Take a consigned item into stock. The store holds it but does not own it. */
export async function consignItem(ctx: Ctx, input: z.infer<typeof ConsignInput>) {
  return ctx.prisma.$transaction(async (tx) => {
    const variant = await tx.variant.findUnique({ where: { id: input.variantId } });
    if (!variant) throw notFound("Variant");
    if (variant.serialized && input.quantity > 1) throw conflict("SERIALIZED", "One-of-one items take a quantity of 1");
    const item = await tx.consignmentItem.create({ data: input });
    await moveInventory(tx, {
      variantId: input.variantId,
      locationId: input.locationId,
      delta: input.quantity,
      reason: "CONSIGN_IN",
      note: `Consignment ${item.id}`,
      staffId: ctx.actor?.id,
    });
    return item;
  });
}

/** Give unsold units back to the consignor. */
export async function returnConsignment(ctx: Ctx, itemId: string) {
  return ctx.prisma.$transaction(async (tx) => {
    const item = await tx.consignmentItem.findUnique({ where: { id: itemId } });
    if (!item) throw notFound("Consignment item");
    if (item.status !== "ACTIVE") throw conflict("CONSIGNMENT_CLOSED", `Item is ${item.status}`);
    const unsold = item.quantity - item.soldQty;
    if (unsold > 0) {
      await moveInventory(tx, {
        variantId: item.variantId,
        locationId: item.locationId,
        delta: -unsold,
        reason: "CONSIGN_OUT",
        note: `Return consignment ${item.id}`,
        staffId: ctx.actor?.id,
      });
    }
    return tx.consignmentItem.update({ where: { id: item.id }, data: { status: "RETURNED", quantity: item.soldQty } });
  });
}

/** Net amount owed to a consignor (sales minus commission minus reversals). */
export async function consignorStatement(ctx: Ctx, consignorId: string) {
  const payouts = await ctx.prisma.consignmentPayout.findMany({ where: { consignorId }, orderBy: { createdAt: "asc" } });
  const owed = payouts.filter((p) => p.status === "OWED").reduce((a, p) => a + p.payoutCents, 0);
  return { owedCents: owed, payouts };
}

/** Mark all owed payouts paid (after the owner sends the money). */
export async function settleConsignor(ctx: Ctx, consignorId: string) {
  const { owedCents } = await consignorStatement(ctx, consignorId);
  await ctx.prisma.consignmentPayout.updateMany({ where: { consignorId, status: "OWED" }, data: { status: "PAID", paidAt: new Date() } });
  return { paidCents: owedCents };
}

export async function recordAuthentication(ctx: Ctx, input: z.infer<typeof AuthenticationInput>) {
  return ctx.prisma.authentication.create({ data: { ...input, staffId: ctx.actor?.id } });
}
