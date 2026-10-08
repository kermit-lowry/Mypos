import { conditionAdjusted, DEFAULT_PRICE_RULE, sellPrice, type PriceRule } from "@mypos/shared";
import type { PrismaClient } from "@prisma/client";
import { audit } from "../services/permissions.js";
import type { PriceProvider } from "./providers.js";

export interface RepriceSummary {
  checked: number;
  updatedMarket: number;
  repriced: number;
  missing: number;
}

/**
 * Pull market prices for TCG singles, record history, and (for autoPrice
 * variants) set the shelf price from the store's price rule. One feed call
 * per product covers all of its condition/finish variants. Shelf prices that
 * moved go into the activity log as one PRICE_CHANGE row per run.
 */
export async function repriceSingles(
  prisma: PrismaClient,
  providers: PriceProvider[],
  rule: PriceRule = DEFAULT_PRICE_RULE,
  opts: { productIds?: string[]; actorId?: string | null; trigger?: "manual" | "scheduled" } = {},
): Promise<RepriceSummary> {
  const products = await prisma.product.findMany({
    where: {
      kind: "TCG_SINGLE",
      ...(opts.productIds ? { id: { in: opts.productIds } } : {}),
      OR: [{ scryfallId: { not: null } }, { pokemonTcgId: { not: null } }, { tcgplayerId: { not: null } }],
    },
    include: { variants: true },
  });

  const summary: RepriceSummary = { checked: 0, updatedMarket: 0, repriced: 0, missing: 0 };
  const diffs: { variantId: string; sku: string; item: string; fromCents: number; toCents: number }[] = [];
  const sources = new Set<string>();
  for (const product of products) {
    let quote = null;
    for (const provider of providers) {
      quote = await provider.quote(product).catch(() => null);
      if (quote) break;
    }
    if (quote?.imageUrl && !product.imageUrl) {
      await prisma.product.update({ where: { id: product.id }, data: { imageUrl: quote.imageUrl } });
    }
    // Graded slabs aren't priced from raw-card market data.
    for (const v of product.variants.filter((x) => !x.gradingCompany)) {
      summary.checked++;
      const nm = quote?.byFinish[v.finish ?? "NONFOIL"];
      if (!quote || nm === undefined) {
        summary.missing++;
        continue;
      }
      const market = v.condition ? conditionAdjusted(nm, v.condition) : nm;
      const price = sellPrice(market, rule);
      await prisma.$transaction([
        prisma.pricePoint.create({ data: { variantId: v.id, source: quote.source, marketCents: market } }),
        prisma.variant.update({
          where: { id: v.id },
          data: {
            marketCents: market,
            marketSource: quote.source,
            marketAt: new Date(),
            ...(v.autoPrice ? { priceCents: price } : {}),
          },
        }),
      ]);
      summary.updatedMarket++;
      if (v.autoPrice && price !== v.priceCents) {
        summary.repriced++;
        diffs.push({ variantId: v.id, sku: v.sku, item: product.title, fromCents: v.priceCents, toCents: price });
        sources.add(quote.source);
      }
    }
  }
  // One row per run, not per card, so a nightly feed doesn't flood the log.
  if (diffs.length) {
    await audit(prisma, {
      action: "PRICE_CHANGE",
      staffId: opts.actorId ?? null,
      details: { source: "reprice", trigger: opts.trigger ?? "manual", provider: [...sources].join(", "), count: diffs.length, items: diffs.slice(0, 200) },
    });
  }
  return summary;
}
