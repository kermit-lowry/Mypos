import { Prisma, type ProductKind } from "@prisma/client";
import { gradeLabel, isNewItem, ITEM_CONDITION_LABELS, type ItemCondition } from "@mypos/shared";
import { applyBps, cardAdjustment, cardAmountDue, discountBps, dualTotals, earnFor, isCardPriced, type CheckoutInput, type Permission, type TenderType } from "@mypos/shared";
import type { Tx } from "../db.js";
import { AppError, badRequest, conflict, forbidden, notFound, paymentFailed } from "../errors.js";
import { config } from "../config.js";
import type { GatewayResult } from "../payments/gateway.js";
import { recordUnknownCharge, resolveTerminal, voidCharges, type Charge, type ResolvedTerminal } from "./charges.js";
import type { Ctx } from "./context.js";
import { approvalRequired, audit, consumeApproval, findApproval, permissionDenied } from "./permissions.js";
import { moveInventory } from "./inventory.js";
import { earns, getProgram, loyaltyBalances, postLoyalty, priceRewards, unitFor } from "./loyalty.js";
import { applyDeals } from "./promotions.js";
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
    if (!actor && (line.discountCents > 0 || (line.unitPriceCents !== undefined && line.unitPriceCents !== v.priceCents))) {
      throw forbidden("Discounts and price changes can only be made at the register");
    }
    if (v.product.kind === "EVENT_ENTRY") {
      if (!input.customerId) throw badRequest("CUSTOMER_REQUIRED", "Event entries need a customer");
      if (line.quantity !== 1) throw badRequest("ONE_ENTRY", "One event entry per customer");
    }
    if (v.serialized && line.quantity > 1) throw badRequest("SERIALIZED", `${v.sku} is a one-of-one item`);
    const unitPriceCents = line.unitPriceCents ?? v.priceCents;
    return {
      variant: v,
      listPriceCents: v.priceCents,
      discountReasonId: line.discountReasonId,
      discountPresetId: line.discountPresetId,
      discountNote: line.discountNote?.trim() || undefined,
      quantity: line.quantity,
      unitPriceCents,
      discountCents: Math.min(line.discountCents, unitPriceCents * line.quantity),
      promoDiscountCents: 0,
      taxable: v.taxable,
    };
  });

  // ── Manual discounts need a reason when the store has reasons set up ──
  const reasons = await prisma.discountReason.findMany({ where: { active: true } });
  const reasonFor = new Map<number, { id: string; name: string }>();
  for (const [i, p] of priced.entries()) {
    if (p.discountCents <= 0) continue;
    if (reasons.length === 0) continue;
    const reason = reasons.find((r) => r.id === p.discountReasonId);
    if (!reason) throw badRequest("DISCOUNT_REASON", `Pick a reason for the discount on ${p.variant.product.title}`);
    if (reason.requiresNote && !p.discountNote) throw badRequest("DISCOUNT_NOTE", `"${reason.name}" needs a note`);
    reasonFor.set(i, reason);
  }

  // A discount is "custom" unless it came from an active discount button and
  // takes no more off the line than that button would.
  const presets = await prisma.discountPreset.findMany({ where: { active: true } });
  const customDiscount = priced.some((p) => {
    if (p.discountCents <= 0) return false;
    const preset = presets.find((x) => x.id === p.discountPresetId);
    if (!preset) return true;
    const gross = p.unitPriceCents * p.quantity;
    const most = preset.kind === "PERCENT" ? Math.ceil((gross * preset.value) / 10_000) : preset.value;
    return p.discountCents > most;
  });

  // ── Employee permissions: price changes and manual discounts ──
  const approval = await registerApprovals(ctx, {
    customDiscount,
    storeCreditTender: input.tenders.some((t) => t.type === "STORE_CREDIT"),
    priceOverride: input.lines.some((l) => l.unitPriceCents !== undefined && l.unitPriceCents !== byId.get(l.variantId)!.priceCents),
    maxDiscountBps: Math.max(0, ...priced.map((p) => discountBps(p.discountCents, p.unitPriceCents * p.quantity))),
  });

  // ── Automated deals: run first; a manual discount can only take off what's left ──
  const deals = await applyDeals(prisma, location, input.channel, priced);
  priced.forEach((p, i) => {
    const gross = p.unitPriceCents * p.quantity;
    p.promoDiscountCents = Math.min(gross, deals.lineDiscounts[i]!);
    p.discountCents = p.promoDiscountCents + Math.min(p.discountCents, gross - p.promoDiscountCents);
  });

  // ── Loyalty rewards (become line discounts, so tax is on the discounted price) ──
  const program = await getProgram(prisma);
  if (input.rewardIds.length > 0) {
    if (!input.customerId) throw badRequest("CUSTOMER_REQUIRED", "Redeeming rewards needs a customer");
    // The storefront only identifies customers by email, so redemption stays at the register for now.
    if (!actor) throw forbidden("Rewards are redeemed at the register");
  }
  const loyaltyLines = priced.map((p) => ({
    variantId: p.variant.id,
    productId: p.variant.productId,
    kind: p.variant.product.kind,
    unitPriceCents: p.unitPriceCents,
    quantity: p.quantity,
    discountCents: p.discountCents,
  }));
  const redemption = await priceRewards(prisma, program, loyaltyLines, input.rewardIds);
  const rewardDiscounts = redemption.discounts;
  priced.forEach((p, i) => (p.discountCents += rewardDiscounts[i]!));

  // Cash-price totals are the order's base; card tenders pay the card price.
  const dual = dualTotals(priced, location.taxRateBps, location.cardPriceBps);
  const totals = dual.cash;

  // ── Validate tenders ───────────────────────────────────────
  // Preorder deposits were collected at their stated amount and count at the cash price.
  const deposit = opts.preorder?.depositCents ?? 0;
  const cashPricedPaid = input.tenders.filter((t) => !isCardPriced(t.type, location.cardPricedTenders)).reduce((a, t) => a + t.amountCents, 0) + deposit;
  const cardPaid = input.tenders.filter((t) => isCardPriced(t.type, location.cardPricedTenders)).reduce((a, t) => a + t.amountCents, 0);
  const cardDue = cardAmountDue(dual, cashPricedPaid);
  if (cashPricedPaid > totals.totalCents || cardPaid !== cardDue) {
    throw badRequest("TENDER_MISMATCH", "Tenders must equal the order total", {
      cashTotalCents: dual.cash.totalCents,
      cardTotalCents: dual.card.totalCents,
      cashPricedPaidCents: cashPricedPaid,
      cardDueCents: cardDue,
      cardPaidCents: cardPaid,
    });
  }
  const adjustment = cardAdjustment(dual, cardPaid, cashPricedPaid);
  let changeCents = 0;
  for (const t of input.tenders) {
    if (opts.allowedTenders && !opts.allowedTenders.includes(t.type)) throw badRequest("TENDER_NOT_ALLOWED", `${t.type} not accepted here`);
    if (t.type === "CARD" && !t.paymentToken && !t.terminalId) throw badRequest("CARD_SOURCE", "Card tender needs a token or terminal");
    if (t.type === "STORE_CREDIT" && !input.customerId) throw badRequest("CUSTOMER_REQUIRED", "Store credit needs a customer");
    if (t.type === "LOYALTY" && !input.customerId) throw badRequest("CUSTOMER_REQUIRED", "Rewards dollars need a customer");
    if (t.type === "GIFT_CARD" && !t.giftCardCode) throw badRequest("GIFT_CARD_CODE", "Gift card code required");
    if (t.type === "EXTERNAL" && !actor) throw forbidden("External tenders are staff-only");
    if (t.type === "CHECK") {
      if (!actor) throw forbidden("Checks are register-only");
      if (!t.reference) throw badRequest("CHECK_NUMBER", "Enter the check number");
    }
    if (t.type === "CASH") {
      if (!actor) throw forbidden("Cash is register-only");
      const handed = t.tenderedCents ?? t.amountCents;
      if (handed < t.amountCents) throw badRequest("CASH_SHORT", "Cash handed over is less than the cash amount");
      changeCents += handed - t.amountCents;
    }
  }

  // Fail fast on loyalty balances so we don't charge a card only to void it.
  // (Spends are re-checked under a row lock when committed.)
  const rewardsTender = input.tenders.filter((t) => t.type === "LOYALTY").reduce((a, t) => a + t.amountCents, 0);
  if (input.customerId && (redemption.pointsCost > 0 || rewardsTender > 0)) {
    const bal = await loyaltyBalances(prisma, input.customerId);
    if (bal.points < redemption.pointsCost) {
      throw conflict("INSUFFICIENT_POINTS", "Not enough points for these rewards", { balance: bal.points, requested: redemption.pointsCost });
    }
    if (bal.rewardsCents < rewardsTender) {
      throw conflict("INSUFFICIENT_REWARDS", "Not enough rewards dollars", { balance: bal.rewardsCents, requested: rewardsTender });
    }
  }

  // Card-present tenders: resolve the register's terminal before opening the order.
  const terminals = new Map<number, ResolvedTerminal>();
  for (const [i, t] of input.tenders.entries()) {
    if (t.type === "CARD" && t.terminalId) terminals.set(i, await resolveTerminal(prisma, t.terminalId, location.id));
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
      for (const [i, p] of priced.entries()) {
        const line = await tx.orderLine.create({
          data: {
            orderId: o.id,
            variantId: p.variant.id,
            title: describeVariant(p.variant.product.title, p.variant),
            quantity: p.quantity,
            unitPriceCents: p.unitPriceCents,
            discountCents: p.discountCents,
            rewardDiscountCents: rewardDiscounts[i]!,
            promoDiscountCents: p.promoDiscountCents,
            discountReasonId: reasonFor.get(i)?.id,
            discountReason: reasonFor.get(i)?.name,
            discountNote: reasonFor.has(i) ? p.discountNote : undefined,
            earnsLoyalty: !!input.customerId && program.enabled && earns(program, p.variant.product.kind),
            taxable: p.taxable,
            costCents: p.variant.costCents,
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
  // Card-present sales wait here while the customer taps on the terminal.
  const approved: (Charge & { tenderIndex: number })[] = [];
  for (const [i, t] of input.tenders.entries()) {
    if (t.type !== "CARD") continue;
    const terminal = terminals.get(i);
    let result: GatewayResult;
    try {
      result = await gateway.sale({
        amountCents: t.amountCents,
        currency: config.currency,
        paymentToken: t.paymentToken,
        terminal,
        orderRef: String(order.number),
        idempotencyKey: `${input.idempotencyKey}:${i}`,
      });
    } catch (e) {
      // A thrown error means we don't know if the charge went through.
      result = { approved: false, pending: true, message: e instanceof Error ? e.message : "Gateway error" };
    }
    if (result.pending) {
      await voidCharges(ctx, { orderId: order.id }, approved);
      await prisma.order.update({ where: { id: order.id }, data: { status: "VOID" } });
      throw await recordUnknownCharge(ctx, { orderId: order.id }, { result, amountCents: t.amountCents, terminal });
    }
    if (!result.approved) {
      await rollbackCharges(ctx, order.id, approved);
      throw paymentFailed(result.message ?? "Card declined", { orderId: order.id });
    }
    approved.push({ tenderIndex: i, result, amountCents: t.amountCents, terminal });
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
          await attributeConsignment(tx, lineId, location.id, p, approval.canOverridePrice);
        }
        if (p.variant.product.kind === "EVENT_ENTRY") {
          await registerForEvent(tx, p.variant.id, input.customerId!, lineId);
        }
      }

      for (const [i, t] of input.tenders.entries()) {
        const charge = approved.find((a) => a.tenderIndex === i);
        const card = charge?.result;
        if (t.type === "STORE_CREDIT") {
          await postCredit(tx, { customerId: input.customerId!, amountCents: -t.amountCents, reason: "Purchase", orderId: order.id });
        }
        if (t.type === "LOYALTY") {
          await postLoyalty(tx, { customerId: input.customerId!, unit: "CENTS", amount: -t.amountCents, reason: "Purchase", orderId: order.id });
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
            gateway: card ? (card.gateway ?? gateway.name) : null,
            terminalId: charge?.terminal?.id,
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

      // Spend points on redeemed rewards, then earn on what was actually paid.
      for (const r of redemption.rewards) {
        await postLoyalty(tx, { customerId: input.customerId!, unit: "POINTS", amount: -r.pointsCost, reason: "Reward redeemed", orderId: order.id, rewardId: r.id });
      }
      let loyaltyEarned = 0;
      let loyaltyEligibleCents = 0;
      if (input.customerId && program.enabled) {
        loyaltyEligibleCents = priced.reduce(
          (a, p) => a + (earns(program, p.variant.product.kind) ? p.unitPriceCents * p.quantity - p.discountCents : 0),
          0,
        );
        const creditPaid = input.tenders.filter((t) => t.type === "STORE_CREDIT" || t.type === "LOYALTY").reduce((a, t) => a + t.amountCents, 0);
        loyaltyEarned = earnFor(program, loyaltyEligibleCents, totals.totalCents, creditPaid);
        await postLoyalty(tx, { customerId: input.customerId, unit: unitFor(program), amount: loyaltyEarned, reason: "Earned", orderId: order.id });
      }

      // Activity log: each manual discount and price change, with who approved it.
      for (const [i, p] of priced.entries()) {
        const manual = p.discountCents - p.promoDiscountCents - rewardDiscounts[i]!;
        const base = { staffId: actor?.id, approverId: approval.approverId, locationId: location.id };
        if (manual > 0) {
          await audit(tx, {
            ...base,
            action: "DISCOUNT",
            details: {
              orderId: order.id,
              orderNumber: order.number,
              item: p.variant.product.title,
              sku: p.variant.sku,
              amountCents: manual,
              reason: reasonFor.get(i)?.name ?? null,
              note: p.discountNote ?? null,
            },
          });
        }
        if (p.unitPriceCents !== p.listPriceCents) {
          await audit(tx, {
            ...base,
            action: "PRICE_OVERRIDE",
            details: { orderId: order.id, orderNumber: order.number, item: p.variant.product.title, sku: p.variant.sku, fromCents: p.listPriceCents, toCents: p.unitPriceCents, quantity: p.quantity },
          });
        }
      }

      if (approval.token) {
        if (!(await consumeApproval(tx, approval.token, `order ${order.id}`))) throw approvalRequired(approval.permissions[0]!);
        await audit(tx, {
          action: "APPROVED:SALE",
          staffId: actor?.id,
          approverId: approval.approverId,
          locationId: location.id,
          details: { orderId: order.id, permissions: approval.permissions },
        });
      }

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "PAID",
          cardAdjustmentCents: adjustment.adjustmentCents,
          cardAdjustmentTaxCents: adjustment.taxCents,
          cardPriceBps: location.cardPriceBps,
          cardTotalCents: dual.card.totalCents,
          loyaltyEarned,
          loyaltyUnit: loyaltyEarned > 0 ? unitFor(program) : null,
          loyaltyEligibleCents,
          pointsRedeemed: redemption.pointsCost,
          appliedPromotions: deals.applied as unknown as Prisma.InputJsonValue,
        },
      });
    });
  } catch (e) {
    await rollbackCharges(ctx, order.id, approved);
    throw e;
  }

  const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  return { order: final, changeCents, replayed: false };
}

/** Void any approved card charges and mark the order void. */
async function rollbackCharges(ctx: Ctx, orderId: string, charges: Charge[]): Promise<void> {
  await voidCharges(ctx, { orderId }, charges);
  await ctx.prisma.order.update({ where: { id: orderId }, data: { status: "VOID" } });
}

interface PricedLine {
  variant: { id: string };
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
}

/** Sell consigned units first-in-first-out and record what the store owes each consignor. */
async function attributeConsignment(tx: Tx, orderLineId: string, locationId: string, p: PricedLine, canOverridePrice: boolean): Promise<void> {
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
    if (item.floorCents !== null && netPerUnit < item.floorCents && !canOverridePrice) {
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

interface RegisterApproval {
  /** Approval to consume when the sale commits. */
  token?: string;
  approverId?: string;
  permissions: Permission[];
  /** May sell below a consignor's floor (price-override rights or approval). */
  canOverridePrice: boolean;
}

/**
 * Price changes need PRICE_OVERRIDE; manual discounts need DISCOUNT_LINE and
 * must fit the employee's discount limit. Anything beyond that needs a
 * manager's PIN approval that covers it (and whose own limit covers it).
 */
async function registerApprovals(
  ctx: Ctx,
  need: { priceOverride: boolean; maxDiscountBps: number; customDiscount: boolean; storeCreditTender: boolean },
): Promise<RegisterApproval> {
  const { actor, perms } = ctx;
  const levels = perms?.levels;
  const canOverride = levels?.PRICE_OVERRIDE === "ALLOW";
  if (!actor) return { permissions: [], canOverridePrice: false };

  const required: Permission[] = [];
  if (need.priceOverride) {
    if (!levels || levels.PRICE_OVERRIDE === "DENY") throw permissionDenied("PRICE_OVERRIDE");
    if (levels.PRICE_OVERRIDE === "PIN") required.push("PRICE_OVERRIDE");
  }
  if (need.storeCreditTender) {
    if (!levels || levels.TENDER_STORE_CREDIT === "DENY") throw permissionDenied("TENDER_STORE_CREDIT");
    if (levels.TENDER_STORE_CREDIT === "PIN") required.push("TENDER_STORE_CREDIT");
  }
  if (need.maxDiscountBps > 0) {
    if (!levels || levels.DISCOUNT_LINE === "DENY") throw permissionDenied("DISCOUNT_LINE");
    if (levels.DISCOUNT_LINE === "PIN" || need.maxDiscountBps > perms!.discountMaxBps) required.push("DISCOUNT_LINE");
    if (need.customDiscount) {
      if (levels.DISCOUNT_CUSTOM === "DENY") throw permissionDenied("DISCOUNT_CUSTOM");
      if (levels.DISCOUNT_CUSTOM === "PIN") required.push("DISCOUNT_CUSTOM");
    }
  }
  if (required.length === 0) return { permissions: [], canOverridePrice: canOverride };

  const grants = await Promise.all(required.map((p) => findApproval(ctx.prisma, ctx.approvalToken, p, actor.id)));
  const grant = grants[0];
  const ok = grant && grants.every((g) => g?.id === grant.id) && (!required.includes("DISCOUNT_LINE") || grant.discountMaxBps >= need.maxDiscountBps);
  if (!ok) throw approvalRequired(required[0]!, { permissions: required, discountBps: need.maxDiscountBps });
  return {
    token: grant.id,
    approverId: grant.approverId,
    permissions: required,
    canOverridePrice: canOverride || required.includes("PRICE_OVERRIDE"),
  };
}

function sumChange(order: OrderWithDetails): number {
  return order.payments.reduce((a, p) => a + (p.changeCents ?? 0), 0);
}

/** Receipt/ticket title: "Charizard ex (PSA 10 #12345678 / HOLO)", "Jordan 4 (Size 10 / New)". */
export function describeVariant(
  title: string,
  v: {
    condition: string | null;
    finish: string | null;
    size: string | null;
    itemCondition: string | null;
    gradingCompany?: string | null;
    grade?: string | null;
    certNumber?: string | null;
  },
): string {
  const graded = gradeLabel(v.gradingCompany, v.grade);
  const parts = [
    graded ? `${graded}${v.certNumber ? ` #${v.certNumber}` : ""}` : v.condition,
    v.finish && v.finish !== "NONFOIL" ? v.finish : null,
    v.size ? `Size ${v.size}` : null,
    v.itemCondition ? (isNewItem(v.itemCondition) ? "New" : ITEM_CONDITION_LABELS[v.itemCondition as ItemCondition] ?? v.itemCondition) : null,
  ];
  const suffix = parts.filter(Boolean).join(" / ");
  return suffix ? `${title} (${suffix})` : title;
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
