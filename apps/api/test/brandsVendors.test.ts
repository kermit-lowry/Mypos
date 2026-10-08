import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, onHand, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;
beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
});
afterAll(() => prisma.$disconnect());

const today = () => {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).toISOString();
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2).toISOString();
  return `from=${from}&to=${to}`;
};
const sale = (lines: object[], tenders: object[]) => w.as(w.cashier, "POST", "/orders/checkout", { locationId: w.locationId, lines, tenders, idempotencyKey: key() });

/** A second sneaker brand with two sizes, in stock. */
async function nikes() {
  const p = await w.as(w.manager, "POST", "/catalog/products", {
    kind: "SNEAKER",
    title: "Nike Dunk Low Panda",
    brand: "nike",
    styleCode: "DD1391-100",
    variants: [
      { sku: "DD1391-100-10", priceCents: 12000, size: "10", itemCondition: "DS" },
      { sku: "DD1391-100-10.5", priceCents: 12000, size: "10.5", itemCondition: "DS" },
    ],
  });
  for (const x of p.body.variants) await w.as(w.manager, "POST", "/inventory/adjust", { variantId: x.id, locationId: w.locationId, delta: 2, reason: "RECEIVE" });
  return p.body as { id: string; brandId: string; brand: string; variants: { id: string; size: string }[] };
}

describe("brands", () => {
  it("creates brands from product names, case-insensitively, and lists them with counts", async () => {
    const nike = await nikes();
    expect(nike.brand).toBe("nike");
    expect(nike.brandId).toBeTruthy();
    // Same brand, different spelling → same brand row.
    const again = await w.as(w.manager, "POST", "/catalog/products", { kind: "APPAREL", title: "Nike Tech Fleece", brand: " NIKE ", variants: [{ sku: "TF-1", priceCents: 11000 }] });
    expect(again.body.brandId).toBe(nike.brandId);
    expect(again.body.brand).toBe("nike");

    const brands = await w.as(w.cashier, "GET", "/catalog/brands");
    expect(brands.body.map((b: any) => [b.name, b.products])).toEqual([["Jordan", 1], ["nike", 2]]);
    expect((await w.as(w.cashier, "GET", "/catalog/brands?q=jor")).body).toHaveLength(1);
  });

  it("renames a brand on every product, merges brands, and sets brand by id or name", async () => {
    const nike = await nikes();
    const renamed = await w.as(w.manager, "PATCH", `/catalog/brands/${nike.brandId}`, { name: "Nike" });
    expect(renamed.body.name).toBe("Nike");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: nike.id } })).brand).toBe("Nike");

    const dup = await w.as(w.manager, "POST", "/catalog/brands", { name: "Nike SB" });
    expect(dup.status).toBe(201);
    expect((await w.as(w.manager, "POST", "/catalog/brands", { name: "nike" })).body.error).toBe("BRAND_EXISTS");
    expect((await w.as(w.manager, "PATCH", `/catalog/brands/${dup.body.id}`, { name: "NIKE" })).body.error).toBe("BRAND_EXISTS");

    // Move the Jordan shoe onto Nike SB by id, then by name, then clear it.
    const shoe = await prisma.variant.findUniqueOrThrow({ where: { id: v.shoe } });
    expect((await w.as(w.manager, "PATCH", `/catalog/products/${shoe.productId}`, { brandId: dup.body.id })).body).toMatchObject({ brand: "Nike SB", brandId: dup.body.id });
    expect((await w.as(w.manager, "PATCH", `/catalog/products/${shoe.productId}`, { brand: "Jordan" })).body.brand).toBe("Jordan");
    expect((await w.as(w.manager, "PATCH", `/catalog/products/${shoe.productId}`, { brand: null })).body.brandId).toBeNull();

    const merged = await w.as(w.manager, "POST", `/catalog/brands/${dup.body.id}/merge`, { intoId: nike.brandId });
    expect(merged.body).toMatchObject({ moved: 0, into: { name: "Nike" } });
    expect((await w.as(w.cashier, "GET", "/catalog/brands")).body.map((b: any) => b.name)).toEqual(["Jordan", "Nike"]);
    expect((await w.as(w.manager, "GET", "/audit?action=BRAND_MERGED")).body).toHaveLength(1);
    expect((await w.as(w.cashier, "PATCH", `/catalog/brands/${nike.brandId}`, { name: "x" })).status).toBe(403);
  });

  it("filters the register search by brand together with size, and lists brands as facets", async () => {
    const nike = await nikes();
    const facets = await w.as(w.cashier, "GET", `/catalog/facets?locationId=${w.locationId}`);
    expect(facets.body.brands).toEqual([
      { value: expect.any(String), label: "Jordan", variants: 1, inStock: 0 },
      { value: nike.brandId, label: "nike", variants: 2, inStock: 4 },
    ]);

    // All size 10 / 10.5 shoes, any brand: Jordan 10 + Nike 10 + Nike 10.5.
    const any = await w.as(w.cashier, "GET", `/catalog/search?sizes=10,10.5&locationId=${w.locationId}`);
    expect(any.body.results.flatMap((p: any) => p.variants).length).toBe(3);
    // Same sizes, Nike only.
    const onlyNike = await w.as(w.cashier, "GET", `/catalog/search?sizes=10,10.5&brands=${nike.brandId}`);
    expect(onlyNike.body.results.map((p: any) => p.title)).toEqual(["Nike Dunk Low Panda"]);
    expect(onlyNike.body.results[0].variants.map((x: any) => x.size)).toEqual(["10", "10.5"]);
    // Brand by name works too, and brand alone is a valid search.
    expect((await w.as(w.cashier, "GET", "/catalog/search?brands=jordan")).body.results.map((p: any) => p.title)).toEqual(["Jordan 1 Retro High OG Chicago"]);
    // Text search finds the brand name.
    expect((await w.as(w.cashier, "GET", "/catalog/search?q=nike")).body.results).toHaveLength(1);
  });
});

describe("product vendors", () => {
  it("links several vendors to an item with their SKU and price, one preferred", async () => {
    const a = (await w.as(w.manager, "POST", "/vendors", { name: "Southern Hobby" })).body;
    const b = (await w.as(w.manager, "POST", "/vendors", { name: "GTS Distribution" })).body;
    const card = await prisma.variant.findUniqueOrThrow({ where: { id: v.nm } });

    const first = await w.as(w.manager, "PUT", `/catalog/products/${card.productId}/vendors/${a.id}`, { vendorSku: "SH-OBF-125", costCents: 450, preferred: true });
    expect(first.body).toMatchObject([{ vendor: { name: "Southern Hobby" }, vendorSku: "SH-OBF-125", costCents: 450, preferred: true }]);
    const second = await w.as(w.manager, "PUT", `/catalog/products/${card.productId}/vendors/${b.id}`, { vendorSku: "GTS-99", costCents: 425, leadDays: 3 });
    expect(second.body.map((x: any) => [x.vendor.name, x.preferred])).toEqual([["Southern Hobby", true], ["GTS Distribution", false]]);
    // Preferring the second un-prefers the first.
    const swapped = await w.as(w.manager, "PUT", `/catalog/products/${card.productId}/vendors/${b.id}`, { preferred: true });
    expect(swapped.body.map((x: any) => [x.vendor.name, x.preferred])).toEqual([["GTS Distribution", true], ["Southern Hobby", false]]);

    expect((await w.as(w.cashier, "PUT", `/catalog/products/${card.productId}/vendors/${a.id}`, {})).status).toBe(403);
    expect((await w.as(w.manager, "PUT", `/catalog/products/${card.productId}/vendors/nope`, {})).status).toBe(404);

    // The product carries its vendors; the vendor lists its products; search finds by vendor SKU or vendor.
    const product = await w.as(w.cashier, "GET", `/catalog/products/${card.productId}`);
    expect(product.body.vendors).toHaveLength(2);
    const supplied = await w.as(w.cashier, "GET", `/vendors/${a.id}/products`);
    expect(supplied.body).toMatchObject([{ vendorSku: "SH-OBF-125", product: { title: "Charizard ex" } }]);
    expect((await w.as(w.cashier, "GET", "/catalog/search?q=gts-99")).body.results[0].title).toBe("Charizard ex");
    expect((await w.as(w.cashier, "GET", `/catalog/search?vendorId=${b.id}`)).body.results).toHaveLength(1);
    expect((await w.as(w.cashier, "GET", `/catalog/search?vendorId=${b.id}&q=jordan`)).body.results).toHaveLength(0);
    expect((await w.as(w.cashier, "GET", "/vendors")).body.find((x: any) => x.id === a.id).products).toBe(1);

    const removed = await w.as(w.manager, "DELETE", `/catalog/products/${card.productId}/vendors/${a.id}`);
    expect(removed.body).toHaveLength(1);
    expect((await w.as(w.manager, "GET", "/audit?action=PRODUCT_VENDOR_REMOVED")).body).toHaveLength(1);
  });

  it("ordering links the vendor; receiving records their price; reorders suggest by vendor", async () => {
    const a = (await w.as(w.manager, "POST", "/vendors", { name: "Southern Hobby" })).body;
    const b = (await w.as(w.manager, "POST", "/vendors", { name: "GTS Distribution" })).body;
    const card = await prisma.variant.findUniqueOrThrow({ where: { id: v.nm } });

    const po = await w.as(w.manager, "POST", "/purchase-orders", { vendorId: a.id, locationId: w.locationId, lines: [{ variantId: v.nm, quantity: 10, unitCostCents: 400 }] });
    await w.as(w.manager, "POST", `/purchase-orders/${po.body.id}/order`);
    let links = (await w.as(w.cashier, "GET", `/catalog/products/${card.productId}/vendors`)).body;
    expect(links).toMatchObject([{ vendorId: a.id, costCents: 400, preferred: true }]);

    // The invoice came in at a different price: the receipt keeps it and the vendor's price follows.
    const rc = await w.as(w.manager, "POST", `/purchase-orders/${po.body.id}/receive`, { reference: "INV-77", lines: [{ variantId: v.nm, quantity: 10, unitCostCents: 380 }] });
    expect(rc.body.receipts).toMatchObject([{ reference: "INV-77", lines: [{ quantity: 10, unitCostCents: 380 }] }]);
    expect(await onHand(v.nm, w.locationId)).toBe(13);
    expect((await prisma.variant.findUniqueOrThrow({ where: { id: v.nm } })).costCents).toBe(380);
    links = (await w.as(w.cashier, "GET", `/catalog/products/${card.productId}/vendors`)).body;
    expect(links).toMatchObject([{ vendorId: a.id, costCents: 380 }]);

    // A second vendor for the same card, via a PO: now it has two; the first stays preferred.
    const po2 = await w.as(w.manager, "POST", "/purchase-orders", { vendorId: b.id, locationId: w.locationId, lines: [{ variantId: v.nm, quantity: 5, unitCostCents: 350 }, { variantId: v.shoe, quantity: 1, unitCostCents: 20000 }] });
    await w.as(w.manager, "POST", `/purchase-orders/${po2.body.id}/order`);
    links = (await w.as(w.cashier, "GET", `/catalog/products/${card.productId}/vendors`)).body;
    expect(links.map((l: any) => [l.vendorId, l.costCents, l.preferred])).toEqual([[a.id, 380, true], [b.id, 350, false]]);

    // Reorders: the card is low; suggestions name the vendors and cost at the chosen one's price.
    await w.as(w.manager, "PUT", `/inventory/${v.nm}/low-stock`, { locationId: w.locationId, lowStockQty: 20 });
    await w.as(w.manager, "PUT", `/inventory/${v.shoe}/low-stock`, { locationId: w.locationId, lowStockQty: 1 });
    const all = await w.as(w.manager, "GET", `/purchase-orders/reorder?locationId=${w.locationId}`);
    expect(all.body.map((s: any) => [s.title, s.vendor, s.lastCostCents])).toEqual([
      ["Jordan 1 Retro High OG Chicago", "GTS Distribution", 20000],
      ["Charizard ex", "Southern Hobby", 380],
    ]);
    const forB = await w.as(w.manager, "GET", `/purchase-orders/reorder?locationId=${w.locationId}&vendorId=${b.id}`);
    expect(forB.body.find((s: any) => s.variantId === v.nm)).toMatchObject({ vendorId: b.id, lastCostCents: 350, vendors: [{ name: "Southern Hobby" }, { name: "GTS Distribution" }] });

    // Vendor reports: the purchase report sees both orders and the one delivery.
    const report = await w.as(w.manager, "GET", `/reports/purchases?${today()}`);
    expect(report.body).toMatchObject({ orders: 2, openOrders: 1, finishedOrders: 1, receivedQty: 10, receiptSpendCents: 3800 });
    expect(report.body.byVendor.map((x: any) => x.vendor)).toEqual(["Southern Hobby", "GTS Distribution"]);
    expect(report.body.receipts).toMatchObject([{ poNumber: 1, reference: "INV-77", quantity: 10, costCents: 3800 }]);
    expect((await w.as(w.manager, "GET", `/reports/purchases?${today()}&vendorId=${b.id}`)).body.orders).toBe(1);
  });
});

describe("reports by brand", () => {
  it("finds sales, stock value, low stock and dead stock by brand (and vendor)", async () => {
    const nike = await nikes();
    const vendor = (await w.as(w.manager, "POST", "/vendors", { name: "Nike Direct" })).body;
    await w.as(w.manager, "PUT", `/catalog/products/${nike.id}/vendors/${vendor.id}`, { costCents: 6000 });
    await w.as(w.manager, "POST", "/inventory/adjust", { variantId: v.shoe, locationId: w.locationId, delta: 1, reason: "RECEIVE" });
    // $120 + 2 × $10 = $140 + 8.25% tax; $300 + tax.
    await sale([{ variantId: nike.variants[0]!.id, quantity: 1 }, { variantId: v.nm, quantity: 2 }], [{ type: "CASH", amountCents: 15155 }]);
    await sale([{ variantId: v.shoe, quantity: 1 }], [{ type: "CASH", amountCents: 32475 }]);

    const byBrand = await w.as(w.manager, "GET", `/reports/sales-by/brand?${today()}`);
    expect(byBrand.body.map((r: any) => [r.label, r.units, r.netCents])).toEqual([["Jordan", 1, 30000], ["nike", 1, 12000], ["No brand", 2, 2000]]);
    const byVendor = await w.as(w.manager, "GET", `/reports/sales-by/vendor?${today()}`);
    expect(byVendor.body.map((r: any) => [r.label, r.units])).toEqual([["No vendor", 3], ["Nike Direct", 1]]);

    // Narrow any sales report to one brand: only its lines count; "orders" = orders containing it.
    const summary = await w.as(w.manager, "GET", `/reports/summary?${today()}&brandId=${nike.brandId}`);
    expect(summary.body).toMatchObject({ orders: 1, units: 1, netSalesCents: 12000 });
    const top = await w.as(w.manager, "GET", `/reports/sales-by/product?${today()}&brandId=${nike.brandId}`);
    expect(top.body.map((r: any) => r.label)).toEqual(["Nike Dunk Low Panda (Size 10 / New)"]);
    const daily = await w.as(w.manager, "GET", `/reports/sales-by-period?${today()}&group=day&brandId=${nike.brandId}`);
    expect(daily.body.reduce((a: number, r: any) => a + r.netCents, 0)).toBe(12000);
    expect((await w.as(w.manager, "GET", `/reports/sales-by-period?${today()}&group=day&vendorId=${vendor.id}`)).body.reduce((a: number, r: any) => a + r.units, 0)).toBe(1);
    expect((await w.as(w.manager, "GET", `/reports/sales-by-period?${today()}&group=day&kind=TCG_SINGLE`)).body.reduce((a: number, r: any) => a + r.units, 0)).toBe(2);

    // Stock reports by brand.
    const value = await w.as(w.manager, "GET", `/reports/inventory-valuation?locationId=${w.locationId}&by=brand`);
    expect(value.body.byCategory.map((r: any) => [r.category, r.units])).toEqual([["nike", 3], ["No brand", 4]]);
    const nikeValue = await w.as(w.manager, "GET", `/reports/inventory-valuation?locationId=${w.locationId}&brandId=${nike.brandId}`);
    expect(nikeValue.body.total).toMatchObject({ units: 3, retailCents: 36000 });
    await w.as(w.manager, "PUT", `/inventory/${nike.variants[1]!.id}/low-stock`, { locationId: w.locationId, lowStockQty: 5 });
    await w.as(w.manager, "PUT", `/inventory/${v.nm}/low-stock`, { locationId: w.locationId, lowStockQty: 5 });
    expect((await w.as(w.manager, "GET", `/reports/low-stock?locationId=${w.locationId}`)).body).toHaveLength(2);
    expect((await w.as(w.manager, "GET", `/reports/low-stock?locationId=${w.locationId}&brandId=${nike.brandId}`)).body).toMatchObject([{ title: "Nike Dunk Low Panda", brand: "nike" }]);
    const dead = await w.as(w.manager, "GET", `/reports/no-sales?${today()}&brandId=${nike.brandId}`);
    expect(dead.body.map((r: any) => r.sku)).toEqual(["DD1391-100-10.5"]);
    const moves = await w.as(w.manager, "GET", `/reports/stock-movements?${today()}&brandId=${nike.brandId}`);
    expect(moves.body.every((m: any) => m.brand === "nike")).toBe(true);
    expect(moves.body).toHaveLength(3);
  });
});

describe("purchase order documents and lists", () => {
  it("filters the PO list, prints a PO, and prints a transfer with labels", async () => {
    const vendor = (await w.as(w.manager, "POST", "/vendors", { name: "Southern Hobby", accountNumber: "AC-55", contactName: "Sam", website: "https://southernhobby.com", address: "1 Main St" })).body;
    expect(vendor).toMatchObject({ accountNumber: "AC-55", contactName: "Sam" });
    const po = await w.as(w.manager, "POST", "/purchase-orders", { vendorId: vendor.id, locationId: w.locationId, reference: "WEEKLY-3", shippingCents: 1500, lines: [{ variantId: v.nm, quantity: 4, unitCostCents: 400 }] });
    await w.as(w.manager, "POST", `/purchase-orders/${po.body.id}/order`);
    const draft = await w.as(w.manager, "POST", "/purchase-orders", { vendorId: vendor.id, locationId: w.locationId, lines: [] });

    expect((await w.as(w.manager, "GET", "/purchase-orders?status=ORDERED")).body.map((o: any) => o.number)).toEqual([1]);
    expect((await w.as(w.manager, "GET", "/purchase-orders?q=weekly")).body.map((o: any) => o.number)).toEqual([1]);
    expect((await w.as(w.manager, "GET", "/purchase-orders?q=%232")).body.map((o: any) => o.id)).toEqual([draft.body.id]);
    expect((await w.as(w.manager, "GET", `/purchase-orders?vendorId=${vendor.id}&open=true`)).body).toHaveLength(2);

    const html = await w.app.inject({ method: "GET", url: `/purchase-orders/${po.body.id}/print`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain("WEEKLY-3");
    expect(html.body).toContain("Southern Hobby");
    expect(html.body).toContain("$15.00");
    expect(html.body).toContain("$31.00");

    const other = await prisma.location.create({ data: { name: "Mall Kiosk", cardPriceBps: 400 } });
    const t = await w.as(w.manager, "POST", "/transfers", { fromLocationId: w.locationId, toLocationId: other.id, reference: "RESTOCK-9", lines: [{ variantId: v.nm, quantity: 2 }] });
    expect(t.body.reference).toBe("RESTOCK-9");
    expect((await w.as(w.manager, "GET", "/transfers?q=restock")).body).toHaveLength(1);
    expect((await w.as(w.manager, "GET", `/transfers?toLocationId=${w.locationId}`)).body).toHaveLength(0);
    const slip = await w.app.inject({ method: "GET", url: `/transfers/${t.body.id}/print`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(slip.body).toContain("RESTOCK-9");
    expect(slip.body).toContain("Mall Kiosk");
    const labels = await w.app.inject({ method: "GET", url: `/transfers/${t.body.id}/labels`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(labels.body).toContain("Charizard ex");
    // Priced for the destination, which uses dual pricing: $10.00 cash / $10.40 card.
    expect(labels.body).toContain("$10.40");
    const zpl = await w.app.inject({ method: "GET", url: `/transfers/${t.body.id}/labels?format=zpl`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(zpl.body).toContain("^XA");

    await w.as(w.manager, "POST", `/transfers/${t.body.id}/send`);
    await w.as(w.manager, "POST", `/transfers/${t.body.id}/receive`, { lines: [{ variantId: v.nm, quantity: 2 }] });
    const report = await w.as(w.manager, "GET", `/reports/transfers?${today()}`);
    expect(report.body).toMatchObject({ transfers: 1, total: { qtySent: 2, qtyReceived: 2, priceSentCents: 2000 } });
    expect(report.body.rows[0]).toMatchObject({ destination: "Mall Kiosk", category: "Uncategorized" });
  });
});
