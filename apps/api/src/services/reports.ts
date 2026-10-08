import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";

export interface Range {
  from: Date;
  to: Date;
  locationId?: string;
  /** Narrow item-level reports to one brand / category / vendor / product type. */
  brandId?: string;
  categoryId?: string;
  vendorId?: string;
  kind?: string;
}

const orderWhere = (r: Range): Prisma.OrderWhereInput => ({
  status: { not: "VOID" },
  createdAt: { gte: r.from, lt: r.to },
  ...(r.locationId ? { locationId: r.locationId } : {}),
});

/** Which products a report covers (brand, category, vendor, kind). */
export const productWhere = (r: Pick<Range, "brandId" | "categoryId" | "vendorId" | "kind">): Prisma.ProductWhereInput => ({
  ...(r.brandId ? { brandId: r.brandId } : {}),
  ...(r.categoryId ? { categoryId: r.categoryId } : {}),
  ...(r.vendorId ? { vendors: { some: { vendorId: r.vendorId } } } : {}),
  ...(r.kind ? { kind: r.kind as Prisma.ProductWhereInput["kind"] } : {}),
});
const hasProductFilter = (r: Range) => !!(r.brandId || r.categoryId || r.vendorId || r.kind);
const variantWhere = (r: Range): Prisma.VariantWhereInput | undefined => (hasProductFilter(r) ? { product: productWhere(r) } : undefined);
/** Sold lines in the range, for the products the report covers. */
const lineWhere = (r: Range): Prisma.OrderLineWhereInput => ({ order: orderWhere(r), ...(hasProductFilter(r) ? { variant: variantWhere(r) } : {}) });

/** Net value of a line after refunds and all discounts. */
const lineNet = (l: { unitPriceCents: number; quantity: number; discountCents: number; refundedQty: number }) =>
  Math.round(((l.unitPriceCents * l.quantity - l.discountCents) * (l.quantity - l.refundedQty)) / l.quantity);

export async function salesSummary(db: Db, r: Range) {
  const filtered = hasProductFilter(r);
  const [orders, lines, refunds, buylists] = await Promise.all([
    db.order.findMany({
      where: { ...orderWhere(r), ...(filtered ? { lines: { some: { variant: variantWhere(r) } } } : {}) },
      select: { id: true, subtotalCents: true, discountCents: true, taxCents: true, totalCents: true, cardAdjustmentCents: true, cardAdjustmentTaxCents: true, loyaltyEarned: true },
    }),
    db.orderLine.findMany({ where: lineWhere(r), select: { unitPriceCents: true, quantity: true, discountCents: true, promoDiscountCents: true, rewardDiscountCents: true, refundedQty: true, costCents: true } }),
    db.payment.aggregate({ where: { amountCents: { lt: 0 }, status: "APPROVED", createdAt: { gte: r.from, lt: r.to }, order: r.locationId ? { locationId: r.locationId } : {} }, _sum: { amountCents: true } }),
    db.buylistTicket.aggregate({ where: { status: "ACCEPTED", acceptedAt: { gte: r.from, lt: r.to }, ...(r.locationId ? { locationId: r.locationId } : {}) }, _sum: { paidCents: true }, _count: true }),
  ]);
  const gross = lines.reduce((a, l) => a + l.unitPriceCents * (l.quantity - l.refundedQty), 0);
  const net = lines.reduce((a, l) => a + lineNet(l), 0);
  const cost = lines.reduce((a, l) => a + (l.costCents ?? 0) * (l.quantity - l.refundedQty), 0);
  const units = lines.reduce((a, l) => a + l.quantity - l.refundedQty, 0);
  const manualDiscounts = lines.reduce((a, l) => a + (l.discountCents - l.promoDiscountCents - l.rewardDiscountCents), 0);
  return {
    orders: orders.length,
    units,
    grossCents: gross,
    discountCents: orders.reduce((a, o) => a + o.discountCents, 0),
    manualDiscountCents: manualDiscounts,
    dealDiscountCents: lines.reduce((a, l) => a + l.promoDiscountCents, 0),
    rewardDiscountCents: lines.reduce((a, l) => a + l.rewardDiscountCents, 0),
    netSalesCents: net,
    taxCents: orders.reduce((a, o) => a + o.taxCents + o.cardAdjustmentTaxCents, 0),
    cardAdjustmentCents: orders.reduce((a, o) => a + o.cardAdjustmentCents, 0),
    collectedCents: orders.reduce((a, o) => a + o.totalCents + o.cardAdjustmentCents, 0),
    refundedCents: -(refunds._sum.amountCents ?? 0),
    costOfGoodsCents: cost,
    grossProfitCents: net - cost,
    marginBps: net > 0 ? Math.round(((net - cost) * 10_000) / net) : 0,
    averageTicketCents: orders.length ? Math.round(net / orders.length) : 0,
    tradeIns: { tickets: buylists._count, paidCents: buylists._sum.paidCents ?? 0 },
  };
}

/** Sales per day / week / month / hour, in the store's time zone. */
export async function salesByPeriod(db: Db, r: Range, group: "hour" | "day" | "week" | "month", timeZone: string) {
  const loc = r.locationId ?? null;
  const brand = r.brandId ?? null;
  const category = r.categoryId ?? null;
  const vendor = r.vendorId ?? null;
  const kind = r.kind ?? null;
  const [sales, taxes] = await Promise.all([
    db.$queryRaw<{ period: Date; orders: bigint; net: bigint; units: bigint }[]>`
      SELECT date_trunc(${group}, o."createdAt" AT TIME ZONE ${timeZone}) AS period,
             COUNT(DISTINCT o.id) AS orders,
             COALESCE(SUM(ROUND((l."unitPriceCents" * l.quantity - l."discountCents") * (l.quantity - l."refundedQty")::numeric / l.quantity)), 0) AS net,
             COALESCE(SUM(l.quantity - l."refundedQty"), 0) AS units
      FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id JOIN "Variant" v ON v.id = l."variantId" JOIN "Product" p ON p.id = v."productId"
      WHERE o.status <> 'VOID' AND o."createdAt" >= ${r.from} AND o."createdAt" < ${r.to} AND (${loc}::text IS NULL OR o."locationId" = ${loc})
        AND (${brand}::text IS NULL OR p."brandId" = ${brand})
        AND (${category}::text IS NULL OR p."categoryId" = ${category})
        AND (${kind}::text IS NULL OR p.kind::text = ${kind})
        AND (${vendor}::text IS NULL OR EXISTS (SELECT 1 FROM "ProductVendor" pv WHERE pv."productId" = p.id AND pv."vendorId" = ${vendor}))
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<{ period: Date; tax: bigint }[]>`
      SELECT date_trunc(${group}, o."createdAt" AT TIME ZONE ${timeZone}) AS period, COALESCE(SUM(o."taxCents" + o."cardAdjustmentTaxCents"), 0) AS tax
      FROM "Order" o
      WHERE o.status <> 'VOID' AND o."createdAt" >= ${r.from} AND o."createdAt" < ${r.to} AND (${loc}::text IS NULL OR o."locationId" = ${loc})
      GROUP BY 1`,
  ]);
  const key = (d: Date) => new Date(d).toISOString();
  const tax = new Map(taxes.map((t) => [key(t.period), Number(t.tax)]));
  return sales.map((x) => ({ period: key(x.period), orders: Number(x.orders), netCents: Number(x.net), taxCents: tax.get(key(x.period)) ?? 0, units: Number(x.units) }));
}

type Dim = "category" | "kind" | "employee" | "product" | "brand" | "game" | "vendor";

/** Net sales grouped by category / product type / employee / item / brand / game / vendor. */
export async function salesBy(db: Db, r: Range, dim: Dim, limit = 100) {
  const lines = await db.orderLine.findMany({
    where: lineWhere(r),
    include: { variant: { include: { product: { include: { category: true, vendors: { include: { vendor: true }, orderBy: [{ preferred: "desc" }, { createdAt: "asc" }] } } } } }, order: { include: { staff: true } } },
  });
  const rows = new Map<string, { key: string; label: string; units: number; netCents: number; costCents: number; orders: Set<string> }>();
  for (const l of lines) {
    const p = l.variant.product;
    const [key, label] =
      dim === "category" ? [p.categoryId ?? "none", p.category?.name ?? "Uncategorized"]
      : dim === "kind" ? [p.kind, p.kind]
      : dim === "employee" ? [l.order.staffId ?? "none", l.order.staff?.name ?? "Online / unknown"]
      : dim === "product" ? [l.variantId, l.title]
      : dim === "brand" ? [p.brandId ?? "none", p.brand ?? "No brand"]
      : dim === "vendor" ? [p.vendors[0]?.vendorId ?? "none", p.vendors[0]?.vendor.name ?? "No vendor"]
      : [p.game ?? "none", p.game ?? "Not a card"];
    const e = rows.get(key) ?? { key, label, units: 0, netCents: 0, costCents: 0, orders: new Set<string>() };
    const units = l.quantity - l.refundedQty;
    e.units += units;
    e.netCents += lineNet(l);
    e.costCents += (l.costCents ?? 0) * units;
    e.orders.add(l.orderId);
    rows.set(key, e);
  }
  return [...rows.values()]
    .map((e) => ({ key: e.key, label: e.label, units: e.units, netCents: e.netCents, costCents: e.costCents, profitCents: e.netCents - e.costCents, orders: e.orders.size }))
    .sort((a, b) => b.netCents - a.netCents)
    .slice(0, limit);
}

export async function salesByTender(db: Db, r: Range) {
  const rows = await db.payment.groupBy({
    by: ["tender"],
    where: { status: "APPROVED", createdAt: { gte: r.from, lt: r.to }, OR: [{ order: { ...(r.locationId ? { locationId: r.locationId } : {}), status: { not: "VOID" } } }, { preorder: r.locationId ? { locationId: r.locationId } : {} }] },
    _sum: { amountCents: true, changeCents: true },
    _count: true,
  });
  return rows.map((p) => ({ tender: p.tender, count: p._count, netCents: p._sum.amountCents ?? 0 })).sort((a, b) => b.netCents - a.netCents);
}

export async function discountsReport(db: Db, r: Range) {
  const [manual, deals] = await Promise.all([
    db.orderLine.findMany({ where: { order: orderWhere(r), discountReason: { not: null } }, select: { discountReason: true, discountCents: true, promoDiscountCents: true, rewardDiscountCents: true } }),
    db.order.findMany({ where: orderWhere(r), select: { appliedPromotions: true } }),
  ]);
  const byReason = new Map<string, { reason: string; count: number; amountCents: number }>();
  for (const l of manual) {
    const amt = l.discountCents - l.promoDiscountCents - l.rewardDiscountCents;
    const e = byReason.get(l.discountReason!) ?? { reason: l.discountReason!, count: 0, amountCents: 0 };
    e.count++;
    e.amountCents += amt;
    byReason.set(l.discountReason!, e);
  }
  const byDeal = new Map<string, { name: string; count: number; amountCents: number }>();
  for (const o of deals) {
    for (const a of (o.appliedPromotions as { name: string; discountCents: number }[]) ?? []) {
      const e = byDeal.get(a.name) ?? { name: a.name, count: 0, amountCents: 0 };
      e.count++;
      e.amountCents += a.discountCents;
      byDeal.set(a.name, e);
    }
  }
  return { manual: [...byReason.values()].sort((a, b) => b.amountCents - a.amountCents), deals: [...byDeal.values()].sort((a, b) => b.amountCents - a.amountCents) };
}

export async function taxReport(db: Db, r: Range) {
  const orders = await db.order.findMany({ where: orderWhere(r), select: { taxCents: true, cardAdjustmentTaxCents: true, subtotalCents: true, discountCents: true, lines: { select: { taxable: true, unitPriceCents: true, quantity: true, discountCents: true, refundedQty: true } } } });
  let taxable = 0;
  let exempt = 0;
  for (const o of orders) for (const l of o.lines) (l.taxable ? (taxable += lineNet(l)) : (exempt += lineNet(l)));
  return { taxableSalesCents: taxable, exemptSalesCents: exempt, taxCollectedCents: orders.reduce((a, o) => a + o.taxCents + o.cardAdjustmentTaxCents, 0), orders: orders.length };
}

export type StockFilter = Pick<Range, "locationId" | "brandId" | "categoryId" | "vendorId" | "kind">;
const levelWhere = (f: StockFilter): Prisma.InventoryLevelWhereInput => ({
  ...(f.locationId ? { locationId: f.locationId } : {}),
  ...(f.brandId || f.categoryId || f.vendorId || f.kind ? { variant: { product: productWhere(f) } } : {}),
});

/** What's on the shelves, at cost and at retail, by category or brand. */
export async function inventoryValuation(db: Db, f: StockFilter | string | undefined, by: "category" | "brand" = "category") {
  const filter: StockFilter = typeof f === "string" ? { locationId: f } : (f ?? {});
  const levels = await db.inventoryLevel.findMany({
    where: { ...levelWhere(filter), onHand: { gt: 0 } },
    include: { variant: { include: { product: { include: { category: true } } } } },
  });
  const rows = new Map<string, { category: string; units: number; costCents: number; retailCents: number; skus: number }>();
  let total = { units: 0, costCents: 0, retailCents: 0, skus: 0 };
  for (const l of levels) {
    const key = by === "brand" ? (l.variant.product.brand ?? "No brand") : (l.variant.product.category?.name ?? "Uncategorized");
    const e = rows.get(key) ?? { category: key, units: 0, costCents: 0, retailCents: 0, skus: 0 };
    e.units += l.onHand;
    e.costCents += (l.variant.costCents ?? 0) * l.onHand;
    e.retailCents += l.variant.priceCents * l.onHand;
    e.skus++;
    rows.set(key, e);
    total = { units: total.units + l.onHand, costCents: total.costCents + (l.variant.costCents ?? 0) * l.onHand, retailCents: total.retailCents + l.variant.priceCents * l.onHand, skus: total.skus + 1 };
  }
  return { byCategory: [...rows.values()].sort((a, b) => b.retailCents - a.retailCents), total };
}

export async function lowStock(db: Db, f: StockFilter | string | undefined) {
  const filter: StockFilter = typeof f === "string" ? { locationId: f } : (f ?? {});
  const levels = await db.inventoryLevel.findMany({ where: { ...levelWhere(filter), lowStockQty: { not: null } }, include: { variant: { include: { product: true } }, location: true } });
  return levels
    .filter((l) => l.onHand <= (l.lowStockQty ?? 0))
    .map((l) => ({ variantId: l.variantId, sku: l.variant.sku, title: l.variant.product.title, brand: l.variant.product.brand, location: l.location.name, onHand: l.onHand, lowStockQty: l.lowStockQty }))
    .sort((a, b) => a.onHand - b.onHand);
}

/** Items that haven't sold in the range but are in stock (dead stock). */
export async function noSales(db: Db, r: Range, limit = 200) {
  const sold = await db.orderLine.findMany({ where: { order: orderWhere(r) }, select: { variantId: true }, distinct: ["variantId"] });
  const soldIds = new Set(sold.map((s) => s.variantId));
  const levels = await db.inventoryLevel.findMany({ where: { ...levelWhere(r), onHand: { gt: 0 } }, include: { variant: { include: { product: true } } } });
  return levels
    .filter((l) => !soldIds.has(l.variantId))
    .map((l) => ({ variantId: l.variantId, sku: l.variant.sku, title: l.variant.product.title, brand: l.variant.product.brand, onHand: l.onHand, retailCents: l.variant.priceCents * l.onHand, costCents: (l.variant.costCents ?? 0) * l.onHand }))
    .sort((a, b) => b.retailCents - a.retailCents)
    .slice(0, limit);
}

export async function tradeInReport(db: Db, r: Range) {
  const tickets = await db.buylistTicket.findMany({ where: { status: "ACCEPTED", acceptedAt: { gte: r.from, lt: r.to }, ...(r.locationId ? { locationId: r.locationId } : {}) }, include: { lines: true, staff: true } });
  const byPayout = { CASH: { tickets: 0, paidCents: 0 }, STORE_CREDIT: { tickets: 0, paidCents: 0 } };
  const byStaff = new Map<string, { staff: string; tickets: number; paidCents: number }>();
  let items = 0;
  let suggested = 0;
  let paidTotal = 0;
  for (const t of tickets) {
    const p = byPayout[t.payout ?? "CASH"];
    p.tickets++;
    p.paidCents += t.paidCents ?? 0;
    const s = byStaff.get(t.staffId ?? "none") ?? { staff: t.staff?.name ?? "Unknown", tickets: 0, paidCents: 0 };
    s.tickets++;
    s.paidCents += t.paidCents ?? 0;
    byStaff.set(t.staffId ?? "none", s);
    for (const l of t.lines) {
      items += l.quantity;
      const sug = t.payout === "STORE_CREDIT" ? l.suggestedCreditCents : l.suggestedCashCents;
      const paid = t.payout === "STORE_CREDIT" ? l.creditOfferCents : l.cashOfferCents;
      suggested += (sug ?? paid) * l.quantity;
      paidTotal += paid * l.quantity;
    }
  }
  return { tickets: tickets.length, items, paidCents: paidTotal, suggestedCents: suggested, overSuggestedCents: Math.max(0, paidTotal - suggested), byPayout, byStaff: [...byStaff.values()] };
}

/** Today at a glance for the back-office home page. */
export async function dashboard(db: Db, locationId: string | undefined, timeZone: string, now = new Date()) {
  const local = new Date(now.toLocaleString("en-US", { timeZone }));
  const startLocal = new Date(local.getFullYear(), local.getMonth(), local.getDate());
  // Convert local midnight back to an instant.
  const offsetMs = local.getTime() - now.getTime();
  const from = new Date(startLocal.getTime() - offsetMs);
  const to = new Date(from.getTime() + 86_400_000);
  const r: Range = { from, to, locationId };
  const [today, hourly, topItems, tenders, low, pendingPayments, openPos, inTransit] = await Promise.all([
    salesSummary(db, r),
    salesByPeriod(db, r, "hour", timeZone),
    salesBy(db, r, "product", 5),
    salesByTender(db, r),
    lowStock(db, locationId),
    db.payment.count({ where: { status: "PENDING", tender: "CARD" } }),
    db.purchaseOrder.count({ where: { status: { in: ["ORDERED", "PARTIAL"] }, ...(locationId ? { locationId } : {}) } }),
    db.transfer.count({ where: { status: "SENT", ...(locationId ? { OR: [{ fromLocationId: locationId }, { toLocationId: locationId }] } : {}) } }),
  ]);
  return { date: from.toISOString(), today, hourly, topItems, tenders, lowStock: low.slice(0, 10), lowStockCount: low.length, pendingPayments, openPurchaseOrders: openPos, transfersInTransit: inTransit };
}

/** Rows -> CSV (RFC 4180 quoting). */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

/** Purchase orders and deliveries in a range: what's open, what arrived, what it cost. */
export async function purchaseReport(db: Db, r: Range, vendorId?: string) {
  const where = { ...(r.locationId ? { locationId: r.locationId } : {}), ...(vendorId ? { vendorId } : {}) };
  const [orders, receipts] = await Promise.all([
    db.purchaseOrder.findMany({ where: { ...where, createdAt: { gte: r.from, lt: r.to } }, include: { vendor: true, lines: true } }),
    db.purchaseReceipt.findMany({
      where: { receivedAt: { gte: r.from, lt: r.to }, purchaseOrder: where },
      include: { lines: true, purchaseOrder: { include: { vendor: true, location: true } } },
      orderBy: { receivedAt: "desc" },
    }),
  ]);
  const byVendor = new Map<string, { vendor: string; orders: number; openOrders: number; orderedCents: number; receivedQty: number; spendCents: number }>();
  for (const o of orders) {
    const e = byVendor.get(o.vendorId) ?? { vendor: o.vendor.name, orders: 0, openOrders: 0, orderedCents: 0, receivedQty: 0, spendCents: 0 };
    e.orders++;
    if (o.status === "ORDERED" || o.status === "PARTIAL" || o.status === "DRAFT") e.openOrders++;
    e.orderedCents += o.lines.reduce((a, l) => a + l.quantity * l.unitCostCents, 0) + o.shippingCents;
    byVendor.set(o.vendorId, e);
  }
  let receivedQty = 0;
  let spend = 0;
  for (const rc of receipts) {
    const qty = rc.lines.reduce((a, l) => a + l.quantity, 0);
    const cost = rc.lines.reduce((a, l) => a + l.quantity * l.unitCostCents, 0);
    receivedQty += qty;
    spend += cost;
    const e = byVendor.get(rc.purchaseOrder.vendorId) ?? { vendor: rc.purchaseOrder.vendor.name, orders: 0, openOrders: 0, orderedCents: 0, receivedQty: 0, spendCents: 0 };
    e.receivedQty += qty;
    e.spendCents += cost;
    byVendor.set(rc.purchaseOrder.vendorId, e);
  }
  return {
    orders: orders.length,
    openOrders: orders.filter((o) => o.status === "ORDERED" || o.status === "PARTIAL" || o.status === "DRAFT").length,
    finishedOrders: orders.filter((o) => o.status === "RECEIVED").length,
    receivedQty,
    receiptSpendCents: spend,
    byVendor: [...byVendor.values()].sort((a, b) => b.spendCents - a.spendCents),
    receipts: receipts.map((rc) => ({
      receiptId: rc.id,
      poNumber: rc.purchaseOrder.number,
      vendor: rc.purchaseOrder.vendor.name,
      location: rc.purchaseOrder.location.name,
      reference: rc.reference,
      receivedAt: rc.receivedAt,
      items: rc.lines.length,
      quantity: rc.lines.reduce((a, l) => a + l.quantity, 0),
      costCents: rc.lines.reduce((a, l) => a + l.quantity * l.unitCostCents, 0),
    })),
  };
}

/** Finished transfers in a range, valued by destination and then category. */
export async function transferReport(db: Db, r: Range) {
  const transfers = await db.transfer.findMany({
    where: { status: "RECEIVED", receivedAt: { gte: r.from, lt: r.to }, ...(r.locationId ? { OR: [{ fromLocationId: r.locationId }, { toLocationId: r.locationId }] } : {}) },
    include: { fromLocation: true, toLocation: true, lines: { include: { variant: { include: { product: { include: { category: true } } } } } } },
  });
  const rows = new Map<string, { destination: string; category: string; transfers: Set<string>; qtySent: number; qtyReceived: number; costSentCents: number; costReceivedCents: number; priceSentCents: number; priceReceivedCents: number }>();
  for (const t of transfers) {
    for (const l of t.lines) {
      const category = l.variant.product.category?.name ?? "Uncategorized";
      const key = `${t.toLocationId}|${category}`;
      const e = rows.get(key) ?? { destination: t.toLocation.name, category, transfers: new Set<string>(), qtySent: 0, qtyReceived: 0, costSentCents: 0, costReceivedCents: 0, priceSentCents: 0, priceReceivedCents: 0 };
      const cost = l.variant.costCents ?? 0;
      e.transfers.add(t.id);
      e.qtySent += l.quantity;
      e.qtyReceived += l.receivedQty;
      e.costSentCents += cost * l.quantity;
      e.costReceivedCents += cost * l.receivedQty;
      e.priceSentCents += l.variant.priceCents * l.quantity;
      e.priceReceivedCents += l.variant.priceCents * l.receivedQty;
      rows.set(key, e);
    }
  }
  const list = [...rows.values()].map((e) => ({ ...e, transfers: e.transfers.size })).sort((a, b) => a.destination.localeCompare(b.destination) || b.priceReceivedCents - a.priceReceivedCents);
  const total = list.reduce((a, e) => ({ qtySent: a.qtySent + e.qtySent, qtyReceived: a.qtyReceived + e.qtyReceived, costSentCents: a.costSentCents + e.costSentCents, costReceivedCents: a.costReceivedCents + e.costReceivedCents, priceSentCents: a.priceSentCents + e.priceSentCents, priceReceivedCents: a.priceReceivedCents + e.priceReceivedCents }), { qtySent: 0, qtyReceived: 0, costSentCents: 0, costReceivedCents: 0, priceSentCents: 0, priceReceivedCents: 0 });
  return { transfers: transfers.length, rows: list, total };
}

/**
 * The instants a calendar day starts and ends in a time zone ("2026-10-08" in
 * America/New_York → 04:00Z that day until 04:00Z the next). DST-aware.
 */
export function localDayRange(date: string, timeZone: string): { from: Date; to: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error("Date must be YYYY-MM-DD");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const midnight = (dayOffset: number): Date => {
    const wanted = Date.UTC(y, mo - 1, d + dayOffset);
    let guess = wanted;
    // Read the guess back as wall-clock time in the zone and correct by the difference (twice for DST edges).
    for (let i = 0; i < 2; i++) {
      const local = new Date(new Date(guess).toLocaleString("en-US", { timeZone }));
      const asUtc = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds());
      guess += wanted - asUtc;
    }
    return new Date(guess);
  };
  return { from: midnight(0), to: midnight(1) };
}
