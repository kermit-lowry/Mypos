import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, PINS, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;
beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
});
afterAll(() => prisma.$disconnect());

const shoes = () =>
  w.as(w.manager, "POST", "/catalog/products", {
    kind: "SNEAKER",
    title: "Nike Dunk Low Panda",
    styleCode: "DD1391-100",
    variants: ["9", "9.5", "10", "10.5", "11", "4Y"].map((size) => ({ sku: `DD1391-${size}`, priceCents: 12000, size })),
  });

describe("search filters", () => {
  it("finds every size 10 and 10.5 without typing a name", async () => {
    await shoes();
    const res = await w.as(w.cashier, "GET", "/catalog/search?sizes=10,10.5");
    const sizes = res.body.results.flatMap((p: any) => p.variants.map((x: any) => x.size));
    // seedCatalog's Jordan 1 is a size 10 too
    expect(sizes.sort()).toEqual(["10", "10", "10.5"]);
  });

  it("combines filters with text and stock", async () => {
    await shoes();
    const p = await w.as(w.cashier, "GET", "/catalog/search?q=dunk&sizes=10.5,11");
    expect(p.body.results[0].variants.map((x: any) => x.size)).toEqual(["10.5", "11"]);
    const stocked = await w.as(w.cashier, "GET", `/catalog/search?q=dunk&sizes=10.5,11&inStock=true&locationId=${w.locationId}`);
    expect(stocked.body.results).toEqual([]);
  });

  it("filters slabs by grade and company, cards by several conditions", async () => {
    await w.as(w.manager, "POST", "/catalog/products", {
      kind: "TCG_SINGLE",
      title: "Umbreon VMAX",
      variants: [
        { sku: "UMB-PSA10", priceCents: 1, gradingCompany: "PSA", grade: "10", certNumber: "10000001" },
        { sku: "UMB-PSA9", priceCents: 1, gradingCompany: "PSA", grade: "9", certNumber: "10000002" },
        { sku: "UMB-BGS10", priceCents: 1, gradingCompany: "BGS", grade: "10", certNumber: "10000003" },
      ],
    });
    const skus = (qs: string) => w.as(w.cashier, "GET", `/catalog/search?${qs}`).then((r) => r.body.results.flatMap((p: any) => p.variants.map((x: any) => x.sku)).sort());
    expect(await skus("grades=10")).toEqual(["UMB-BGS10", "UMB-PSA10"]);
    expect(await skus("grades=10,9&gradingCompanies=PSA")).toEqual(["UMB-PSA10", "UMB-PSA9"]);
    expect(await skus("q=charizard&conditions=NM,LP")).toEqual(["PKM-OBF-125-LP", "PKM-OBF-125-NM"]);
    expect((await w.as(w.cashier, "GET", "/catalog/search?gradingCompanies=XYZ")).status).toBe(400);
  });

  it("needs text or a filter", async () => {
    expect((await w.as(w.cashier, "GET", "/catalog/search")).body.error).toBe("SEARCH_EMPTY");
  });

  it("lists the sizes and grades in stock for filter chips, in a sensible order", async () => {
    await shoes();
    const f = await w.as(w.cashier, "GET", "/catalog/facets?kind=SNEAKER");
    expect(f.body.sizes.map((s: any) => s.value)).toEqual(["4Y", "9", "9.5", "10", "10.5", "11"]);
  });
});

describe("trade-in offers", () => {
  it("suggests offers from the store's margin rules and explains them", async () => {
    await w.as(w.owner, "PUT", "/buylist/policies", [
      { kind: null, categoryId: null, cashMarginBps: 5000, creditBonusBps: 3000, trendWeightBps: 5000, maxTrendUpBps: 500 },
      { kind: "SNEAKER", categoryId: null, cashMarginBps: 3000, creditBonusBps: 2000, trendWeightBps: 0, maxTrendUpBps: 0 },
    ]);
    // Jordan 1 sells for $300; sneakers keep 30% -> $210 cash, $252 credit
    const s = await w.as(w.cashier, "POST", "/buylist/suggest", { locationId: w.locationId, lines: [{ variantId: v.shoe, quantity: 1 }] });
    expect(s.body[0].suggestion).toMatchObject({ cashCents: 21000, creditCents: 25200, basis: "YOUR_PRICE" });
    expect(s.body[0].suggestion.notes[0]).toContain("$300.00");
  });

  it("lowers the offer when the market is falling", async () => {
    await prisma.variant.update({ where: { id: v.nm }, data: { marketCents: 900, marketAt: new Date() } });
    await prisma.pricePoint.create({ data: { variantId: v.nm, source: "test", marketCents: 1000, capturedAt: new Date(Date.now() - 8 * 86_400_000) } });
    const s = await w.as(w.cashier, "POST", "/buylist/suggest", { locationId: w.locationId, lines: [{ variantId: v.nm, quantity: 1 }] });
    // market $9.00 (< your $10.00), down 10% -> plan on $8.55 -> 50% = $4.27
    expect(s.body[0].suggestion).toMatchObject({ basis: "MARKET", projectedCents: 855, cashCents: 427 });
  });

  it("only owners set the rules", async () => {
    expect((await w.as(w.manager, "PUT", "/buylist/policies", [])).status).toBe(403);
  });

  it("offering more than suggested needs approval; cash and credit payouts are separate permissions", async () => {
    const cust = (await w.as(w.cashier, "POST", "/customers", { name: "Seller" })).body.id;
    const over = { locationId: w.locationId, customerId: cust, lines: [{ variantId: v.shoe, quantity: 1, cashOfferCents: 200_000 }] };
    expect((await w.as(w.cashier, "POST", "/buylist/quote", over)).body.error).toBe("APPROVAL_REQUIRED");

    const quote = await w.as(w.cashier, "POST", "/buylist/quote", { locationId: w.locationId, customerId: cust, lines: [{ variantId: v.shoe, quantity: 1 }] });
    expect(quote.body.lines[0]).toMatchObject({ cashOfferCents: 15000, suggestedCashCents: 15000 });

    // Owner lets cashiers give store credit but not cash.
    await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { BUYLIST_CREDIT: "ALLOW", BUYLIST_PAYOUT: "DENY" }, discountMaxBps: 1000 });
    expect((await w.as(w.cashier, "POST", `/buylist/${quote.body.id}/accept`, { payout: "CASH" })).body.error).toBe("PERMISSION_DENIED");
    const credit = await w.as(w.cashier, "POST", `/buylist/${quote.body.id}/accept`, { payout: "STORE_CREDIT" });
    expect(credit.body).toMatchObject({ status: "ACCEPTED", paidCents: 19500 });
    expect((await w.as(w.cashier, "GET", `/customers/${cust}`)).body.storeCreditCents).toBe(19500);
    const log = await w.as(w.manager, "GET", "/audit?action=BUYLIST_CREDIT");
    expect(log.body[0]).toMatchObject({ staffName: "CASHIER", details: { paidCents: 19500 } });
  });

  it("taking store credit as payment can be restricted", async () => {
    const cust = (await w.as(w.cashier, "POST", "/customers", { name: "Buyer" })).body.id;
    await w.as(w.manager, "POST", `/customers/${cust}/credit`, { amountCents: 5000, reason: "Trade-in" });
    await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { TENDER_STORE_CREDIT: "PIN" }, discountMaxBps: 1000 });
    const body = { locationId: w.locationId, customerId: cust, lines: [{ variantId: v.nm, quantity: 1 }], tenders: [{ type: "STORE_CREDIT", amountCents: 1083 }], idempotencyKey: key() };
    expect((await w.as(w.cashier, "POST", "/orders/checkout", body)).body).toMatchObject({ error: "APPROVAL_REQUIRED", details: { permission: "TENDER_STORE_CREDIT" } });
    const grant = await w.as(w.cashier, "POST", "/auth/approve", { pin: PINS.MANAGER, permissions: ["TENDER_STORE_CREDIT"] });
    const ok = await w.app.inject({ method: "POST", url: "/orders/checkout", payload: body, headers: { authorization: `Bearer ${w.cashier}`, "x-approval-token": grant.body.token } });
    expect(ok.statusCode).toBe(201);
  });

  it("trade-ins of items not in the catalog need a resale figure", async () => {
    const res = await w.as(w.cashier, "POST", "/buylist/suggest", { locationId: w.locationId, lines: [{ description: "Vintage tee", quantity: 1 }] });
    expect(res.body.error).toBe("RESALE_REQUIRED");
  });
});

describe("finding items a customer brought in", () => {
  const fakeScryfall = {
    source: "scryfall" as const,
    cards: [
      {
        source: "scryfall" as const,
        externalId: "sf-1",
        game: "mtg" as const,
        title: "Ragavan, Nimble Pilferer",
        setCode: "MH2",
        setName: "Modern Horizons 2",
        collectorNumber: "138",
        rarity: "mythic",
        imageUrl: "https://cards.example/ragavan.jpg",
        finishes: ["NONFOIL", "FOIL"] as ("NONFOIL" | "FOIL")[],
        marketByFinish: { NONFOIL: 5000, FOIL: 9000 },
      },
    ],
    async search(q: string) {
      return this.cards.filter((c) => c.title.toLowerCase().includes(q.toLowerCase()));
    },
    async get(id: string) {
      return this.cards.find((c) => c.externalId === id) ?? null;
    },
  };

  async function appWithSources() {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp({ prisma, gateway: w.gateway, cardSources: [fakeScryfall] });
    return (method: "GET" | "POST", url: string, body?: object) =>
      app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${w.cashier}` } }).then((r) => ({ status: r.statusCode, body: r.json() }));
  }

  it("searches the catalog and outside card databases together", async () => {
    const call = await appWithSources();
    const res = await call("GET", "/buylist/lookup?q=ragavan");
    expect(res.body.catalog).toEqual([]);
    expect(res.body.external[0]).toMatchObject({ title: "Ragavan, Nimble Pilferer", setCode: "MH2", marketByFinish: { NONFOIL: 5000 } });
  });

  it("adds a found card to the catalog priced from market, then suggests an offer", async () => {
    const call = await appWithSources();
    const imported = await call("POST", "/catalog/import-card", { source: "scryfall", externalId: "sf-1", condition: "LP", finish: "FOIL" });
    expect(imported.status).toBe(201);
    // LP = 85% of $90 foil = $76.50 market; shelf price rounds to .99
    expect(imported.body.variant).toMatchObject({ sku: "MTG-MH2-138-LP-FOIL", condition: "LP", finish: "FOIL", marketCents: 7650, priceCents: 7699, autoPrice: true });
    expect(imported.body.product.imageUrl).toBe("https://cards.example/ragavan.jpg");

    const again = await call("POST", "/catalog/import-card", { source: "scryfall", externalId: "sf-1", condition: "LP", finish: "FOIL" });
    expect(again.status).toBe(200);
    expect(again.body.variant.id).toBe(imported.body.variant.id);

    // Once stocked, the lookup shows it from the catalog instead of as an outside result.
    const res = await call("GET", "/buylist/lookup?q=ragavan");
    expect(res.body.catalog[0].title).toBe("Ragavan, Nimble Pilferer");
    expect(res.body.external).toEqual([]);

    const s = await w.as(w.cashier, "POST", "/buylist/suggest", { locationId: w.locationId, lines: [{ variantId: imported.body.variant.id, quantity: 1 }] });
    expect(s.body[0].suggestion).toMatchObject({ basis: "MARKET", resaleCents: 7650, cashCents: 3825 });
  });

  it("keeps working when an outside database is down", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp({ prisma, gateway: w.gateway, cardSources: [{ source: "scryfall", search: async () => { throw new Error("timeout"); }, get: async () => null }] });
    const res = await app.inject({ method: "GET", url: "/buylist/lookup?q=charizard", headers: { authorization: `Bearer ${w.cashier}` } });
    expect(res.json().catalog[0].title).toBe("Charizard ex");
    expect(res.json().errors).toEqual(["scryfall: timeout"]);
  });
});
