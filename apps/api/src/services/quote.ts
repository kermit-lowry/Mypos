import type { SalesChannel } from "@prisma/client";
import { dualTotals, earnFor, type AppliedPromotion, type CartLine, type CartTotals } from "@mypos/shared";
import type { Db } from "../db.js";
import { notFound } from "../errors.js";
import { earns, getProgram, loyaltyBalances, priceRewards, unitFor } from "./loyalty.js";
import { applyDeals } from "./promotions.js";

export interface CartQuote extends CartTotals {
  card: CartTotals;
  lines: { variantId: string; promoDiscountCents: number; rewardDiscountCents: number; discountCents: number }[];
  promotions: AppliedPromotion[];
  pointsCost: number;
  earn: { unit: "POINTS" | "CENTS"; amount: number } | null;
  balances: { points: number; rewardsCents: number } | null;
  /** Kept for older register builds. */
  rewardDiscounts: number[];
}

/**
 * Price a cart without charging anything: deals, then manual discounts, then
 * loyalty rewards, with cash and card totals. Mirrors checkout's pricing.
 */
export async function quoteCart(
  db: Db,
  input: { locationId: string; channel: SalesChannel; customerId?: string; lines: CartLine[]; rewardIds: string[]; creditPaidCents?: number },
): Promise<CartQuote> {
  const [program, location, variants] = await Promise.all([
    getProgram(db),
    db.location.findUnique({ where: { id: input.locationId } }),
    db.variant.findMany({ where: { id: { in: input.lines.map((l) => l.variantId) } }, include: { product: true } }),
  ]);
  if (!location) throw notFound("Location");
  const lines = input.lines.map((l) => {
    const v = variants.find((x) => x.id === l.variantId);
    if (!v) throw notFound(`Variant ${l.variantId}`);
    const unitPriceCents = l.unitPriceCents ?? v.priceCents;
    return { variant: v, unitPriceCents, quantity: l.quantity, manual: Math.min(l.discountCents, unitPriceCents * l.quantity), taxable: v.taxable };
  });

  const deals = await applyDeals(db, location, input.channel, lines);
  const afterDeals = lines.map((l, i) => {
    const gross = l.unitPriceCents * l.quantity;
    const promo = Math.min(gross, deals.lineDiscounts[i]!);
    return { ...l, promo, discountCents: promo + Math.min(l.manual, gross - promo) };
  });

  const loyaltyLines = afterDeals.map((l) => ({
    variantId: l.variant.id,
    productId: l.variant.productId,
    kind: l.variant.product.kind,
    unitPriceCents: l.unitPriceCents,
    quantity: l.quantity,
    discountCents: l.discountCents,
  }));
  const { discounts, pointsCost } = await priceRewards(db, program, loyaltyLines, input.rewardIds);
  const final = afterDeals.map((l, i) => ({ ...l, reward: discounts[i]!, discountCents: l.discountCents + discounts[i]! }));

  const dual = dualTotals(final, location.taxRateBps, location.cardPriceBps);
  const eligible = final.reduce((a, l) => a + (earns(program, l.variant.product.kind) ? l.unitPriceCents * l.quantity - l.discountCents : 0), 0);
  return {
    ...dual.cash,
    card: dual.card,
    lines: final.map((l) => ({ variantId: l.variant.id, promoDiscountCents: l.promo, rewardDiscountCents: l.reward, discountCents: l.discountCents })),
    promotions: deals.applied,
    pointsCost,
    earn: input.customerId ? { unit: unitFor(program), amount: earnFor(program, eligible, dual.cash.totalCents, input.creditPaidCents ?? 0) } : null,
    balances: input.customerId ? await loyaltyBalances(db, input.customerId) : null,
    rewardDiscounts: discounts,
  };
}
