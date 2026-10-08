import { buylistOffer, DEFAULT_BUYLIST_RULE, type BuylistAcceptInput, type BuylistQuoteInput, type BuylistRule } from "@mypos/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import { describeVariant } from "./checkout.js";
import type { Ctx } from "./context.js";
import { moveInventory, receiveCost } from "./inventory.js";
import { postCredit } from "./storeCredit.js";

/** Build a quote. Nothing moves until the customer accepts it. */
export async function quoteBuylist(ctx: Ctx, input: BuylistQuoteInput, rule: BuylistRule = DEFAULT_BUYLIST_RULE) {
  const { prisma, actor } = ctx;
  const variantIds = input.lines.flatMap((l) => (l.variantId ? [l.variantId] : []));
  const variants = await prisma.variant.findMany({ where: { id: { in: variantIds } }, include: { product: true } });
  const byId = new Map(variants.map((v) => [v.id, v]));

  const lines = input.lines.map((l) => {
    const v = l.variantId ? byId.get(l.variantId) : undefined;
    if (l.variantId && !v) throw notFound(`Variant ${l.variantId}`);
    if (!v && !l.description) throw badRequest("DESCRIPTION_REQUIRED", "Uncataloged items need a description");
    const offer = buylistOffer(l.marketCents, rule);
    return {
      variantId: v?.id,
      description: v ? describeVariant(v.product.title, v) : l.description!,
      quantity: l.quantity,
      marketCents: l.marketCents,
      cashOfferCents: l.cashOfferCents ?? offer.cashCents,
      creditOfferCents: l.creditOfferCents ?? offer.creditCents,
    };
  });

  return prisma.buylistTicket.create({
    data: {
      locationId: input.locationId,
      customerId: input.customerId,
      staffId: actor?.id,
      cashTotalCents: lines.reduce((a, l) => a + l.cashOfferCents * l.quantity, 0),
      creditTotalCents: lines.reduce((a, l) => a + l.creditOfferCents * l.quantity, 0),
      lines: { create: lines },
    },
    include: { lines: true },
  });
}

/** Customer accepts: pay out cash or credit, and receive the goods into stock at the offer as cost. */
export async function acceptBuylist(ctx: Ctx, ticketId: string, input: BuylistAcceptInput) {
  const { prisma, actor } = ctx;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BuylistTicket" WHERE id = ${ticketId} FOR UPDATE`;
    const ticket = await tx.buylistTicket.findUnique({ where: { id: ticketId }, include: { lines: true } });
    if (!ticket) throw notFound("Buylist ticket");
    if (ticket.status !== "QUOTED") throw conflict("TICKET_CLOSED", `Ticket is ${ticket.status}`);

    const customerId = input.customerId ?? ticket.customerId ?? undefined;
    if (input.payout === "STORE_CREDIT" && !customerId) throw badRequest("CUSTOMER_REQUIRED", "Store credit payouts need a customer");

    const paid = input.payout === "CASH" ? ticket.cashTotalCents : ticket.creditTotalCents;
    if (input.payout === "STORE_CREDIT") {
      await postCredit(tx, { customerId: customerId!, amountCents: paid, reason: `Buylist #${ticket.number}`, buylistId: ticket.id });
    }

    for (const l of ticket.lines) {
      if (!l.variantId) continue; // Uncataloged lines are received manually once cataloged.
      const unitCost = input.payout === "CASH" ? l.cashOfferCents : l.creditOfferCents;
      await receiveCost(tx, l.variantId, l.quantity, unitCost);
      await moveInventory(tx, {
        variantId: l.variantId,
        locationId: ticket.locationId,
        delta: l.quantity,
        reason: "BUYLIST",
        buylistId: ticket.id,
        staffId: actor?.id,
      });
    }

    return tx.buylistTicket.update({
      where: { id: ticket.id },
      data: {
        status: "ACCEPTED",
        payout: input.payout,
        paidCents: paid,
        customerId,
        sellerIdType: input.sellerIdType,
        sellerIdLast4: input.sellerIdLast4,
        acceptedAt: new Date(),
      },
      include: { lines: true },
    });
  });
}

export async function rejectBuylist(ctx: Ctx, ticketId: string) {
  const updated = await ctx.prisma.buylistTicket.updateMany({ where: { id: ticketId, status: "QUOTED" }, data: { status: "REJECTED" } });
  if (updated.count === 0) throw conflict("TICKET_CLOSED", "Ticket is not open");
}
