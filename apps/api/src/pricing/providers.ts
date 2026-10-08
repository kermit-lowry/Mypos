import type { CardFinish } from "@prisma/client";
import { config } from "../config.js";

export interface MarketQuote {
  source: string;
  /** Near-mint market price by finish, in cents. */
  byFinish: Partial<Record<CardFinish, number>>;
}

export interface PriceProvider {
  readonly source: string;
  /** Returns null when the product isn't covered by this feed. */
  quote(product: { scryfallId: string | null; pokemonTcgId: string | null; tcgplayerId: string | null }): Promise<MarketQuote | null>;
}

const toCents = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
};

/** Magic: The Gathering via Scryfall (free, no key; asks for <10 req/s). */
export class ScryfallProvider implements PriceProvider {
  readonly source = "scryfall";
  async quote(p: { scryfallId: string | null }): Promise<MarketQuote | null> {
    if (!p.scryfallId) return null;
    const res = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(p.scryfallId)}`, {
      headers: { accept: "application/json", "user-agent": "MyPOS/0.1" },
    });
    if (!res.ok) return null;
    const card = (await res.json()) as { prices?: Record<string, string | null> };
    const prices = card.prices ?? {};
    return {
      source: this.source,
      byFinish: { NONFOIL: toCents(prices.usd), FOIL: toCents(prices.usd_foil), ETCHED: toCents(prices.usd_etched) },
    };
  }
}

/** Pokémon via pokemontcg.io, which republishes TCGplayer market prices. */
export class PokemonTcgProvider implements PriceProvider {
  readonly source = "pokemontcg";
  async quote(p: { pokemonTcgId: string | null }): Promise<MarketQuote | null> {
    if (!p.pokemonTcgId) return null;
    const res = await fetch(`https://api.pokemontcg.io/v2/cards/${encodeURIComponent(p.pokemonTcgId)}`, {
      headers: config.pokemonTcgApiKey ? { "X-Api-Key": config.pokemonTcgApiKey } : {},
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { tcgplayer?: { prices?: Record<string, { market?: number }> } } };
    const prices = body.data?.tcgplayer?.prices ?? {};
    return {
      source: this.source,
      byFinish: {
        NONFOIL: toCents(prices.normal?.market),
        HOLO: toCents(prices.holofoil?.market),
        REVERSE_HOLO: toCents(prices.reverseHolofoil?.market),
        FOIL: toCents(prices["1stEditionHolofoil"]?.market),
      },
    };
  }
}

export const defaultProviders: PriceProvider[] = [new ScryfallProvider(), new PokemonTcgProvider()];
