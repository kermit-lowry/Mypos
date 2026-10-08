import type { CardCondition, CardFinish } from "@prisma/client";
import { conditionAdjusted, sellPrice } from "@mypos/shared";
import type { Db } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import type { CardSource } from "../pricing/cardSources.js";

/**
 * Add a card the store doesn't stock yet (e.g. one a customer is trading in):
 * finds or creates the product and the condition/finish variant, priced from
 * the card's market price.
 */
export async function importCard(
  db: Db,
  sources: CardSource[],
  input: { source: "scryfall" | "pokemontcg"; externalId: string; condition: CardCondition; finish?: CardFinish },
) {
  const src = sources.find((s) => s.source === input.source);
  if (!src) throw badRequest("SOURCE", "Unknown card source");
  const card = await src.get(input.externalId);
  if (!card) throw notFound("Card");
  const finish = input.finish ?? card.finishes[0] ?? "NONFOIL";
  if (!card.finishes.includes(finish)) throw badRequest("FINISH", `This printing doesn't come in ${finish.toLowerCase()}`);

  const idField = input.source === "scryfall" ? "scryfallId" : "pokemonTcgId";
  let product = await db.product.findFirst({ where: { [idField]: card.externalId } });
  if (!product) {
    product = await db.product.create({
      data: {
        kind: "TCG_SINGLE",
        title: card.title,
        game: card.game,
        setCode: card.setCode,
        setName: card.setName,
        collectorNumber: card.collectorNumber,
        rarity: card.rarity,
        imageUrl: card.imageUrl,
        channels: ["POS", "STOREFRONT"],
        [idField]: card.externalId,
      },
    });
  }

  const existing = await db.variant.findFirst({ where: { productId: product.id, condition: input.condition, finish, gradingCompany: null } });
  if (existing) return { product, variant: existing, created: false };

  const nm = card.marketByFinish[finish];
  const market = nm !== undefined ? conditionAdjusted(nm, input.condition) : null;
  const base = [card.game.toUpperCase(), card.setCode, card.collectorNumber, input.condition, finish !== "NONFOIL" ? finish : null].filter(Boolean).join("-");
  let sku = base;
  for (let i = 2; await db.variant.findUnique({ where: { sku } }); i++) sku = `${base}-${i}`;
  const variant = await db.variant.create({
    data: {
      productId: product.id,
      sku,
      condition: input.condition,
      finish,
      priceCents: market !== null ? sellPrice(market) : 0,
      marketCents: market,
      marketSource: market !== null ? input.source : null,
      marketAt: market !== null ? new Date() : null,
      autoPrice: market !== null,
    },
  });
  if (market !== null) await db.pricePoint.create({ data: { variantId: variant.id, source: input.source, marketCents: market } });
  return { product, variant, created: true };
}
