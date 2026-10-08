import { Prisma, type ProductKind } from "@prisma/client";
import { applyBps, cartTotals, type CheckoutInput, type TenderType } from "@mypos/shared";
import type { Tx } from "../db.js";
import { AppError, badRequest, conflict, forbidden, notFound, paymentFailed } from "../errors.js";
import type { GatewayResult } from "../payments/gateway.js";
import { hasRole, type Ctx } from "./context.js";
import { moveInventory } from "./inventory.js";
import { postCredit } from "./storeCredit.js";

/** Products whose stock is not tracked as inventory. */
const UNTRACKED: ProductKind[] = ["EVENT_ENTRY"];

export interface CheckoutOptions {
  /** Restrict tenders (the storefront only accepts cards). */
  allowedTenders?: TenderType[];
  /** Fulfilling a preorder: its deposit counts toward the total. */
  preorder?: { id: string; depositCents: number };
}

const orderInclude = { lines: true, payments: true } satisfies Prisma.OrderInclude;
export type OrderWithDetails = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export interface CheckoutResult {
  order: OrderWithDetails;
  changeCents: number;
  /** True when this idempotency key was already processed. */
  replayed: boolean;
}

export async function checkout(ctx: Ctx, input: CheckoutInput, opts: CheckoutOptions = {}): Promise<CheckoutResult> {
  const { prisma, gateway, actor } = ctx;

  const existing = await prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: orderInclude });
  if (existing) return { order: existing, changeCents: sumChange(existing), replayed: true };

  // ── Validate cart ──────────────────────────────────────────
  const location = await prisma.location.findUnique({ where: { id: input.locationId } });
  if (!location) throw notFound("Location");

  const variantIds = [...new Set(input.lines.map((l) => l.variantId))];
  const variants = await prisma.variant.findMany({ where: { id: { in: variantIds } }, include: { product: true } });
  const byId = new Map(variants.map((v) => [v.id, v]));

  const priced = input.lines.map((line) => {
    const v = byId.get(line.variantId);
    if (!v) throw notFound(`Variant ${line.variantId}`);
    if (input.channel !== "POS" && !v.product.channels.includes(input.channel)) {
      throw badRequest("NOT_ON_CHANNEL", `${v.product.title} is not sold on ${input.channel}`);
    }
    if (line.unitPriceCents !== undefined && line.unitPriceCents !== v.priceCents && !hasRole(actor, "MANAGER")) {
      throw forbidden("Price overrides require a manager");
    }
    if (line.discountCents > 0 && !actor) throw forbidden("Discounts can only be applied at the register");
    if (v.product.kind === "EVENT_ENTRY") {
      if (!input.customerId) throw badRequest("CUSTOMER_REQUIRED", "Event entries need a customer");
      if (line.quantity !== 1) throw badRequest("ONE_ENTRY", "One event entry per customer");
    }
    if (v.serialized && line.quantity > 1) throw badRequest("SERIALIZED", `${v.sku} is a one-of-one item`);
    const unitPriceCents = line.unitPriceCents ?? v.priceCents;
    return {
      variant: v,
      quantity: line.quantity,
      unitPriceCents,
      discountCents: Math.min(line.discountCents, unitPriceCents * line.quantity),
      taxable: v.taxable,
    };
  });

  const totals = cartTotals(priced, location.taxRateBps);

  // ── Validate tenders ───────────────────────────────────────
  const deposit = opts.preorder?.depositCents ?? 0;
  const tendered = input.tenders.reduce((a, t) => a + t.amountCents, 0) + deposit;
  if (tendered !== totals.totalCents) {
    throw badRequest("TENDER_MISMATCH", "Tenders must equal the order total", { totalCents: totals.totalCents, tenderedCents: tendered });
  }
  let changeCents = 0;
  for (const t of input.tenders) {
    if (opts.allowedTenders && !opts.allowedTenders.includes(t.type)) throw badRequest("TENDER_NOT_ALLOWED", `${t.type} not accepted here`);
    if (t.type === "CARD" && !t.paymentToken && !t.terminalId) throw badRequest("CARD_SOURCE", "Card tender needs a token or terminal");
    if (t.type === "STORE_CREDIT" && !input.customerId) throw badRequest("CUSTOMER_REQUIRED", "Store credit needs a customer");
    if (t.type === "GIFT_CARD" && !t.giftCardCode) throw badRequest("GIFT_CARD_CODE", "Gift card code required");
    if (t.type === "EXTERNAL" && !actor) throw forbidden("External tenders are staff-only");
    if (t.type === "CASH") {
      if (!actor) throw forbidden("Cash is register-only");
      const handed = t.tenderedCents ?? t.amountCents;
      if (handed < t.amountCents) throw badRequest("CASH_SHORT", "Cash handed over is less than the cash amount");
      changeCents += handed - t.amountCents;
    }
  }

  // ── Open the order (claims the idempotency key) ────────────
  let order: { id: string; number: number; lineIds: string[] };
  try {
    order = await prisma.$transaction(async (tx) => {
      const o = await tx.order.create({
        data: {
          channel: input.channel,
          locationId: location.id,
          customerId: input.customerId,
          staffId: actor?.id,
          idempotencyKey: input.idempotencyKey,
          note: input.note,
          ...totals,
        },
      });
      // Created one at a time so line ids line up with `priced` by index.
      const lineIds: string[] = [];
      for (const p of priced) {
        const line = await tx.orderLine.create({
          data: {
            orderId: o.id,
            variantId: p.variant.id,
            title: describeVariant(p.variant.product.title, p.variant),
            quantity: p.quantity,
            unitPriceCents: p.unitPriceCents,
            discountCents: p.discountCents,
            taxable: p.taxable,
          },
        });
        lineIds.push(line.id);
      }
      return { id: o.id, number: o.number, lineIds };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const o = await prisma.order.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey }, include: orderInclude });
      return { order: o, changeCents: sumChange(o), replayed: true };
    }
    throw e;
  }

  // ── Charge cards (outside the DB transaction) ──────────────
  const approved: { tenderIndex: number; result: GatewayResult }[] = [];
  for (const [i, t] of input.tenders.entries()) {
    if (t.type !== "CARD") continue;
    let result: GatewayResult;
    try {
      result = await gateway.sale({
        amountCents: t.amountCents,
        currency: "USD",
        paymentToken: t.paymentToken,
        terminalId: t.terminalId,
        orderRef: String(order.number),
        idempotencyKey: `${input.idempotencyKey}:${i}`,
      });
    } catch (e) {
      result = { approved: false, message: e instanceof Error ? e.message : "Gateway error" };
    }
    if (!result.approved) {
      await rollbackCharges(ctx, order.id, approved.map((a) => a.result));
      throw paymentFailed(result.message ?? "Card declined", { orderId: order.id });
    }
    approved.push({ tenderIndex: i, result });
  }

  // ── Commit stock, credit, payouts, registrations ───────────
  try {
    await prisma.$transaction(async (tx) => {
      for (const [i, p] of priced.entries()) {
        const lineId = order.lineIds[i]!;
        if (!UNTRACKED.includes(p.variant.product.kind)) {
          await moveInventory(tx, {
            variantId: p.variant.id,
            locationId: location.id,
            delta: -p.quantity,
            reason: "SALE",
            orderId: order.id,
            staffId: actor?.id,
          });
          await attributeConsignment(tx, ctx, lineId, location.id, p);
        }
        if (p.variant.product.kind === "EVENT_ENTRY") {
          await registerForEvent(tx, p.variant.id, input.customerId!, lineId);
        }
      }

      for (const [i, t] of input.tenders.entries()) {
        const card = approved.find((a) => a.tenderIndex === i)?.result;
        if (t.type === "STORE_CREDIT") {
          await postCredit(tx, { customerId: input.customerId!, amountCents: -t.amountCents, reason: "Purchase", orderId: order.id });
        }
        if (t.type === "GIFT_CARD") {
          const debited = await tx.giftCard.updateMany({
            where: { code: t.giftCardCode!, balanceCents: { gte: t.amountCents } },
            data: { balanceCents: { decrement: t.amountCents } },
          });
          if (debited.count === 0) throw conflict("GIFT_CARD_BALANCE", "Gift card not found or balance too low");
        }
        await tx.payment.create({
          data: {
            orderId: order.id,
            amountCents: t.amountCents,
            tender: t.type,
            status: "APPROVED",
            gateway: card ? gateway.name : null,
            gatewayRef: card?.gatewayRef ?? t.giftCardCode ?? t.reference,
            cardBrand: card?.cardBrand,
            cardLast4: card?.cardLast4,
            changeCents: t.type === "CASH" ? (t.tenderedCents ?? t.amountCents) - t.amountCents : null,
          },
        });
      }

      if (opts.preorder) {
        await tx.payment.create({
          data: { orderId: order.id, amountCents: deposit, tender: "PREORDER_DEPOSIT", status: "APPROVED", gatewayRef: opts.preorder.id },
        });
        const claimed = await tx.preorder.updateMany({
          where: { id: opts.preorder.id, status: "RESERVED" },
          data: { status: "FULFILLED", fulfilledOrderId: order.id },
        });
        if (claimed.count === 0) throw conflict("PREORDER_STATE", "Preorder is no longer reserved");
      }

      await tx.order.update({ where: { id: order.id }, data: { status: "PAID" } });
    });
  } catch (e) {
    await rollbackCharges(ctx, order.id, approved.map((a) => a.result));
    throw e;
  }

  const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  return { order: final, changeCents, replayed: false };
}

/** Void any approved card charges and mark the order void. Best effort: a failed void is recorded for manual follow-up. */
async function rollbackCharges(ctx: Ctx, orderId: string, charges: GatewayResult[]): Promise<void> {
  for (const c of charges) {
    if (!c.gatewayRef) continue;
    let voided: GatewayResult;
    try {
      voided = await ctx.gateway.void(c.gatewayRef);
    } catch (e) {
      voided = { approved: false, message: e instanceof Error ? e.message : "void failed" };
    }
    await ctx.prisma.payment.create({
      data: {
        orderId,
        amountCents: 0,
        tender: "CARD",
        status: voided.approved ? "VOIDED" : "PENDING",
        gateway: ctx.gateway.name,
        gatewayRef: c.gatewayRef,
        cardLast4: c.cardLast4,
        raw: { action: "void", ok: voided.approved, message: voided.message ?? null } as Prisma.InputJsonValue,
      },
    });
  }
  await ctx.prisma.order.update({ where: { id: orderId }, data: { status: "VOID" } });
}

interface PricedLine {
  variant: { id: string };
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
}

/** Sell consigned units first-in-first-out and record what the store owes each consignor. */
async function attributeConsignment(tx: Tx, ctx: Ctx, orderLineId: string, locationId: string, p: PricedLine): Promise<void> {
  const items = await tx.consignmentItem.findMany({
    where: { variantId: p.variant.id, locationId, status: "ACTIVE" },
    include: { consignor: true },
    orderBy: { createdAt: "asc" },
  });
  if (items.length === 0) return;

  const netPerUnit = (p.unitPriceCents * p.quantity - p.discountCents) / p.quantity;
  let remaining = p.quantity;
  for (const item of items) {
    if (remaining === 0) break;
    const take = Math.min(remaining, item.quantity - item.soldQty);
    if (take <= 0) continue;
    if (item.floorCents !== null && netPerUnit < item.floorCents && !hasRole(ctx.actor, "MANAGER")) {
      throw conflict("BELOW_CONSIGNOR_FLOOR", "Price is below the consignor's floor; manager approval required");
    }
    const saleCents = Math.round(netPerUnit * take);
    const commissionCents = applyBps(saleCents, item.consignor.commissionBps);
    await tx.consignmentPayout.create({
      data: {
        consignorId: item.consignorId,
        consignmentItemId: item.id,
        orderLineId,
        saleCents,
        commissionCents,
        payoutCents: saleCents - commissionCents,
      },
    });
    const soldQty = item.soldQty + take;
    await tx.consignmentItem.update({
      where: { id: item.id },
      data: { soldQty, status: soldQty >= item.quantity ? "SOLD" : "ACTIVE" },
    });
    await tx.orderLine.update({ where: { id: orderLineId }, data: { consignmentItemId: item.id } });
    remaining -= take;
  }
}

async function registerForEvent(tx: Tx, variantId: string, customerId: string, orderLineId: string): Promise<void> {
  const event = await tx.event.findUnique({ where: { variantId } });
  if (!event) throw notFound("Event for entry");
  await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${event.id} FOR UPDATE`;
  const count = await tx.eventRegistration.count({ where: { eventId: event.id } });
  if (count >= event.capacity) throw conflict("EVENT_FULL", `${event.name} is full`);
  const dupe = await tx.eventRegistration.findUnique({ where: { eventId_customerId: { eventId: event.id, customerId } } });
  if (dupe) throw conflict("ALREADY_REGISTERED", "Customer is already registered");
  await tx.eventRegistration.create({ data: { eventId: event.id, customerId, orderLineId } });
}

function sumChange(order: OrderWithDetails): number {
  return order.payments.reduce((a, p) => a + (p.changeCents ?? 0), 0);
}

export function describeVariant(
  title: string,
  v: { condition: string | null; finish: string | null; size: string | null; itemCondition: string | null },
): string {
  const parts = [v.condition, v.finish && v.finish !== "NONFOIL" ? v.finish : null, v.size ? `Size ${v.size}` : null, v.itemCondition];
  const suffix = parts.filter(Boolean).join(" / ");
  return suffix ? `${title} (${suffix})` : title;
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
