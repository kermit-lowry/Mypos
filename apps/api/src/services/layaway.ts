import { Prisma, type Layaway, type LayawayStatus, type Location, type Payment } from "@prisma/client";
import { applyBps, cardPrice, earnFor, formatBps, formatCents, isCardPriced, roundHalfUp, type LayawayInput, type LayawayPaymentInput, type TenderInput } from "@mypos/shared";
import { config } from "../config.js";
import type { Db, Tx } from "../db.js";
import { AppError, badRequest, conflict, notFound, paymentFailed } from "../errors.js";
import type { GatewayResult } from "../payments/gateway.js";
import { followUpTerminal, resolveTerminal, type Charge, type ResolvedTerminal } from "./charges.js";
import { describeVariant } from "./checkout.js";
import type { Ctx } from "./context.js";
import { currentSession, drawerClosed } from "./drawer.js";
import { moveInventory } from "./inventory.js";
import { earns, getProgram, postLoyalty, unitFor } from "./loyalty.js";
import { audit, changes } from "./permissions.js";
import { quoteCart } from "./quote.js";
import { postCredit } from "./storeCredit.js";

/**
 * Layaway: the customer puts items aside with a deposit, the store holds the
 * stock (reserved with a LAYAWAY movement), payments chip away at the balance,
 * and picking up turns the layaway into a PAID order with no further stock
 * movement. Cancelling returns the stock and refunds what was paid, minus the
 * store's cancellation fee.
 *
 * Money: `totalCents` is the cash-price total locked when the layaway opened.
 * A card-priced tender of X cents applies less than X to the balance (see
 * `splitCardTender`); the rest accumulates in `cardAdjustmentCents` (with the
 * tax inside it in `cardAdjustmentTaxCents`), the same meaning those fields
 * have on an Order. So: collected = paidCents + cardAdjustmentCents, and
 * balance = totalCents − paidCents.
 */

/** Tenders a layaway accepts for deposits and payments; refunds go back the same way. */
const LAYAWAY_TENDERS = new Set<string>(["CARD", "CASH", "STORE_CREDIT"]);
/** Order in which original tenders are paid back on cancellation. */
const REFUND_ORDER = ["CARD", "STORE_CREDIT", "CASH"];
/** Stored as the cancel reason when the deposit never went through. */
const DEPOSIT_FAILED = "Deposit payment failed";

const TENDER_LABELS: Record<string, string> = { CARD: "Card", CASH: "Cash", STORE_CREDIT: "Store credit" };

// ── Dual pricing on a payment ───────────────────────────────────

/**
 * How a card-priced tender of `amountCents` splits between the balance and the
 * card-price adjustment. The customer pays the card price for the slice of the
 * balance they cover, so `applied` is the largest amount whose card price fits
 * in what was charged: cardPrice(applied, bps) <= amountCents < cardPrice(applied + 1, bps).
 * Everything above `applied` is the adjustment (the markup plus the sales tax
 * on it), so applied + adjustment == amountCents exactly, and charging
 * cardPrice(balance, bps) applies exactly the balance. The estimate
 * amountCents / (1 + bps/10000) is nudged by at most a cent for rounding.
 */
export function splitCardTender(amountCents: number, bps: number): { appliedCents: number; adjustmentCents: number } {
  if (bps <= 0) return { appliedCents: amountCents, adjustmentCents: 0 };
  let applied = roundHalfUp((amountCents * 10_000) / (10_000 + bps));
  while (applied > 0 && cardPrice(applied, bps) > amountCents) applied--;
  while (cardPrice(applied + 1, bps) <= amountCents) applied++;
  return { appliedCents: applied, adjustmentCents: amountCents - applied };
}

/**
 * Sales tax inside the card adjustments collected so far: prorated by the
 * layaway's locked tax share of the total, as `cardAdjustment()` does for a
 * sale. Computed cumulatively so a run of payments never drifts by rounding.
 */
const adjustmentTax = (l: Pick<Layaway, "taxCents" | "totalCents">, adjustmentCents: number) =>
  l.totalCents > 0 ? roundHalfUp((adjustmentCents * l.taxCents) / l.totalCents) : 0;

interface SplitTender {
  tender: TenderInput;
  /** What the customer handed over (for cards, what was charged). */
  amountCents: number;
  /** The part that reduces the balance. */
  appliedCents: number;
  /** Card-price markup, including the tax on it; zero for cash-priced tenders. */
  adjustmentCents: number;
  /** Cash: handed over minus the cash amount. */
  changeCents: number;
}

/** Validate tenders and work out what each applies to the balance. `bps` is the layaway's locked card markup. */
function splitTenders(tenders: TenderInput[], location: Pick<Location, "cardPricedTenders">, bps: number): SplitTender[] {
  return tenders.map((t) => {
    if (!LAYAWAY_TENDERS.has(t.type)) throw badRequest("TENDER_NOT_ALLOWED", `${t.type} isn't accepted on layaway`);
    if (t.type === "CARD" && !t.paymentToken && !t.terminalId) throw badRequest("CARD_SOURCE", "Card tender needs a token or terminal");
    let changeCents = 0;
    if (t.type === "CASH") {
      const handed = t.tenderedCents ?? t.amountCents;
      if (handed < t.amountCents) throw badRequest("CASH_SHORT", "Cash handed over is less than the cash amount");
      changeCents = handed - t.amountCents;
    }
    const split = isCardPriced(t.type, location.cardPricedTenders) ? splitCardTender(t.amountCents, bps) : { appliedCents: t.amountCents, adjustmentCents: 0 };
    return { tender: t, amountCents: t.amountCents, ...split, changeCents };
  });
}

const sumBy = <T>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);

// ── Card charges (the same handling as charges.ts, linked to a layaway) ──

type Approved = Charge & { tenderIndex: number };

/** Void approved charges after a failed deposit or payment; a void that fails is recorded PENDING for a manager. */
async function voidLayawayCharges(ctx: Ctx, layawayId: string, charges: Charge[]): Promise<void> {
  for (const c of charges) {
    if (!c.result.gatewayRef) continue;
    let voided: GatewayResult;
    try {
      voided = await ctx.gateway.void(c.result.gatewayRef, { amountCents: c.amountCents, terminal: c.terminal, gateway: c.result.gateway });
    } catch (e) {
      voided = { approved: false, message: e instanceof Error ? e.message : "void failed" };
    }
    await ctx.prisma.payment.create({
      data: {
        layawayId,
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
async function recordUnknownLayawayCharge(ctx: Ctx, layawayId: string, c: Charge): Promise<AppError> {
  const p = await ctx.prisma.payment.create({
    data: {
      layawayId,
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
    { paymentId: p.id, layawayId },
  );
}

/** Card-present tenders: resolve each register terminal before anything is claimed. */
async function resolveTerminals(db: Db, tenders: TenderInput[], locationId: string): Promise<Map<number, ResolvedTerminal>> {
  const terminals = new Map<number, ResolvedTerminal>();
  for (const [i, t] of tenders.entries()) {
    if (t.type === "CARD" && t.terminalId) terminals.set(i, await resolveTerminal(db, t.terminalId, locationId));
  }
  return terminals;
}

/**
 * Charge the card tenders, like placePreorder: a decline voids whatever was
 * approved before it and `undo` puts the layaway back; an unknown outcome
 * does the same and leaves a PENDING payment for a manager to resolve.
 */
async function chargeCards(
  ctx: Ctx,
  layaway: { id: string; number: number },
  splits: SplitTender[],
  idempotencyKey: string,
  terminals: Map<number, ResolvedTerminal>,
  undo: (approved: Approved[]) => Promise<void>,
): Promise<Approved[]> {
  const approved: Approved[] = [];
  for (const [i, s] of splits.entries()) {
    const t = s.tender;
    if (t.type !== "CARD") continue;
    const terminal = terminals.get(i);
    const result = await ctx.gateway
      .sale({
        amountCents: t.amountCents,
        currency: config.currency,
        paymentToken: t.paymentToken,
        terminal,
        orderRef: `LAY-${layaway.number}`,
        idempotencyKey: `${idempotencyKey}:${i}`,
      })
      .catch((e: unknown): GatewayResult => ({ approved: false, pending: true, message: e instanceof Error ? e.message : "Gateway error" }));
    if (result.pending) {
      await undo(approved);
      throw await recordUnknownLayawayCharge(ctx, layaway.id, { result, amountCents: t.amountCents, terminal });
    }
    if (!result.approved) {
      await undo(approved);
      throw paymentFailed(result.message ?? "Card declined", { layawayId: layaway.id });
    }
    approved.push({ tenderIndex: i, result, amountCents: t.amountCents, terminal });
  }
  return approved;
}

interface PaymentMeta {
  idempotencyKey: string;
  staffId?: string;
  drawerSessionId?: string;
  /** The opening deposit (shown as such on the statement). */
  deposit: boolean;
}

/**
 * Write the payment rows for a deposit or payment and move the layaway's
 * running totals. The caller holds the row lock. Store credit is debited here
 * so an insufficient balance rolls everything back.
 */
async function postPayments(tx: Tx, l: Pick<Layaway, "id" | "number" | "customerId" | "taxCents" | "totalCents" | "paidCents" | "cardAdjustmentCents">, splits: SplitTender[], approved: Approved[], meta: PaymentMeta, gatewayName: string) {
  const applied = sumBy(splits, (s) => s.appliedCents);
  const adjustment = sumBy(splits, (s) => s.adjustmentCents);
  const balance = l.totalCents - l.paidCents;
  if (applied > balance) throw badRequest("OVERPAID", `Only ${formatCents(balance)} is owed on layaway #${l.number}`, { balanceCents: balance });

  const rows: Payment[] = [];
  for (const [i, s] of splits.entries()) {
    const t = s.tender;
    const card = approved.find((a) => a.tenderIndex === i);
    if (t.type === "STORE_CREDIT") {
      await postCredit(tx, { customerId: l.customerId, amountCents: -t.amountCents, reason: meta.deposit ? `Layaway #${l.number} deposit` : `Layaway #${l.number} payment` });
    }
    rows.push(
      await tx.payment.create({
        data: {
          layawayId: l.id,
          amountCents: s.amountCents,
          appliedCents: s.appliedCents,
          tender: t.type,
          status: "APPROVED",
          gateway: card ? (card.result.gateway ?? gatewayName) : null,
          terminalId: card?.terminal?.id,
          drawerSessionId: meta.drawerSessionId,
          gatewayRef: card?.result.gatewayRef,
          cardBrand: card?.result.cardBrand,
          cardLast4: card?.result.cardLast4,
          changeCents: t.type === "CASH" ? s.changeCents : null,
          raw: { idempotencyKey: meta.idempotencyKey, staffId: meta.staffId ?? null, deposit: meta.deposit },
        },
      }),
    );
  }
  const updated = await tx.layaway.update({
    where: { id: l.id },
    data: {
      paidCents: { increment: applied },
      cardAdjustmentCents: { increment: adjustment },
      cardAdjustmentTaxCents: adjustmentTax(l, l.cardAdjustmentCents + adjustment),
    },
  });
  return { rows, applied, adjustment, updated };
}

const lockLayaway = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM "Layaway" WHERE id = ${id} FOR UPDATE`;

const stateError = (l: Pick<Layaway, "number" | "status">) => conflict("LAYAWAY_STATE", `Layaway #${l.number} is ${l.status.toLowerCase()}`, { status: l.status });

// ── Open ─────────────────────────────────────────────────────────

export interface OpenResult {
  layaway: LayawayDetail;
  changeCents: number;
  /** True when this idempotency key was already processed. */
  replayed: boolean;
}

/** Lock the cart's prices, reserve the stock, and take the deposit. */
export async function openLayaway(ctx: Ctx, input: LayawayInput): Promise<OpenResult> {
  const { prisma, gateway, actor } = ctx;
  const replay = async (): Promise<OpenResult | null> => {
    const existing = await prisma.layaway.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
    if (!existing) return null;
    const layaway = await getLayaway(prisma, existing.id);
    return { layaway, changeCents: sumBy(layaway.payments, (p) => p.changeCents ?? 0), replayed: true };
  };
  const replayed = await replay();
  if (replayed) return replayed;

  // ── Validate ───────────────────────────────────────────────
  const location = await prisma.location.findUnique({ where: { id: input.locationId } });
  if (!location) throw notFound("Location");
  if (!location.layawayEnabled) throw conflict("LAYAWAY_DISABLED", "Layaway isn't offered at this location");
  const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw notFound("Customer");
  if (input.dueAt && input.dueAt <= new Date()) throw badRequest("DUE_DATE", "The due date has to be in the future");

  const variants = await prisma.variant.findMany({ where: { id: { in: input.lines.map((l) => l.variantId) } }, include: { product: true } });
  const byId = new Map(variants.map((v) => [v.id, v]));
  for (const line of input.lines) {
    const v = byId.get(line.variantId);
    if (!v) throw notFound(`Variant ${line.variantId}`);
    // Layaway lines are sold at list price with automated deals only. Manual
    // discounts and price changes go through checkout's approval rules, which
    // aren't shared, so they're refused here rather than skipped silently.
    if (line.discountCents > 0 || (line.unitPriceCents !== undefined && line.unitPriceCents !== v.priceCents)) {
      throw badRequest("LAYAWAY_NO_MANUAL_DISCOUNT", "Layaway items are priced at the list price; discounts can't be applied");
    }
    if (v.product.kind === "EVENT_ENTRY") throw badRequest("LAYAWAY_ITEM", "Event entries can't go on layaway");
    if (v.serialized && line.quantity > 1) throw badRequest("SERIALIZED", `${v.sku} is a one-of-one item`);
  }

  // Price the cart like a sale: deals and dual pricing, no manual discounts, no rewards.
  const quote = await quoteCart(prisma, {
    locationId: location.id,
    channel: "POS",
    customerId: customer.id,
    lines: input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, discountCents: 0 })),
    rewardIds: [],
  });
  const priced = input.lines.map((line, i) => {
    const v = byId.get(line.variantId)!;
    const q = quote.lines[i]!;
    return {
      variantId: v.id,
      title: describeVariant(v.product.title, v),
      quantity: line.quantity,
      unitPriceCents: v.priceCents,
      discountCents: q.discountCents,
      promoDiscountCents: q.promoDiscountCents,
      taxable: v.taxable,
      costCents: v.costCents,
    };
  });

  // The minimum deposit is checked against what the customer hands over; what
  // it applies to the balance can't exceed the total.
  const splits = splitTenders(input.tenders, location, location.cardPriceBps);
  const minimum = applyBps(quote.totalCents, location.layawayMinDepositBps);
  const tendered = sumBy(splits, (s) => s.amountCents);
  if (tendered < minimum) throw badRequest("DEPOSIT_TOO_SMALL", `The deposit has to be at least ${formatCents(minimum)}`, { minimumCents: minimum, tenderedCents: tendered });
  if (sumBy(splits, (s) => s.appliedCents) > quote.totalCents) throw badRequest("OVERPAID", "The deposit is more than the layaway total", { balanceCents: quote.totalCents });

  // Cash goes into the register's open drawer, like a sale.
  const drawer = await currentSession(prisma, location.id, input.terminalId);
  if (!drawer && location.requireDrawerSession && input.tenders.some((t) => t.type === "CASH")) throw drawerClosed();
  const terminals = await resolveTerminals(prisma, input.tenders, location.id);
  const dueAt = input.dueAt ?? new Date(Date.now() + location.layawayTermDays * 86_400_000);

  // ── Claim the key, lock prices, reserve stock ──────────────
  let layaway: { id: string; number: number };
  try {
    layaway = await prisma.$transaction(async (tx) => {
      const l = await tx.layaway.create({
        data: {
          locationId: location.id,
          customerId: customer.id,
          staffId: actor?.id,
          idempotencyKey: input.idempotencyKey,
          subtotalCents: quote.subtotalCents,
          discountCents: quote.discountCents,
          taxCents: quote.taxCents,
          totalCents: quote.totalCents,
          cardPriceBps: location.cardPriceBps,
          appliedPromotions: quote.promotions as unknown as Prisma.InputJsonValue,
          dueAt,
          notes: input.notes,
          lines: { create: priced },
        },
      });
      for (const p of priced) {
        await moveInventory(tx, { variantId: p.variantId, locationId: location.id, delta: -p.quantity, reason: "LAYAWAY", note: `Layaway #${l.number}`, staffId: actor?.id, strict: true });
      }
      return { id: l.id, number: l.number };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const again = await replay();
      if (again) return again;
    }
    throw e;
  }

  // A failed deposit puts the stock back and leaves the layaway cancelled (the
  // row stays so its idempotency key and any PENDING card payment are kept).
  const undo = async (approved: Approved[]) => {
    await voidLayawayCharges(ctx, layaway.id, approved);
    await prisma.$transaction(async (tx) => {
      for (const p of priced) {
        await moveInventory(tx, { variantId: p.variantId, locationId: location.id, delta: p.quantity, reason: "LAYAWAY_RETURN", note: `Layaway #${layaway.number}: ${DEPOSIT_FAILED.toLowerCase()}`, staffId: actor?.id });
      }
      await tx.layaway.update({ where: { id: layaway.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: DEPOSIT_FAILED } });
    });
  };

  // ── Charge cards, then record the deposit ──────────────────
  const approved = await chargeCards(ctx, layaway, splits, input.idempotencyKey, terminals, undo);
  try {
    await prisma.$transaction(async (tx) => {
      await lockLayaway(tx, layaway.id);
      const l = await tx.layaway.findUniqueOrThrow({ where: { id: layaway.id } });
      const { applied } = await postPayments(tx, l, splits, approved, { idempotencyKey: input.idempotencyKey, staffId: actor?.id, drawerSessionId: drawer?.id, deposit: true }, gateway.name);
      await audit(tx, {
        action: "LAYAWAY_CREATED",
        staffId: actor?.id,
        locationId: location.id,
        details: { layawayId: l.id, number: l.number, customerId: customer.id, totalCents: l.totalCents, depositCents: applied, dueAt: dueAt.toISOString() },
      });
    });
  } catch (e) {
    await undo(approved);
    throw e;
  }

  const detail = await getLayaway(prisma, layaway.id);
  return { layaway: detail, changeCents: sumBy(splits, (s) => s.changeCents), replayed: false };
}

/** True for a layaway left cancelled by a deposit that never went through (no one cancelled it, nothing was paid). */
export const depositFailed = (l: Pick<Layaway, "status" | "paidCents" | "cancelledById">) => l.status === "CANCELLED" && l.paidCents === 0 && !l.cancelledById;

// ── Payments ─────────────────────────────────────────────────────

export interface PaymentResult {
  layaway: LayawayDetail;
  /** The rows written for this payment (one per tender). */
  payments: Payment[];
  changeCents: number;
  replayed: boolean;
}

/** A payment toward the balance. Idempotent per key: a retry returns the rows it wrote the first time. */
export async function takePayment(ctx: Ctx, layawayId: string, input: LayawayPaymentInput): Promise<PaymentResult> {
  const { prisma, gateway, actor } = ctx;
  const found = await prisma.layaway.findUnique({ where: { id: layawayId }, include: { location: true } });
  if (!found) throw notFound("Layaway");

  const prior = await prisma.payment.findMany({ where: { layawayId, raw: { path: ["idempotencyKey"], equals: input.idempotencyKey } }, orderBy: { createdAt: "asc" } });
  if (prior.length) return { layaway: await getLayaway(prisma, layawayId), payments: prior, changeCents: sumBy(prior, (p) => p.changeCents ?? 0), replayed: true };
  if (found.status !== "ACTIVE") throw stateError(found);

  const { location } = found;
  const splits = splitTenders(input.tenders, location, found.cardPriceBps);
  const balance = found.totalCents - found.paidCents;
  const applied = sumBy(splits, (s) => s.appliedCents);
  if (applied > balance) throw badRequest("OVERPAID", `Only ${formatCents(balance)} is owed on layaway #${found.number}`, { balanceCents: balance, appliedCents: applied });

  const drawer = await currentSession(prisma, location.id, input.terminalId);
  if (!drawer && location.requireDrawerSession && input.tenders.some((t) => t.type === "CASH")) throw drawerClosed();
  const terminals = await resolveTerminals(prisma, input.tenders, location.id);

  const undo = (approved: Approved[]) => voidLayawayCharges(ctx, layawayId, approved);
  const approved = await chargeCards(ctx, found, splits, input.idempotencyKey, terminals, undo);
  let rows: Payment[];
  try {
    rows = await prisma.$transaction(async (tx) => {
      await lockLayaway(tx, layawayId);
      const l = await tx.layaway.findUniqueOrThrow({ where: { id: layawayId } });
      if (l.status !== "ACTIVE") throw stateError(l);
      const posted = await postPayments(tx, l, splits, approved, { idempotencyKey: input.idempotencyKey, staffId: actor?.id, drawerSessionId: drawer?.id, deposit: false }, gateway.name);
      await audit(tx, {
        action: "LAYAWAY_PAYMENT",
        staffId: actor?.id,
        locationId: location.id,
        details: {
          layawayId,
          number: l.number,
          tenders: splits.map((s) => ({ tender: s.tender.type, amountCents: s.amountCents, appliedCents: s.appliedCents })),
          appliedCents: posted.applied,
          balanceCents: posted.updated.totalCents - posted.updated.paidCents,
        },
      });
      return posted.rows;
    });
  } catch (e) {
    await undo(approved);
    throw e;
  }
  return { layaway: await getLayaway(prisma, layawayId), payments: rows, changeCents: sumBy(splits, (s) => s.changeCents), replayed: false };
}

// ── Complete (pick up) ───────────────────────────────────────────

const orderInclude = { lines: true, payments: true } satisfies Prisma.OrderInclude;

/**
 * Paid in full: the customer picks the items up. Writes the sale (a PAID POS
 * order with the layaway's locked totals and lines), moves every layaway
 * payment onto it, and earns loyalty the way checkout does. Stock was reserved
 * at opening, so nothing moves here.
 */
export async function completeLayaway(ctx: Ctx, layawayId: string) {
  const { prisma, actor } = ctx;
  const orderId = await prisma.$transaction(async (tx) => {
    await lockLayaway(tx, layawayId);
    const l = await tx.layaway.findUnique({ where: { id: layawayId }, include: { lines: true, payments: true } });
    if (!l) throw notFound("Layaway");
    if (l.status !== "ACTIVE") throw stateError(l);
    const balance = l.totalCents - l.paidCents;
    if (balance > 0) throw conflict("BALANCE_DUE", `${formatCents(balance)} is still owed on layaway #${l.number}`, { balanceCents: balance });

    const program = await getProgram(tx);
    const variants = await tx.variant.findMany({ where: { id: { in: l.lines.map((x) => x.variantId) } }, select: { id: true, product: { select: { kind: true } } } });
    const earnsLoyalty = (x: { variantId: string }) => program.enabled && earns(program, variants.find((v) => v.id === x.variantId)!.product.kind);
    const order = await tx.order.create({
      data: {
        channel: "POS",
        status: "PAID",
        locationId: l.locationId,
        customerId: l.customerId,
        staffId: actor?.id,
        idempotencyKey: `layaway:${l.id}`,
        note: `Layaway #${l.number}`,
        subtotalCents: l.subtotalCents,
        discountCents: l.discountCents,
        taxCents: l.taxCents,
        totalCents: l.totalCents,
        cardAdjustmentCents: l.cardAdjustmentCents,
        cardAdjustmentTaxCents: l.cardAdjustmentTaxCents,
        cardPriceBps: l.cardPriceBps,
        // What paying the whole thing by card would have cost: the card price of the locked total.
        cardTotalCents: cardPrice(l.totalCents, l.cardPriceBps),
        appliedPromotions: l.appliedPromotions as unknown as Prisma.InputJsonValue,
        lines: {
          create: l.lines.map((x) => ({
            variantId: x.variantId,
            title: x.title,
            quantity: x.quantity,
            unitPriceCents: x.unitPriceCents,
            discountCents: x.discountCents,
            promoDiscountCents: x.promoDiscountCents,
            discountReasonId: x.discountReasonId,
            discountReason: x.discountReason,
            earnsLoyalty: earnsLoyalty(x),
            taxable: x.taxable,
            costCents: x.costCents,
          })),
        },
      },
    });
    await tx.payment.updateMany({ where: { layawayId: l.id }, data: { orderId: order.id } });

    // Loyalty, by checkout's rule: earn on the eligible lines, less the share paid with store credit.
    if (program.enabled) {
      const eligible = sumBy(l.lines, (x) => (earnsLoyalty(x) ? x.unitPriceCents * x.quantity - x.discountCents : 0));
      const creditPaid = sumBy(l.payments.filter((p) => p.tender === "STORE_CREDIT" && p.status === "APPROVED" && p.amountCents > 0), (p) => p.appliedCents ?? p.amountCents);
      const earned = earnFor(program, eligible, l.totalCents, creditPaid);
      await postLoyalty(tx, { customerId: l.customerId, unit: unitFor(program), amount: earned, reason: "Earned", orderId: order.id });
      await tx.order.update({ where: { id: order.id }, data: { loyaltyEarned: earned, loyaltyUnit: earned > 0 ? unitFor(program) : null, loyaltyEligibleCents: eligible } });
    }

    await tx.layaway.update({ where: { id: l.id }, data: { status: "COMPLETED", completedAt: new Date(), orderId: order.id } });
    await audit(tx, { action: "LAYAWAY_COMPLETED", staffId: actor?.id, locationId: l.locationId, details: { layawayId: l.id, number: l.number, orderId: order.id, orderNumber: order.number } });
    return order.id;
  });
  const [layaway, order] = await Promise.all([getLayaway(prisma, layawayId), prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude })]);
  return { layaway, order };
}

// ── Cancel ───────────────────────────────────────────────────────

export interface CancelInput {
  /** Everything back as store credit instead of the original tenders. */
  toStoreCredit: boolean;
  /** No cancellation fee (needs LAYAWAY_MANAGE; the route checks). */
  waiveFee: boolean;
  reason?: string;
  /** Register for the cash refund's drawer and card-present card refunds. */
  terminalId?: string;
}

export interface RefundLeg {
  tender: string;
  amountCents: number;
  status: "APPROVED" | "PENDING";
  message?: string;
}

export interface CancelResult {
  layaway: LayawayDetail;
  feeCents: number;
  refundedCents: number;
  legs: RefundLeg[];
}

/** The cancellation fee: the larger of the flat fee and the percentage of the total, never more than was applied to the balance. */
export function cancelFee(location: Pick<Location, "layawayCancelFeeCents" | "layawayCancelFeeBps">, l: Pick<Layaway, "totalCents" | "paidCents">): number {
  return Math.min(l.paidCents, Math.max(location.layawayCancelFeeCents, applyBps(l.totalCents, location.layawayCancelFeeBps)));
}

/**
 * Cancel: stock goes back on the shelf and what was collected (every payment,
 * card adjustments included) minus the fee goes back to the original tenders,
 * cards first, or all to store credit. Card refunds run after the commit;
 * one the processor rejects is recorded PENDING, never dropped.
 */
export async function cancelLayaway(ctx: Ctx, layawayId: string, input: CancelInput): Promise<CancelResult> {
  const { prisma, gateway, actor } = ctx;
  const committed = await prisma.$transaction(async (tx) => {
    await lockLayaway(tx, layawayId);
    const l = await tx.layaway.findUnique({ where: { id: layawayId }, include: { lines: true, payments: true, location: true } });
    if (!l) throw notFound("Layaway");
    if (l.status !== "ACTIVE") throw stateError(l);
    const drawer = await currentSession(tx, l.locationId, input.terminalId);
    const reason = `Layaway #${l.number} cancelled`;
    const staff = { staffId: actor?.id ?? null };

    const feeCents = input.waiveFee ? 0 : cancelFee(l.location, l);
    const originals = l.payments.filter((p) => p.amountCents > 0 && p.status === "APPROVED").sort((a, b) => REFUND_ORDER.indexOf(a.tender) - REFUND_ORDER.indexOf(b.tender));
    const refundCents = Math.max(0, sumBy(originals, (p) => p.amountCents) - feeCents);

    const legs: RefundLeg[] = [];
    const cardLegs: { payment: Payment; amountCents: number }[] = [];
    if (input.toStoreCredit) {
      if (refundCents > 0) {
        await postCredit(tx, { customerId: l.customerId, amountCents: refundCents, reason });
        await tx.payment.create({ data: { layawayId: l.id, amountCents: -refundCents, tender: "STORE_CREDIT", status: "APPROVED", drawerSessionId: drawer?.id, raw: staff } });
        legs.push({ tender: "STORE_CREDIT", amountCents: refundCents, status: "APPROVED" });
      }
    } else {
      let left = refundCents;
      for (const p of originals) {
        if (left === 0) break;
        const take = Math.min(left, p.amountCents);
        left -= take;
        if (p.tender === "CARD") {
          cardLegs.push({ payment: p, amountCents: take });
          continue;
        }
        if (p.tender === "CASH" && !drawer && l.location.requireDrawerSession) throw drawerClosed();
        if (p.tender === "STORE_CREDIT") await postCredit(tx, { customerId: l.customerId, amountCents: take, reason });
        await tx.payment.create({ data: { layawayId: l.id, amountCents: -take, tender: p.tender, status: "APPROVED", refundOfId: p.id, drawerSessionId: drawer?.id, raw: staff } });
        legs.push({ tender: p.tender, amountCents: take, status: "APPROVED" });
      }
    }

    for (const line of l.lines) {
      await moveInventory(tx, { variantId: line.variantId, locationId: l.locationId, delta: line.quantity, reason: "LAYAWAY_RETURN", note: reason, staffId: actor?.id });
    }
    await tx.layaway.update({
      where: { id: l.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: actor?.id, cancelFeeCents: feeCents, refundedCents: refundCents, cancelReason: input.reason },
    });
    return { feeCents, refundCents, legs, cardLegs, locationId: l.locationId, drawerSessionId: drawer?.id, staff };
  });

  for (const { payment, amountCents } of committed.cardLegs) {
    const terminal = await followUpTerminal(prisma, committed.locationId, input.terminalId, payment.terminalId);
    const r = await gateway
      .refund(payment.gatewayRef!, amountCents, { cardLast4: payment.cardLast4 ?? undefined, terminal, gateway: payment.gateway ?? undefined })
      .catch((e: unknown): GatewayResult => ({ approved: false, message: e instanceof Error ? e.message : "Gateway error" }));
    await prisma.payment.create({
      data: {
        layawayId,
        amountCents: -amountCents,
        tender: "CARD",
        status: r.approved ? "APPROVED" : "PENDING",
        gateway: r.gateway ?? payment.gateway,
        gatewayRef: r.gatewayRef ?? payment.gatewayRef,
        cardLast4: payment.cardLast4,
        terminalId: terminal?.id,
        drawerSessionId: committed.drawerSessionId,
        refundOfId: payment.id,
        raw: { ...committed.staff, ...(r.message ? { message: r.message } : {}) },
      },
    });
    committed.legs.push({ tender: "CARD", amountCents, status: r.approved ? "APPROVED" : "PENDING", ...(r.message ? { message: r.message } : {}) });
  }
  return { layaway: await getLayaway(prisma, layawayId), feeCents: committed.feeCents, refundedCents: committed.refundCents, legs: committed.legs };
}

// ── Manage ───────────────────────────────────────────────────────

export async function extendLayaway(ctx: Ctx, layawayId: string, dueAt: Date): Promise<LayawayDetail> {
  const { prisma, actor } = ctx;
  if (dueAt <= new Date()) throw badRequest("DUE_DATE", "The new due date has to be in the future");
  await prisma.$transaction(async (tx) => {
    await lockLayaway(tx, layawayId);
    const l = await tx.layaway.findUnique({ where: { id: layawayId } });
    if (!l) throw notFound("Layaway");
    if (l.status !== "ACTIVE") throw stateError(l);
    await tx.layaway.update({ where: { id: l.id }, data: { dueAt } });
    await audit(tx, { action: "LAYAWAY_EXTENDED", staffId: actor?.id, locationId: l.locationId, details: { layawayId: l.id, number: l.number, from: l.dueAt.toISOString(), to: dueAt.toISOString() } });
  });
  return getLayaway(prisma, layawayId);
}

export async function updateLayaway(ctx: Ctx, layawayId: string, data: { notes?: string | null }): Promise<LayawayDetail> {
  const { prisma, actor } = ctx;
  const before = await prisma.layaway.findUnique({ where: { id: layawayId } });
  if (!before) throw notFound("Layaway");
  const diff = changes(before, data);
  if (Object.keys(diff).length) {
    await prisma.layaway.update({ where: { id: layawayId }, data });
    await audit(prisma, { action: "LAYAWAY_UPDATED", staffId: actor?.id, locationId: before.locationId, details: { layawayId, number: before.number, changes: diff } });
  }
  return getLayaway(prisma, layawayId);
}

// ── Read ─────────────────────────────────────────────────────────

const customerSelect = { select: { id: true, name: true, email: true, phone: true } } as const;
const detailInclude = {
  lines: true,
  payments: { orderBy: { createdAt: "asc" } },
  customer: customerSelect,
  location: { select: { name: true, layawayCancelFeeCents: true, layawayCancelFeeBps: true } },
} satisfies Prisma.LayawayInclude;
type LayawayWithDetails = Prisma.LayawayGetPayload<{ include: typeof detailInclude }>;

type Named = { id: string; name: string } | null;
const isOverdue = (l: Pick<Layaway, "status" | "dueAt">, now = new Date()) => l.status === "ACTIVE" && l.dueAt < now;
/** Who took a payment (kept in the row's `raw`, since payments have no staff column). */
const paymentStaffId = (p: Pick<Payment, "raw">): string | null =>
  p.raw && typeof p.raw === "object" && !Array.isArray(p.raw) && typeof p.raw.staffId === "string" ? p.raw.staffId : null;

async function staffNames(db: Db, ids: (string | null | undefined)[]): Promise<(id: string | null | undefined) => Named> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = wanted.length ? await db.staff.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } }) : [];
  return (id) => (id ? (rows.find((s) => s.id === id) ?? null) : null);
}

/** Running figures every view of a layaway shows. */
function figures(l: Pick<Layaway, "status" | "dueAt" | "totalCents" | "paidCents" | "cardPriceBps">) {
  const balanceCents = l.totalCents - l.paidCents;
  return {
    balanceCents,
    /** What to charge a card to pay the balance off (the balance at the card price). */
    cardBalanceCents: cardPrice(balanceCents, l.cardPriceBps),
    overdue: isOverdue(l),
  };
}

export type LayawayDetail = Awaited<ReturnType<typeof getLayaway>>;

/** One layaway with its lines, payments (with who took them), customer, balance and the fee a cancellation would cost now. */
export async function getLayaway(db: Db, id: string) {
  const l = await db.layaway.findUnique({ where: { id }, include: detailInclude });
  if (!l) throw notFound("Layaway");
  const [who, variants] = await Promise.all([
    staffNames(db, [l.staffId, l.cancelledById, ...l.payments.map(paymentStaffId)]),
    db.variant.findMany({ where: { id: { in: l.lines.map((x) => x.variantId) } }, select: { id: true, sku: true, imageUrl: true, product: { select: { title: true, imageUrl: true } } } }),
  ]);
  const { location, ...rest } = l;
  const collected = sumBy(l.payments.filter((p) => p.amountCents > 0 && p.status === "APPROVED"), (p) => p.amountCents);
  const feeCents = cancelFee(location, l);
  return {
    ...rest,
    ...figures(l),
    staff: who(l.staffId),
    cancelledBy: who(l.cancelledById),
    lines: l.lines.map((x) => {
      const { id: _id, ...variant } = variants.find((v) => v.id === x.variantId) ?? { id: x.variantId, sku: "", imageUrl: null, product: { title: x.title, imageUrl: null } };
      return { ...x, variant };
    }),
    payments: l.payments.map((p) => ({ ...p, staff: who(paymentStaffId(p)) })),
    cancelFeePreview: l.status === "ACTIVE" ? { feeCents, refundCents: Math.max(0, collected - feeCents) } : null,
  };
}

export interface ListQuery {
  locationId?: string;
  customerId?: string;
  status?: LayawayStatus;
  /** Only active layaways past their due date. */
  overdue?: boolean;
  /** A layaway number ("#12" or "12") or part of the customer's name or email. */
  q?: string;
  take: number;
}

/** Layaways, newest first. */
export async function listLayaways(db: Db, q: ListQuery) {
  const number = q.q && /^#?\d+$/.test(q.q) ? Number(q.q.replace("#", "")) : undefined;
  const where: Prisma.LayawayWhereInput = {
    locationId: q.locationId,
    customerId: q.customerId,
    status: q.overdue ? "ACTIVE" : q.status,
    ...(q.overdue ? { dueAt: { lt: new Date() } } : {}),
    ...(number !== undefined
      ? { number }
      : q.q
        ? { customer: { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { email: { contains: q.q, mode: "insensitive" } }] } }
        : {}),
  };
  const rows = await db.layaway.findMany({ where, orderBy: [{ createdAt: "desc" }, { number: "desc" }], take: q.take, include: { customer: customerSelect, _count: { select: { lines: true } } } });
  const who = await staffNames(db, rows.map((l) => l.staffId));
  return rows.map(({ _count, ...l }) => ({ ...l, ...figures(l), staff: who(l.staffId), lineCount: _count.lines }));
}

// ── Statement ────────────────────────────────────────────────────

export interface LayawayStatement {
  store: { name: string; header: string | null; footer: string | null; address: string | null; phone: string | null };
  number: number;
  status: LayawayStatus;
  createdAt: Date;
  dueAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  /** Sale number once picked up. */
  orderNumber: number | null;
  cashier: string | null;
  customer: { name: string; email: string | null; phone: string | null };
  lines: { title: string; quantity: number; unitCents: number; discountCents: number; totalCents: number }[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  promotions: { name: string; discountCents: number }[];
  payments: { at: Date; label: string; amountCents: number; appliedCents: number; detail?: string; deposit: boolean; staff: string | null }[];
  /** Applied to the balance so far. */
  paidCents: number;
  /** Extra collected on card-priced payments (not part of the balance). */
  cardAdjustmentCents: number;
  balanceCents: number;
  /** The balance at the card price, when dual pricing is on. */
  cardBalanceCents: number;
  dualPricing: { percent: string } | null;
  cancelFeeCents: number;
  refundedCents: number;
  /** The store's layaway terms, one sentence each. */
  terms: string[];
}

export async function buildLayawayStatement(db: Db, id: string): Promise<LayawayStatement> {
  const l = await db.layaway.findUnique({ where: { id }, include: { lines: true, payments: { orderBy: { createdAt: "asc" } }, customer: true, location: true } });
  if (!l) throw notFound("Layaway");
  const [who, order] = await Promise.all([staffNames(db, [l.staffId, ...l.payments.map(paymentStaffId)]), l.orderId ? db.order.findUnique({ where: { id: l.orderId }, select: { number: true } }) : null]);
  const { location } = l;
  const { balanceCents, cardBalanceCents } = figures(l);
  const when = (d: Date) => d.toLocaleDateString("en-US", { timeZone: location.timezone, month: "short", day: "numeric", year: "numeric" });
  const fee = { flat: location.layawayCancelFeeCents, bps: location.layawayCancelFeeBps };
  const feeText =
    fee.flat > 0 && fee.bps > 0
      ? `the larger of ${formatCents(fee.flat)} or ${formatBps(fee.bps)} of the total`
      : fee.flat > 0
        ? formatCents(fee.flat)
        : fee.bps > 0
          ? `${formatBps(fee.bps)} of the total`
          : null;
  const terms: string[] = [];
  if (l.status === "ACTIVE") {
    terms.push(`Balance of ${formatCents(balanceCents)} is due by ${when(l.dueAt)}.`, "Your items are held at the store until the balance is paid in full.");
    if (l.cardPriceBps > 0) terms.push(`Card payments are priced ${formatBps(l.cardPriceBps)} higher than cash.`);
    terms.push(feeText ? `If the layaway is cancelled, a fee of ${feeText} is kept and the rest is refunded.` : "If the layaway is cancelled, everything paid is refunded.");
  } else if (l.status === "COMPLETED") {
    terms.push(`Paid in full and picked up on ${when(l.completedAt ?? l.updatedAt)}${order ? ` (sale #${order.number})` : ""}.`);
  } else {
    terms.push(`Cancelled on ${when(l.cancelledAt ?? l.updatedAt)}.${l.cancelFeeCents ? ` Cancellation fee ${formatCents(l.cancelFeeCents)}.` : ""} Refunded ${formatCents(l.refundedCents)}.`);
  }
  const taken = l.payments.filter((p) => p.status === "APPROVED" && p.amountCents > 0);
  return {
    store: { name: location.name, header: location.receiptHeader, footer: location.receiptFooter, address: location.address, phone: location.phone },
    number: l.number,
    status: l.status,
    createdAt: l.createdAt,
    dueAt: l.dueAt,
    completedAt: l.completedAt,
    cancelledAt: l.cancelledAt,
    orderNumber: order?.number ?? null,
    cashier: who(l.staffId)?.name ?? null,
    customer: { name: l.customer.name, email: l.customer.email, phone: l.customer.phone },
    lines: l.lines.map((x) => ({ title: x.title, quantity: x.quantity, unitCents: x.unitPriceCents, discountCents: x.discountCents, totalCents: x.unitPriceCents * x.quantity - x.discountCents })),
    subtotalCents: l.subtotalCents,
    discountCents: l.discountCents,
    taxCents: l.taxCents,
    totalCents: l.totalCents,
    promotions: ((l.appliedPromotions as { name: string; discountCents: number }[] | null) ?? []).map((a) => ({ name: a.name, discountCents: a.discountCents })),
    payments: taken.map((p) => ({
      at: p.createdAt,
      label: TENDER_LABELS[p.tender] ?? p.tender,
      amountCents: p.amountCents,
      appliedCents: p.appliedCents ?? p.amountCents,
      detail: p.cardLast4 ? `${p.cardBrand ?? "Card"} •••• ${p.cardLast4}` : undefined,
      deposit: !!(p.raw && typeof p.raw === "object" && !Array.isArray(p.raw) && p.raw.deposit === true),
      staff: who(paymentStaffId(p))?.name ?? null,
    })),
    paidCents: l.paidCents,
    cardAdjustmentCents: l.cardAdjustmentCents,
    balanceCents,
    cardBalanceCents,
    dualPricing: l.cardPriceBps > 0 ? { percent: formatBps(l.cardPriceBps) } : null,
    cancelFeeCents: l.cancelFeeCents,
    refundedCents: l.refundedCents,
    terms,
  };
}

// ── Report ───────────────────────────────────────────────────────

export interface LayawayReportRow {
  id: string;
  number: number;
  customerId: string;
  customer: string;
  email: string | null;
  phone: string | null;
  lines: number;
  totalCents: number;
  paidCents: number;
  /** Everything collected, card adjustments included. */
  collectedCents: number;
  balanceCents: number;
  openedAt: Date;
  dueAt: Date;
  overdue: boolean;
  daysOverdue: number;
}

/** Active layaways: what's still owed, what's being held, and who's late. */
export async function layawayReport(db: Db, locationId?: string, now = new Date()) {
  const active = await db.layaway.findMany({
    where: { status: "ACTIVE", ...(locationId ? { locationId } : {}) },
    orderBy: [{ dueAt: "asc" }, { number: "asc" }],
    include: { customer: customerSelect, _count: { select: { lines: true } } },
  });
  const rows: LayawayReportRow[] = active.map((l) => ({
    id: l.id,
    number: l.number,
    customerId: l.customerId,
    customer: l.customer.name,
    email: l.customer.email,
    phone: l.customer.phone,
    lines: l._count.lines,
    totalCents: l.totalCents,
    paidCents: l.paidCents,
    collectedCents: l.paidCents + l.cardAdjustmentCents,
    balanceCents: l.totalCents - l.paidCents,
    openedAt: l.createdAt,
    dueAt: l.dueAt,
    overdue: isOverdue(l, now),
    daysOverdue: isOverdue(l, now) ? Math.floor((now.getTime() - l.dueAt.getTime()) / 86_400_000) : 0,
  }));
  return {
    active: rows.length,
    overdue: rows.filter((r) => r.overdue).length,
    balanceCents: sumBy(rows, (r) => r.balanceCents),
    heldCents: sumBy(rows, (r) => r.collectedCents),
    rows,
  };
}
