import type { CardFinish } from "@prisma/client";
import { config } from "../config.js";

/** A card from an outside database, for adding cards the store doesn't stock yet. */
export interface ExternalCard {
  source: "scryfall" | "pokemontcg";
  externalId: string;
  game: "mtg" | "pokemon";
  title: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  rarity: string | null;
  imageUrl: string | null;
  /** Finishes this printing comes in. */
  finishes: CardFinish[];
  /** Near-mint market price by finish, cents. */
  marketByFinish: Partial<Record<CardFinish, number>>;
}

export interface CardSource {
  readonly source: ExternalCard["source"];
  search(q: string): Promise<ExternalCard[]>;
  get(externalId: string): Promise<ExternalCard | null>;
}

const cents = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
};

async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = 5000): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "MyPOS/0.1", ...headers }, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Magic: The Gathering via Scryfall (free; please keep under 10 requests/second). */
export class ScryfallCards implements CardSource {
  readonly source = "scryfall" as const;

  private map(c: any): ExternalCard {
    const finishes: CardFinish[] = (c.finishes ?? ["nonfoil"]).map((f: string) => (f === "foil" ? "FOIL" : f === "etched" ? "ETCHED" : "NONFOIL"));
    return {
      source: this.source,
      externalId: c.id,
      game: "mtg",
      title: c.name,
      setCode: String(c.set ?? "").toUpperCase(),
      setName: c.set_name ?? "",
      collectorNumber: String(c.collector_number ?? ""),
      rarity: c.rarity ?? null,
      imageUrl: c.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal ?? null,
      finishes,
      marketByFinish: { NONFOIL: cents(c.prices?.usd), FOIL: cents(c.prices?.usd_foil), ETCHED: cents(c.prices?.usd_etched) },
    };
  }

  async search(q: string) {
    const body = await getJson(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released&dir=desc`);
    return ((body?.data ?? []) as any[]).slice(0, 25).map((c) => this.map(c));
  }

  async get(id: string) {
    const c = await getJson(`https://api.scryfall.com/cards/${encodeURIComponent(id)}`);
    return c ? this.map(c) : null;
  }
}

/** Pokémon via pokemontcg.io (TCGplayer market prices). */
export class PokemonCards implements CardSource {
  readonly source = "pokemontcg" as const;
  private headers = (): Record<string, string> => (config.pokemonTcgApiKey ? { "X-Api-Key": config.pokemonTcgApiKey } : {});

  private map(c: any): ExternalCard {
    const prices: Record<string, { market?: number }> = c.tcgplayer?.prices ?? {};
    const byKey: Record<string, CardFinish> = { normal: "NONFOIL", holofoil: "HOLO", reverseHolofoil: "REVERSE_HOLO", "1stEditionHolofoil": "FOIL" };
    const marketByFinish: Partial<Record<CardFinish, number>> = {};
    for (const [k, f] of Object.entries(byKey)) if (prices[k]) marketByFinish[f] = cents(prices[k]!.market);
    const finishes = Object.keys(marketByFinish) as CardFinish[];
    return {
      source: this.source,
      externalId: c.id,
      game: "pokemon",
      title: c.name,
      setCode: String(c.set?.ptcgoCode ?? c.set?.id ?? "").toUpperCase(),
      setName: c.set?.name ?? "",
      collectorNumber: String(c.number ?? ""),
      rarity: c.rarity ?? null,
      imageUrl: c.images?.small ?? null,
      finishes: finishes.length ? finishes : ["NONFOIL"],
      marketByFinish,
    };
  }

  async search(q: string) {
    const term = q.replace(/["\\\\]/g, "").trim();
    const body = await getJson(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`name:"${term}*"`)}&pageSize=20&orderBy=-set.releaseDate`, this.headers());
    return ((body?.data ?? []) as any[]).map((c) => this.map(c));
  }

  async get(id: string) {
    const body = await getJson(`https://api.pokemontcg.io/v2/cards/${encodeURIComponent(id)}`, this.headers());
    return body?.data ? this.map(body.data) : null;
  }
}

export const defaultCardSources = (): CardSource[] => [new ScryfallCards(), new PokemonCards()];
