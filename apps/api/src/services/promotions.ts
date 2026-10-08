import type { Location, Promotion, SalesChannel } from "@prisma/client";
import { applyPromotions, isScheduledNow, type PromoDef, type PromoResult } from "@mypos/shared";
import type { Db } from "../db.js";

/** Category id -> itself plus every ancestor, so a deal on "Pokémon" covers "Pokémon > Sealed". */
export async function categoryLineage(db: Db): Promise<Map<string, string[]>> {
  const all = await db.category.findMany({ select: { id: true, parentId: true } });
  const parent = new Map(all.map((c) => [c.id, c.parentId]));
  const lineage = new Map<string, string[]>();
  for (const c of all) {
    const chain: string[] = [];
    for (let id: string | null | undefined = c.id; id && !chain.includes(id); id = parent.get(id)) chain.push(id);
    lineage.set(c.id, chain);
  }
  return lineage;
}

export function toPromoDef(p: Promotion): PromoDef {
  const hasGet = p.getProductIds.length + p.getVariantIds.length + p.getCategoryIds.length > 0;
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    priority: p.priority,
    stackable: p.stackable,
    targets: { all: p.targetAll, productIds: p.productIds, variantIds: p.variantIds, categoryIds: p.categoryIds },
    exclude: { productIds: p.excludeProductIds, categoryIds: p.excludeCategoryIds },
    getTargets: hasGet ? { productIds: p.getProductIds, variantIds: p.getVariantIds, categoryIds: p.getCategoryIds } : null,
    percentBps: p.percentBps,
    amountCents: p.amountCents,
    priceCents: p.priceCents,
    buyQty: p.buyQty,
    getQty: p.getQty,
    getDiscountBps: p.getDiscountBps,
    minQty: p.minQty,
    minSubtotalCents: p.minSubtotalCents,
    maxApplications: p.maxApplications,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    dates: p.dates,
    daysOfWeek: p.daysOfWeek,
    startTime: p.startTime,
    endTime: p.endTime,
  };
}

/** Deals running right now at this location on this channel. */
export async function runningPromotions(db: Db, location: Pick<Location, "id" | "timezone">, channel: SalesChannel, at = new Date()): Promise<PromoDef[]> {
  const candidates = await db.promotion.findMany({
    where: {
      active: true,
      channels: { has: channel },
      OR: [{ locationIds: { isEmpty: true } }, { locationIds: { has: location.id } }],
      AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: at } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: at } }] }],
    },
  });
  return candidates.filter((p) => isScheduledNow(p, at, location.timezone)).map(toPromoDef);
}

export interface DealLine {
  variant: { id: string; productId: string; product: { categoryId: string | null } };
  unitPriceCents: number;
  quantity: number;
}

/** Run every applicable deal over a cart. */
export async function applyDeals(
  db: Db,
  location: Pick<Location, "id" | "timezone">,
  channel: SalesChannel,
  lines: DealLine[],
  at = new Date(),
): Promise<PromoResult> {
  const promos = await runningPromotions(db, location, channel, at);
  if (promos.length === 0) return { lineDiscounts: lines.map(() => 0), applied: [] };
  const lineage = await categoryLineage(db);
  return applyPromotions(
    lines.map((l) => ({
      variantId: l.variant.id,
      productId: l.variant.productId,
      categoryIds: l.variant.product.categoryId ? (lineage.get(l.variant.product.categoryId) ?? []) : [],
      unitPriceCents: l.unitPriceCents,
      quantity: l.quantity,
    })),
    promos,
  );
}
