import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { AppError, badRequest } from "../errors.js";
import type { GatewayResult, TerminalRef } from "../payments/gateway.js";
import type { Ctx } from "./context.js";

export interface ResolvedTerminal extends TerminalRef {
  id: string;
}

/** Look up a register's card terminal; it must be active and at this location. */
export async function resolveTerminal(db: Db, terminalId: string, locationId: string): Promise<ResolvedTerminal> {
  const t = await db.terminal.findUnique({ where: { id: terminalId } });
  if (!t || !t.active || t.locationId !== locationId) throw badRequest("TERMINAL", "That card terminal isn't available at this location");
  return { id: t.id, ref: t.gatewayRef, model: t.model };
}

export interface Charge {
  result: GatewayResult;
  amountCents: number;
  terminal?: ResolvedTerminal;
}

type Link = { orderId: string } | { preorderId: string };

/** Void approved charges after a failed sale. A void that fails is recorded PENDING for a manager to resolve. */
export async function voidCharges(ctx: Ctx, link: Link, charges: Charge[]): Promise<void> {
  for (const c of charges) {
    if (!c.result.gatewayRef) continue;
    let voided: GatewayResult;
    try {
      voided = await ctx.gateway.void(c.result.gatewayRef, {
        amountCents: c.amountCents,
        terminal: c.terminal,
        gateway: c.result.gateway,
      });
    } catch (e) {
      voided = { approved: false, message: e instanceof Error ? e.message : "void failed" };
    }
    await ctx.prisma.payment.create({
      data: {
        ...link,
        amountCents: voided.approved ? 0 : c.amountCents,
        tender: "CARD",
        status: voided.approved ? "VOIDED" : "PENDING",
        gateway: c.result.gateway ?? ctx.gateway.name,
        gatewayRef: c.result.gatewayRef,
        cardLast4: c.result.cardLast4,
        terminalId: c.terminal?.id,
        raw: { action: "void", ok: voided.approved, message: voided.message ?? null } as Prisma.InputJsonValue,
      },
    });
  }
}

/** Record a charge whose outcome is unknown, and build the error the register shows. */
export async function recordUnknownCharge(ctx: Ctx, link: Link, c: Charge): Promise<AppError> {
  const p = await ctx.prisma.payment.create({
    data: {
      ...link,
      amountCents: c.amountCents,
      tender: "CARD",
      status: "PENDING",
      gateway: c.result.gateway ?? ctx.gateway.name,
      gatewayRef: c.result.gatewayRef,
      terminalId: c.terminal?.id,
      raw: { action: "sale", message: c.result.message ?? null } as Prisma.InputJsonValue,
    },
  });
  return new AppError(
    409,
    "PAYMENT_UNKNOWN",
    "We couldn't confirm the card payment. Check the terminal screen before trying again; a manager can resolve it from the payment.",
    { paymentId: p.id, ...link },
  );
}

/**
 * Terminal for a card-present refund/void: the one the cashier picked, else
 * the terminal that took the original payment (if it's still in service).
 */
export async function followUpTerminal(
  db: Db,
  locationId: string,
  requestedId: string | undefined,
  originalId: string | null,
): Promise<ResolvedTerminal | undefined> {
  if (requestedId) return resolveTerminal(db, requestedId, locationId);
  if (!originalId) return undefined;
  const t = await db.terminal.findUnique({ where: { id: originalId } });
  return t?.active ? { id: t.id, ref: t.gatewayRef, model: t.model } : undefined;
}
