import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { marketTrends } from "../src/pricing/trends.js";
import { prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function history(variantId: string, points: [daysAgo: number, cents: number][]) {
  for (const [d, cents] of points) await prisma.pricePoint.create({ data: { variantId, source: "scryfall", marketCents: cents, capturedAt: ago(d) } });
  const latest = points.reduce((a, b) => (a[0] < b[0] ? a : b));
  await prisma.variant.update({ where: { id: variantId }, data: { marketCents: latest[1], marketSource: "scryfall", marketAt: ago(latest[0]) } });
}

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
});
afterAll(() => prisma.$disconnect());

describe("7-day market trends", () => {
  it("compares today's market price with the last pull from 7+ days ago", async () => {
    await history(v.nm, [[10, 1000], [8, 1050], [3, 1100], [0, 1260]]);
    const t = (await marketTrends(prisma, [v.nm])).get(v.nm)!;
    // baseline is the 8-days-ago pull ($10.50) -> $12.60 = +20%
    expect(t).toMatchObject({ marketCents: 1260, fromCents: 1050, changeBps: 2000, days: 7 });
  });

  it("uses what history there is (and says how many days) while it builds up", async () => {
    await history(v.nm, [[3, 1000], [0, 900]]);
    expect((await marketTrends(prisma, [v.nm])).get(v.nm)).toMatchObject({ changeBps: -1000, days: 3 });
  });

  it("has no trend with a single pull or without a price feed", async () => {
    await history(v.nm, [[0, 1000]]);
    const t = await marketTrends(prisma, [v.nm, v.shoe]);
    expect(t.get(v.nm)).toMatchObject({ marketCents: 1000, changeBps: null });
    expect(t.get(v.shoe)).toMatchObject({ marketCents: null, changeBps: null });
  });

  it("shows market price and trend next to your price in search and online", async () => {
    await history(v.nm, [[9, 1000], [0, 1100]]);
    const search = await w.as(w.cashier, "GET", `/catalog/search?q=charizard&locationId=${w.locationId}`);
    const nm = search.body.results[0].variants.find((x: any) => x.id === v.nm);
    expect(nm).toMatchObject({ priceCents: 1000, market: { marketCents: 1100, changeBps: 1000 } });
    const web = await w.app.inject({ method: "GET", url: "/storefront/products" });
    expect(web.json().products[0].variants.find((x: any) => x.id === v.nm).market).toMatchObject({ marketCents: 1100, changeBps: 1000 });
    const pricing = await w.as(w.cashier, "GET", `/pricing/variants/${v.nm}`);
    expect(pricing.body.trend).toMatchObject({ changeBps: 1000, days: 7 });
  });
});
