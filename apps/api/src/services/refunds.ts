import type { Payment } from "@prisma/client";
import { cardPrice, roundHalfUp, type RefundInput } from "@mypos/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import type { Ctx } from "./context.js";
import { followUpTerminal } from "./charges.js";
import { currentSession, drawerClosed } from "./drawer.js";
import { moveInventory } from "./inventory.js";
import { postLoyalty } from "./loyalty.js";
import { postCredit } from "./storeCredit.js";

/** Order in which original tenders are paid back. */
const REFUND_ORDER = ["CARD", "GIFT_CARD", "STORE_CREDIT", "LOYALTY", "PREORDER_DEPOSIT", "EXTERNAL", "CASH"];

export interface RefundLeg {
  tender: string;
  amountCents: number;
  status: "APPROVED" | "PENDING";
  message?: string;
}

export interface RefundResult {
  refundCents: number;
  legs: RefundLeg[];
}

export async function refundOrder(ctx: Ctx, input: RefundInput): Promise<RefundResult> {
  const { prisma, gateway, actor } = ctx;

  // Everything except card refunds happens in one transaction that also claims
  // the refunded quantities, so the same items can never be refunded twice.
  const { refundCents, cardLegs, legs, orderId, locationId, drawerSessionId } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${input.orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { lines: { include: { variant: { include: { product: true } } } }, payments: true, location: true },
    });
    if (!order) throw notFound("Order");
    if (order.status !== "PAID" && order.status !== "PARTIALLY_REFUNDED") {
      throw conflict("NOT_REFUNDABLE", `Order is ${order.status}`);
    }
    // Refund money comes out of the register's open drawer session, when there is one.
    const drawer = await currentSession(tx, order.locationId, input.terminalId);
    if (input.toStoreCredit && !order.customerId) throw badRequest("CUSTOMER_REQUIRED", "Store credit refunds need a customer");

    // Dual pricing: a sale paid entirely by card is refunded at card prices, so
    // each item comes back at exactly its receipt price. A split sale is
    // refunded at cash prices scaled up by what was actually paid.
    const paid = order.totalCents + order.cardAdjustmentCents;
    const allCard = order.cardAdjustmentCents > 0 && paid === order.cardTotalCents;
    const unit = (l: { unitPriceCents: number }) => (allCard ? cardPrice(l.unitPriceCents, order.cardPriceBps) : l.unitPriceCents);
    const disc = (l: { discountCents: number }) => (allCard && l.discountCents ? cardPrice(l.discountCents, order.cardPriceBps) : l.discountCents);
    const orderTax = allCard ? order.taxCents + order.cardAdjustmentTaxCents : order.taxCents;
    const scale = (basis: number) => (allCard || order.totalCents === 0 ? basis : roundHalfUp((basis * paid) / order.totalCents));

    const taxableBase = order.lines.filter((l) => l.taxable).reduce((a, l) => a + unit(l) * l.quantity - disc(l), 0);

    // Amounts are computed cumulatively (refunded-so-far after minus before),
    // so a run of partial refunds always sums to exactly what was paid.
    const netAt = (l: { unitPriceCents: number; quantity: number; discountCents: number }, qty: number) =>
      roundHalfUp(((unit(l) * l.quantity - disc(l)) * qty) / l.quantity);
    const taxAt = (taxableNet: number) => (taxableBase > 0 ? roundHalfUp((orderTax * taxableNet) / taxableBase) : 0);
    let taxableRefunded = order.lines.filter((l) => l.taxable).reduce((a, l) => a + netAt(l, l.refundedQty), 0);
    const taxBefore = taxAt(taxableRefunded);
    const netBefore = order.lines.reduce((a, l) => a + netAt(l, l.refundedQty), 0);

    if (new Set(input.lines.map((l) => l.orderLineId)).size !== input.lines.length) {
      throw badRequest("DUPLICATE_LINE", "List each order line once");
    }

    let total = 0;
    for (const req of input.lines) {
      const line = order.lines.find((l) => l.id === req.orderLineId);
      if (!line) throw notFound(`Order line ${req.orderLineId}`);
      if (req.quantity > line.quantity - line.refundedQty) throw badRequest("REFUND_QTY", `Only ${line.quantity - line.refundedQty} refundable on ${line.title}`);

      const net = netAt(line, line.refundedQty + req.quantity) - netAt(line, line.refundedQty);
      if (line.taxable) taxableRefunded += net;
      total += net;

      await tx.orderLine.update({ where: { id: line.id }, data: { refundedQty: { increment: req.quantity } } });

      const tracked = line.variant.product.kind !== "EVENT_ENTRY";
      if (tracked && req.restock) {
        await moveInventory(tx, {
          variantId: line.variantId,
          locationId: order.locationId,
          delta: req.quantity,
          reason: "REFUND",
          orderId: order.id,
          staffId: actor?.id,
        });
      }
      if (line.variant.product.kind === "EVENT_ENTRY") {
        await tx.eventRegistration.deleteMany({ where: { orderLineId: line.id } });
      }
      if (line.consignmentItemId) {
        // Reverse what we owe the consignor for the returned units.
        const payouts = await tx.consignmentPayout.findMany({ where: { orderLineId: line.id } });
        const owed = payouts.reduce((a, p) => a + p.payoutCents, 0);
        const sale = payouts.reduce((a, p) => a + p.saleCents, 0);
        const commission = payouts.reduce((a, p) => a + p.commissionCents, 0);
        const first = payouts[0];
        if (first) {
          const share = (n: number) => -roundHalfUp((n * req.quantity) / line.quantity);
          await tx.consignmentPayout.create({
            data: {
              consignorId: first.consignorId,
              consignmentItemId: first.consignmentItemId,
              orderLineId: line.id,
              saleCents: share(sale),
              commissionCents: share(commission),
              payoutCents: share(owed),
            },
          });
          if (req.restock) {
            await tx.consignmentItem.update({
              where: { id: line.consignmentItemId },
              data: { soldQty: { decrement: req.quantity }, status: "ACTIVE" },
            });
          }
        }
      }
    }

    const cashBasisBefore = netBefore + taxBefore;
    const cashBasisAfter = netBefore + total + taxAt(taxableRefunded);
    total = scale(cashBasisAfter) - scale(cashBasisBefore);

    // Allocate the refund across tenders.
    const legs: RefundLeg[] = [];
    const cardLegs: { payment: Payment; amountCents: number }[] = [];
    if (input.toStoreCredit) {
      await postCredit(tx, { customerId: order.customerId!, amountCents: total, reason: "Refund", orderId: order.id });
      await tx.payment.create({ data: { orderId: order.id, amountCents: -total, tender: "STORE_CREDIT", status: "APPROVED", drawerSessionId: drawer?.id } });
      legs.push({ tender: "STORE_CREDIT", amountCents: total, status: "APPROVED" });
    } else {
      let left = total;
      const originals = order.payments
        .filter((p) => p.amountCents > 0 && p.status === "APPROVED")
        .sort((a, b) => REFUND_ORDER.indexOf(a.tender) - REFUND_ORDER.indexOf(b.tender));
      for (const p of originals) {
        if (left === 0) break;
        const already = order.payments.filter((r) => r.refundOfId === p.id).reduce((a, r) => a - r.amountCents, 0);
        const take = Math.min(left, p.amountCents - already);
        if (take <= 0) continue;
        left -= take;
        if (p.tender === "CARD") {
          cardLegs.push({ payment: p, amountCents: take });
          continue;
        }
        if (p.tender === "CASH" && !drawer && order.location.requireDrawerSession) throw drawerClosed();
        if (p.tender === "STORE_CREDIT" || p.tender === "PREORDER_DEPOSIT") {
          await postCredit(tx, { customerId: order.customerId!, amountCents: take, reason: "Refund", orderId: order.id });
        }
        if (p.tender === "LOYALTY") {
          await postLoyalty(tx, { customerId: order.customerId!, unit: "CENTS", amount: take, reason: "Refund", orderId: order.id });
        }
        if (p.tender === "GIFT_CARD" && p.gatewayRef) {
          await tx.giftCard.update({ where: { code: p.gatewayRef }, data: { balanceCents: { increment: take } } });
        }
        await tx.payment.create({
          data: { orderId: order.id, amountCents: -take, tender: p.tender, status: "APPROVED", refundOfId: p.id, drawerSessionId: drawer?.id },
        });
        legs.push({ tender: p.tender, amountCents: take, status: "APPROVED" });
      }
      if (left > 0) throw conflict("REFUND_EXCEEDS_PAYMENTS", "Refund exceeds what was paid", { left });
    }

    const lines = await tx.orderLine.findMany({ where: { orderId: order.id } });
    const fully = lines.every((l) => l.refundedQty === l.quantity);

    // Loyalty: take back what the returned items earned. Computed on the
    // cumulative refunded amount so a series of partial refunds claws back
    // exactly what was earned, never more.
    if (order.customerId && order.loyaltyEarned > 0 && order.loyaltyUnit && order.loyaltyEligibleCents > 0) {
      const refundedEligible = lines
        .filter((l) => l.earnsLoyalty)
        .reduce((a, l) => a + roundHalfUp(((l.unitPriceCents * l.quantity - l.discountCents) * l.refundedQty) / l.quantity), 0);
      const target = Math.min(order.loyaltyEarned, roundHalfUp((order.loyaltyEarned * refundedEligible) / order.loyaltyEligibleCents));
      const prior = await tx.loyaltyEntry.aggregate({
        where: { orderId: order.id, reason: "Refund clawback", unit: order.loyaltyUnit },
        _sum: { amount: true },
      });
      const clawed = -(prior._sum.amount ?? 0);
      await postLoyalty(
        tx,
        { customerId: order.customerId, unit: order.loyaltyUnit, amount: -(target - clawed), reason: "Refund clawback", orderId: order.id },
        { allowNegative: true },
      );
    }
    // Points spent on rewards come back only when the whole sale is returned.
    if (fully && order.customerId && order.pointsRedeemed > 0) {
      await postLoyalty(tx, { customerId: order.customerId, unit: "POINTS", amount: order.pointsRedeemed, reason: "Reward returned", orderId: order.id });
    }
    await tx.order.update({ where: { id: order.id }, data: { status: fully ? "REFUNDED" : "PARTIALLY_REFUNDED" } });

    return { refundCents: total, cardLegs, legs, orderId: order.id, locationId: order.locationId, drawerSessionId: drawer?.id };
  });

  // Card refunds go to the processor after the claim commits. A failure is
  // recorded as PENDING so a manager can retry it; it is never silently dropped.
  for (const { payment, amountCents } of cardLegs) {
    let ok = false;
    let message: string | undefined;
    let ref: string | undefined;
    let terminalId: string | undefined;
    try {
      // Card-present refunds run on a terminal: the one picked, else the original.
      const terminal = await followUpTerminal(prisma, locationId, input.terminalId, payment.terminalId);
      terminalId = terminal?.id;
      const r = await gateway.refund(payment.gatewayRef!, amountCents, {
        cardLast4: payment.cardLast4 ?? undefined,
        terminal,
        gateway: payment.gateway ?? undefined,
      });
      ok = r.approved;
      message = r.message;
      ref = r.gatewayRef;
    } catch (e) {
      message = e instanceof Error ? e.message : "Gateway error";
    }
    await prisma.payment.create({
      data: {
        orderId,
        amountCents: -amountCents,
        tender: "CARD",
        status: ok ? "APPROVED" : "PENDING",
        gateway: payment.gateway,
        gatewayRef: ref ?? payment.gatewayRef,
        cardLast4: payment.cardLast4,
        terminalId,
        drawerSessionId,
        refundOfId: payment.id,
        raw: message ? { message } : undefined,
      },
    });
    legs.push({ tender: "CARD", amountCents, status: ok ? "APPROVED" : "PENDING", message });
  }

  return { refundCents, legs };
}
