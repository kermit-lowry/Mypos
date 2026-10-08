import type { z } from "zod";
import type { PreorderInput, PreorderProductInput, TenderInput } from "@mypos/shared";
import { badRequest, conflict, notFound, paymentFailed } from "../errors.js";
import { config } from "../config.js";
import type { GatewayResult } from "../payments/gateway.js";
import { followUpTerminal, recordUnknownCharge, resolveTerminal, voidCharges, type Charge } from "./charges.js";
import { checkout } from "./checkout.js";
import type { Ctx } from "./context.js";
import { postCredit } from "./storeCredit.js";

const DEPOSIT_TENDERS = new Set(["CARD", "CASH", "STORE_CREDIT"]);

export async function createPreorderProduct(ctx: Ctx, input: z.infer<typeof PreorderProductInput>) {
  return ctx.prisma.preorderProduct.create({ data: input });
}

export async function preorderAvailability(ctx: Ctx, preorderProductId: string) {
  const pp = await ctx.prisma.preorderProduct.findUnique({ where: { id: preorderProductId } });
  if (!pp) throw notFound("Preorder product");
  const agg = await ctx.prisma.preorder.aggregate({
    where: { preorderProductId, status: { in: ["RESERVED", "FULFILLED"] } },
    _sum: { quantity: true },
  });
  const claimed = agg._sum.quantity ?? 0;
  return { ...pp, claimed, remaining: pp.allocation === null ? null : pp.allocation - claimed };
}

/** Reserve units against the allocation and collect the deposit. */
export async function placePreorder(ctx: Ctx, input: PreorderInput) {
  const { prisma, gateway, actor } = ctx;
  const existing = await prisma.preorder.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { payments: true } });
  if (existing) return existing;

  for (const t of input.tenders) {
    if (!DEPOSIT_TENDERS.has(t.type)) throw badRequest("TENDER_NOT_ALLOWED", `${t.type} not accepted for deposits`);
    if (t.type === "CASH" && !actor) throw badRequest("TENDER_NOT_ALLOWED", "Cash deposits are register-only");
  }

  const preorder = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PreorderProduct" WHERE id = ${input.preorderProductId} FOR UPDATE`;
    const pp = await tx.preorderProduct.findUnique({ where: { id: input.preorderProductId } });
    if (!pp) throw notFound("Preorder product");
    if (pp.releaseDate <= new Date()) throw conflict("RELEASED", "This product has released; sell it normally");

    const deposit = pp.depositCents * input.quantity;
    const tendered = input.tenders.reduce((a, t) => a + t.amountCents, 0);
    if (tendered !== deposit) throw badRequest("TENDER_MISMATCH", "Tenders must equal the deposit", { depositCents: deposit });

    const active = { preorderProductId: pp.id, status: { in: ["RESERVED", "FULFILLED"] as ("RESERVED" | "FULFILLED")[] } };
    if (pp.allocation !== null) {
      const claimed = (await tx.preorder.aggregate({ where: active, _sum: { quantity: true } }))._sum.quantity ?? 0;
      if (claimed + input.quantity > pp.allocation) {
        throw conflict("ALLOCATION_EXHAUSTED", "Not enough allocation left", { remaining: pp.allocation - claimed });
      }
    }
    if (pp.perCustomerLimit !== null) {
      const mine = (await tx.preorder.aggregate({ where: { ...active, customerId: input.customerId }, _sum: { quantity: true } }))._sum.quantity ?? 0;
      if (mine + input.quantity > pp.perCustomerLimit) throw conflict("CUSTOMER_LIMIT", `Limit ${pp.perCustomerLimit} per customer`);
    }
    return tx.preorder.create({
      data: {
        preorderProductId: pp.id,
        customerId: input.customerId,
        locationId: input.locationId,
        quantity: input.quantity,
        depositPaidCents: 0,
        idempotencyKey: input.idempotencyKey,
      },
    });
  });

  const approved: (Charge & { tender: TenderInput })[] = [];
  const link = { preorderId: preorder.id };
  const undo = async () => {
    await voidCharges(ctx, link, approved);
    await prisma.preorder.update({ where: { id: preorder.id }, data: { status: "CANCELLED" } });
  };

  for (const [i, t] of input.tenders.entries()) {
    if (t.type !== "CARD") continue;
    const terminal = t.terminalId ? await resolveTerminal(prisma, t.terminalId, input.locationId).catch(async (e) => {
      await undo();
      throw e;
    }) : undefined;
    const result = await gateway
      .sale({
        amountCents: t.amountCents,
        currency: config.currency,
        paymentToken: t.paymentToken,
        terminal,
        orderRef: `PRE-${preorder.id}`,
        idempotencyKey: `${input.idempotencyKey}:${i}`,
      })
      .catch((e: unknown): GatewayResult => ({ approved: false, pending: true, message: e instanceof Error ? e.message : "Gateway error" }));
    if (result.pending) {
      await undo();
      throw await recordUnknownCharge(ctx, link, { result, amountCents: t.amountCents, terminal });
    }
    if (!result.approved) {
      await undo();
      throw paymentFailed(result.message ?? "Card declined");
    }
    approved.push({ tender: t, result, amountCents: t.amountCents, terminal });
  }

  try {
    return await prisma.$transaction(async (tx) => {
      for (const t of input.tenders) {
        const charge = approved.find((a) => a.tender === t);
        const card = charge?.result;
        if (t.type === "STORE_CREDIT") {
          await postCredit(tx, { customerId: input.customerId, amountCents: -t.amountCents, reason: "Preorder deposit" });
        }
        await tx.payment.create({
          data: {
            preorderId: preorder.id,
            amountCents: t.amountCents,
            tender: t.type,
            status: "APPROVED",
            gateway: card ? (card.gateway ?? gateway.name) : null,
            terminalId: charge?.terminal?.id,
            gatewayRef: card?.gatewayRef,
            cardBrand: card?.cardBrand,
            cardLast4: card?.cardLast4,
          },
        });
      }
      return tx.preorder.update({
        where: { id: preorder.id },
        data: { depositPaidCents: input.tenders.reduce((a, t) => a + t.amountCents, 0) },
        include: { payments: true },
      });
    });
  } catch (e) {
    await undo();
    throw e;
  }
}

/** Customer picks up: ring up the product with the deposit applied, collecting the balance. */
export async function fulfillPreorder(
  ctx: Ctx,
  preorderId: string,
  input: { locationId: string; tenders: TenderInput[]; idempotencyKey: string },
) {
  const pre = await ctx.prisma.preorder.findUnique({ where: { id: preorderId }, include: { preorderProduct: true } });
  if (!pre) throw notFound("Preorder");
  if (pre.status !== "RESERVED") throw conflict("PREORDER_STATE", `Preorder is ${pre.status}`);
  return checkout(
    ctx,
    {
      locationId: input.locationId,
      channel: "POS",
      customerId: pre.customerId,
      lines: [{ variantId: pre.preorderProduct.variantId, quantity: pre.quantity, discountCents: 0 }],
      tenders: input.tenders,
      idempotencyKey: input.idempotencyKey,
      rewardIds: [],
    },
    { preorder: { id: pre.id, depositCents: pre.depositPaidCents } },
  );
}

/** Cancel and return the deposit to store credit or the original card. */
export async function cancelPreorder(ctx: Ctx, preorderId: string, toStoreCredit: boolean, terminalId?: string) {
  const { prisma, gateway } = ctx;
  const { cards: cardRefunds, locationId } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Preorder" WHERE id = ${preorderId} FOR UPDATE`;
    const pre = await tx.preorder.findUnique({ where: { id: preorderId }, include: { payments: true } });
    if (!pre) throw notFound("Preorder");
    if (pre.status !== "RESERVED") throw conflict("PREORDER_STATE", `Preorder is ${pre.status}`);
    await tx.preorder.update({ where: { id: pre.id }, data: { status: "CANCELLED" } });

    const cards = [];
    for (const p of pre.payments.filter((p) => p.amountCents > 0 && p.status === "APPROVED")) {
      if (p.tender === "CARD" && !toStoreCredit) {
        cards.push(p);
        continue;
      }
      if (p.tender === "STORE_CREDIT" || toStoreCredit) {
        await postCredit(tx, { customerId: pre.customerId, amountCents: p.amountCents, reason: "Preorder cancelled" });
      }
      // Cash deposits are handed back from the drawer.
      await tx.payment.create({
        data: { preorderId: pre.id, amountCents: -p.amountCents, tender: toStoreCredit ? "STORE_CREDIT" : p.tender, status: "APPROVED", refundOfId: p.id },
      });
    }
    return { cards, locationId: pre.locationId };
  });

  for (const p of cardRefunds) {
    const terminal = await followUpTerminal(prisma, locationId, terminalId, p.terminalId);
    const r = await gateway
      .refund(p.gatewayRef!, p.amountCents, { cardLast4: p.cardLast4 ?? undefined, terminal, gateway: p.gateway ?? undefined })
      .catch((e: unknown): GatewayResult => ({ approved: false, message: e instanceof Error ? e.message : "Gateway error" }));
    await prisma.payment.create({
      data: {
        preorderId,
        amountCents: -p.amountCents,
        tender: "CARD",
        status: r.approved ? "APPROVED" : "PENDING",
        gateway: r.gateway ?? p.gateway,
        gatewayRef: r.gatewayRef ?? p.gatewayRef,
        terminalId: terminal?.id,
        refundOfId: p.id,
        raw: r.message ? { message: r.message } : undefined,
      },
    });
  }
  return prisma.preorder.findUniqueOrThrow({ where: { id: preorderId }, include: { payments: true } });
}
