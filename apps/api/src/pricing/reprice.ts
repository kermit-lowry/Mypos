import { conditionAdjusted, DEFAULT_PRICE_RULE, sellPrice, type PriceRule } from "@mypos/shared";
import type { PrismaClient } from "@prisma/client";
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
 * per product covers all of its condition/finish variants.
 */
export async function repriceSingles(
  prisma: PrismaClient,
  providers: PriceProvider[],
  rule: PriceRule = DEFAULT_PRICE_RULE,
  opts: { productIds?: string[] } = {},
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
      if (v.autoPrice && price !== v.priceCents) summary.repriced++;
    }
  }
  return summary;
}
