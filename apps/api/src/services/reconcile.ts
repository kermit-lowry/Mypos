import { Prisma, type Payment } from "@prisma/client";
import { badRequest, notFound } from "../errors.js";
import type { GatewayResult } from "../payments/gateway.js";
import type { Ctx } from "./context.js";

export interface ReconcileResult {
  payment: Payment;
  outcome: "VOIDED" | "DECLINED" | "REFUNDED" | "STILL_PENDING";
  message?: string;
}

/**
 * Resolve a PENDING card payment: a sale whose outcome was unknown, a void
 * that failed, or a refund that didn't go through. Safe to run repeatedly.
 */
export async function reconcilePayment(ctx: Ctx, paymentId: string): Promise<ReconcileResult> {
  const { prisma, gateway } = ctx;
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p) throw notFound("Payment");
  if (p.status !== "PENDING" || p.tender !== "CARD") throw badRequest("NOT_PENDING", "Only pending card payments need resolving");
  const terminal = p.terminalId ? await prisma.terminal.findUnique({ where: { id: p.terminalId } }) : null;
  const term = terminal?.active ? { id: terminal.id, ref: terminal.gatewayRef, model: terminal.model } : undefined;
  const opts = { gateway: p.gateway ?? undefined, terminal: term, cardLast4: p.cardLast4 ?? undefined };
  const action = (p.raw as { action?: string } | null)?.action;

  const save = async (status: Payment["status"], outcome: ReconcileResult["outcome"], r: GatewayResult, extra: Prisma.PaymentUpdateInput = {}) => ({
    payment: await prisma.payment.update({
      where: { id: p.id },
      data: { status, raw: { ...((p.raw as object) ?? {}), resolved: outcome, message: r.message ?? null } as Prisma.InputJsonValue, ...extra },
    }),
    outcome,
    message: r.message,
  });

  // A refund that failed: try it again.
  if (p.amountCents < 0 && p.refundOfId) {
    const original = await prisma.payment.findUniqueOrThrow({ where: { id: p.refundOfId } });
    const r = await gateway.refund(original.gatewayRef!, -p.amountCents, opts);
    return r.approved ? save("APPROVED", "REFUNDED", r, { gatewayRef: r.gatewayRef ?? p.gatewayRef }) : { payment: p, outcome: "STILL_PENDING", message: r.message };
  }

  // A sale with an unknown outcome: find out, and release it if it went through
  // (the order was already voided at the register).
  let chargeRef = p.gatewayRef;
  if (action === "sale") {
    if (!chargeRef || !gateway.lookup) return { payment: p, outcome: "STILL_PENDING", message: "Check this payment in the processor's portal" };
    const found = await gateway.lookup(chargeRef, opts);
    if (found.pending) return { payment: p, outcome: "STILL_PENDING", message: found.message };
    if (!found.approved) return save("DECLINED", "DECLINED", found, { amountCents: 0 });
    chargeRef = found.gatewayRef ?? chargeRef;
  }

  // Charged but the sale didn't complete (or an earlier void failed): void it.
  const v = await gateway.void(chargeRef!, { ...opts, amountCents: p.amountCents });
  if (!v.approved) {
    await prisma.payment.update({ where: { id: p.id }, data: { gatewayRef: chargeRef } });
    return { payment: p, outcome: "STILL_PENDING", message: v.message ?? "Void failed; refund it on the terminal" };
  }
  return save("VOIDED", "VOIDED", v, { amountCents: 0, gatewayRef: chargeRef });
}
