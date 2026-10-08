import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { repriceSingles } from "../src/pricing/reprice.js";
import type { PriceProvider } from "../src/pricing/providers.js";
import { key, prisma, setup, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  w = await setup();
});
afterAll(() => prisma.$disconnect());

const create = (body: object) => w.as(w.manager, "POST", "/catalog/products", body);

async function charizards() {
  const res = await create({
    kind: "TCG_SINGLE",
    title: "Charizard",
    game: "pokemon",
    setCode: "BS",
    collectorNumber: "4",
    pokemonTcgId: "base1-4",
    channels: ["POS", "STOREFRONT"],
    variants: [
      { sku: "BS-4-NM", priceCents: 40000, condition: "NM", finish: "HOLO", autoPrice: true },
      { sku: "BS-4-LP", priceCents: 30000, condition: "LP", finish: "HOLO", autoPrice: true },
      { sku: "BS-4-PSA10", priceCents: 1_500_000, gradingCompany: "PSA", grade: "10", certNumber: "12345678", finish: "HOLO", autoPrice: true },
      { sku: "BS-4-BGS95", priceCents: 600_000, gradingCompany: "BGS", grade: "9.5", certNumber: "0011223344", finish: "HOLO" },
    ],
  });
  expect(res.status).toBe(200);
  const [nm, lp, psa, bgs] = res.body.variants;
  return { nm, lp, psa, bgs };
}

describe("graded cards", () => {
  it("are one-of-ones, not auto-priced, and their cert can't be added twice", async () => {
    const { psa } = await charizards();
    expect(psa).toMatchObject({ gradingCompany: "PSA", grade: "10", certNumber: "12345678", serialized: true, autoPrice: false, condition: null });
    const dupe = await create({ kind: "TCG_SINGLE", title: "Charizard", variants: [{ sku: "DUPE", priceCents: 1, gradingCompany: "PSA", grade: "9", certNumber: "12345678" }] });
    expect(dupe.body.error).toBe("CERT_EXISTS");
  });

  it("need a grade and company, and don't also take a raw condition", async () => {
    expect((await create({ kind: "TCG_SINGLE", title: "X", variants: [{ sku: "A", priceCents: 1, gradingCompany: "PSA" }] })).status).toBe(400);
    expect((await create({ kind: "TCG_SINGLE", title: "X", variants: [{ sku: "B", priceCents: 1, grade: "10" }] })).status).toBe(400);
    expect((await create({ kind: "TCG_SINGLE", title: "X", variants: [{ sku: "C", priceCents: 1, gradingCompany: "PSA", grade: "10", condition: "NM" }] })).status).toBe(400);
  });

  it("scanning or typing a cert number finds the slab", async () => {
    await charizards();
    const res = await w.as(w.cashier, "GET", "/catalog/search?q=12345678");
    expect(res.body.results[0].variants.map((v: any) => v.sku)).toEqual(["BS-4-PSA10"]);
  });

  it("search filters by condition, graded vs raw", async () => {
    await charizards();
    const q = (f: string) => w.as(w.cashier, "GET", `/catalog/search?q=charizard&${f}`).then((r) => r.body.results[0]?.variants.map((v: any) => v.sku).sort());
    expect(await q("condition=LP")).toEqual(["BS-4-LP"]);
    expect(await q("graded=true")).toEqual(["BS-4-BGS95", "BS-4-PSA10"]);
    expect(await q("graded=false")).toEqual(["BS-4-LP", "BS-4-NM"]);
  });

  it("raw cards follow the price feed by condition; slabs are left alone", async () => {
    const { nm, lp, psa } = await charizards();
    const feed: PriceProvider = { source: "test", quote: async () => ({ source: "test", byFinish: { HOLO: 50_000 } }) };
    await repriceSingles(prisma, [feed]);
    const after = await prisma.variant.findMany({ where: { id: { in: [nm.id, lp.id, psa.id] } } });
    const by = Object.fromEntries(after.map((v) => [v.sku, v]));
    expect(by["BS-4-NM"]!.marketCents).toBe(50_000);
    expect(by["BS-4-LP"]!.marketCents).toBe(42_500); // LP = 85% of NM
    expect(by["BS-4-PSA10"]).toMatchObject({ marketCents: null, priceCents: 1_500_000 });
  });

  it("show the grade and cert on receipts, labels, and online", async () => {
    const { psa } = await charizards();
    await w.as(w.manager, "POST", "/inventory/adjust", { variantId: psa.id, locationId: w.locationId, delta: 1, reason: "RECEIVE" });
    const sale = await w.as(w.manager, "POST", "/orders/checkout", {
      locationId: w.locationId,
      lines: [{ variantId: psa.id, quantity: 1 }],
      tenders: [{ type: "CASH", amountCents: 1_623_750 }],
      idempotencyKey: key(),
    });
    expect(sale.body.order.lines[0].title).toBe("Charizard (PSA 10 #12345678 / HOLO)");
    const zpl = await w.app.inject({ method: "POST", url: "/labels", payload: { locationId: w.locationId, items: [{ variantId: psa.id }], format: "zpl" }, headers: { authorization: `Bearer ${w.cashier}` } });
    expect(zpl.body).toContain("PSA 10 cert 12345678");
    const web = await w.app.inject({ method: "GET", url: "/storefront/products" });
    expect(web.json().products[0].variants.find((v: any) => v.id === psa.id)).toMatchObject({ gradingCompany: "PSA", grade: "10" });
  });
});

describe("sneakers and apparel: new or used", () => {
  it("default to new, and say NEW or USED everywhere", async () => {
    const res = await create({
      kind: "SNEAKER",
      title: "Air Jordan 1 Chicago",
      channels: ["POS", "STOREFRONT"],
      variants: [
        { sku: "AJ1-10-DS", priceCents: 30000, size: "10" },
        { sku: "AJ1-10-USED", priceCents: 18000, size: "10", itemCondition: "USED", serialized: true },
      ],
    });
    const [ds, used] = res.body.variants;
    expect(ds.itemCondition).toBe("DS");
    const q = (f: string) => w.as(w.cashier, "GET", `/catalog/search?q=jordan&itemCondition=${f}`).then((r) => r.body.results[0].variants.map((v: any) => v.sku));
    expect(await q("NEW")).toEqual(["AJ1-10-DS"]);
    expect(await q("USED_ANY")).toEqual(["AJ1-10-USED"]);
    const zpl = await w.app.inject({ method: "POST", url: "/labels", payload: { locationId: w.locationId, items: [{ variantId: ds.id }, { variantId: used.id }], format: "zpl" }, headers: { authorization: `Bearer ${w.cashier}` } });
    expect(zpl.body).toContain("Size 10 · NEW");
    expect(zpl.body).toContain("Size 10 · USED");
    const web = await w.app.inject({ method: "GET", url: "/storefront/products" });
    expect(web.json().products[0].variants.map((v: any) => v.newOrUsed)).toEqual(["NEW", "USED"]);
  });
});

describe("pictures", () => {
  it("fill in card images from the price feed, and keep per-item photos", async () => {
    const res = await create({
      kind: "TCG_SINGLE",
      title: "Pikachu",
      pokemonTcgId: "base1-58",
      channels: ["POS", "STOREFRONT"],
      variants: [
        { sku: "PIKA-NM", priceCents: 500, condition: "NM" },
        { sku: "PIKA-PSA9", priceCents: 9000, gradingCompany: "PSA", grade: "9", certNumber: "99887766", imageUrl: "https://img.example.com/slab-99887766.jpg" },
      ],
    });
    const feed: PriceProvider = { source: "test", quote: async () => ({ source: "test", byFinish: { NONFOIL: 600 }, imageUrl: "https://images.example.com/base1-58.png" }) };
    await repriceSingles(prisma, [feed]);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(product.imageUrl).toBe("https://images.example.com/base1-58.png");
    const web = await w.app.inject({ method: "GET", url: "/storefront/products" });
    const images = web.json().products[0].variants.map((v: any) => v.imageUrl);
    expect(images).toEqual(["https://images.example.com/base1-58.png", "https://img.example.com/slab-99887766.jpg"]);
  });
});
