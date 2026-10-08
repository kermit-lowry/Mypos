import type { BuylistPolicy, Prisma } from "@prisma/client";
import { DEFAULT_BUYLIST_POLICY, suggestOffer, type BuylistAcceptInput, type BuylistLineInput, type BuylistPolicyRule, type BuylistQuoteInput, type OfferSuggestion } from "@mypos/shared";
import type { Db } from "../db.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { marketTrends } from "../pricing/trends.js";
import { describeVariant } from "./checkout.js";
import type { Ctx } from "./context.js";
import { moveInventory, receiveCost } from "./inventory.js";
import { categoryLineage } from "./promotions.js";
import { postCredit } from "./storeCredit.js";

const toRule = (p: BuylistPolicy): BuylistPolicyRule => ({
  cashMarginBps: p.cashMarginBps,
  creditBonusBps: p.creditBonusBps,
  trendWeightBps: p.trendWeightBps,
  maxTrendUpBps: p.maxTrendUpBps,
  overstockQty: p.overstockQty,
  overstockCutBps: p.overstockCutBps,
  minResaleCents: p.minResaleCents,
});

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export interface SuggestedLine {
  variantId?: string;
  description: string;
  quantity: number;
  /** The resale figure used (market, your price, or entered). */
  marketCents: number;
  suggestion: OfferSuggestion;
  /** The catalog's own resale figure; null for items not in the catalog. */
  catalogResaleCents: number | null;
  /**
   * The offer from the catalog figure alone, ignoring anything typed at the
   * counter. Offers above this need BUYLIST_OVERRIDE. Same as `suggestion`
   * for uncatalogued items.
   */
  catalogSuggestion: OfferSuggestion;
}

/** A quote line that went past what the catalog supports (for the activity log). */
export type OverrideLine = {
  variantId: string | null;
  description: string;
  catalogResaleCents: number | null;
  enteredResaleCents: number | null;
  suggestedCashCents: number;
  cashOfferCents: number;
  suggestedCreditCents: number;
  creditOfferCents: number;
};

/** Suggested offers for what a customer brought in, from the store's trade-in rules. */
export async function suggestLines(db: Db, locationId: string, lines: Pick<BuylistLineInput, "variantId" | "description" | "quantity" | "marketCents">[]): Promise<SuggestedLine[]> {
  const variantIds = lines.flatMap((l) => (l.variantId ? [l.variantId] : []));
  const [variants, policies, lineage, trends, levels] = await Promise.all([
    db.variant.findMany({ where: { id: { in: variantIds } }, include: { product: true } }),
    db.buylistPolicy.findMany(),
    categoryLineage(db),
    marketTrends(db, variantIds),
    db.inventoryLevel.findMany({ where: { variantId: { in: variantIds }, locationId } }),
  ]);
  const ruleFor = (kind: string | null, categoryId: string | null): BuylistPolicyRule => {
    // Most specific category first, then product type, then the store default.
    for (const c of categoryId ? (lineage.get(categoryId) ?? []) : []) {
      const p = policies.find((x) => x.categoryId === c);
      if (p) return toRule(p);
    }
    const byKind = kind ? policies.find((x) => x.kind === kind && !x.categoryId) : undefined;
    const fallback = policies.find((x) => !x.kind && !x.categoryId);
    return byKind ? toRule(byKind) : fallback ? toRule(fallback) : DEFAULT_BUYLIST_POLICY;
  };

  return lines.map((l) => {
    const v = l.variantId ? variants.find((x) => x.id === l.variantId) : undefined;
    if (l.variantId && !v) throw notFound(`Variant ${l.variantId}`);
    if (!v && !l.description) throw badRequest("DESCRIPTION_REQUIRED", "Items not in the catalog need a description");
    if (!v && l.marketCents == null) throw badRequest("RESALE_REQUIRED", `Enter what "${l.description}" resells for`);
    const rule = ruleFor(v?.product.kind ?? null, v?.product.categoryId ?? null);
    const catalog = {
      priceCents: v?.priceCents ?? null,
      marketCents: v?.marketCents ?? null,
      trendBps: v ? (trends.get(v.id)?.changeBps ?? null) : null,
      onHand: v ? (levels.find((x) => x.variantId === v.id)?.onHand ?? 0) : 0,
    };
    // A figure typed at the counter overrides the catalog's for this ticket...
    const suggestion = suggestOffer({ ...catalog, enteredCents: l.marketCents ?? null }, rule);
    // ...but the catalog's own figure is what offers are checked against, so
    // typing a bigger "Resells $" can't raise the offer without BUYLIST_OVERRIDE.
    const catalogSuggestion = v && (v.priceCents != null || v.marketCents != null) ? suggestOffer({ ...catalog, enteredCents: null }, rule) : suggestion;
    return {
      variantId: v?.id,
      description: v ? describeVariant(v.product.title, v) : l.description!,
      quantity: l.quantity,
      marketCents: suggestion.resaleCents,
      suggestion,
      catalogResaleCents: v ? catalogSuggestion.resaleCents : null,
      catalogSuggestion,
    };
  });
}

/**
 * Build a quote. Offers default to the suggestion; an employee may change
 * them, but going above what the catalog figure supports (a bigger offer, or
 * a bigger "Resells $") needs BUYLIST_OVERRIDE (checked by `authorizeOverride`).
 * Returns the lines that needed it so the route can log them with the
 * approver. Nothing moves until the customer accepts.
 */
export async function quoteBuylist(ctx: Ctx, input: BuylistQuoteInput, authorizeOverride: () => Promise<void> = async () => undefined) {
  const { prisma, actor } = ctx;
  const suggested = await suggestLines(prisma, input.locationId, input.lines);
  const overrides: OverrideLine[] = [];
  const lines = suggested.map((s, i) => {
    const l = input.lines[i]!;
    const entered = l.marketCents ?? null;
    const line = {
      variantId: s.variantId,
      description: s.description,
      quantity: s.quantity,
      marketCents: s.marketCents,
      cashOfferCents: l.cashOfferCents ?? s.suggestion.cashCents,
      creditOfferCents: l.creditOfferCents ?? s.suggestion.creditCents,
      suggestedCashCents: s.catalogSuggestion.cashCents,
      suggestedCreditCents: s.catalogSuggestion.creditCents,
      offerNotes:
        s.catalogResaleCents != null && entered != null && entered !== s.catalogResaleCents
          ? [...s.suggestion.notes, `Resale entered ${money(entered)} (catalog ${money(s.catalogResaleCents)})`]
          : s.suggestion.notes,
    };
    const over =
      line.cashOfferCents > line.suggestedCashCents ||
      line.creditOfferCents > line.suggestedCreditCents ||
      (s.catalogResaleCents != null && (entered ?? 0) > s.catalogResaleCents);
    if (over) {
      overrides.push({
        variantId: s.variantId ?? null,
        description: s.description,
        catalogResaleCents: s.catalogResaleCents,
        enteredResaleCents: entered,
        suggestedCashCents: line.suggestedCashCents,
        cashOfferCents: line.cashOfferCents,
        suggestedCreditCents: line.suggestedCreditCents,
        creditOfferCents: line.creditOfferCents,
      });
    }
    return line;
  });
  if (overrides.length) await authorizeOverride();

  const ticket = await prisma.buylistTicket.create({
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
  return { ticket, overrides };
}

/** Replace the store's trade-in rules. */
export async function savePolicies(db: Db, rules: (BuylistPolicyRule & { kind: string | null; categoryId: string | null })[]) {
  const seen = new Set<string>();
  for (const r of rules) {
    const k = `${r.kind}|${r.categoryId}`;
    if (seen.has(k)) throw badRequest("DUPLICATE_RULE", "Only one rule per product type or category");
    seen.add(k);
  }
  await db.buylistPolicy.deleteMany({});
  await db.buylistPolicy.createMany({ data: rules as Prisma.BuylistPolicyCreateManyInput[] });
  return db.buylistPolicy.findMany();
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
