import { Prisma } from "@prisma/client";
import type { Db } from "../db.js";

export interface Range {
  from: Date;
  to: Date;
  locationId?: string;
}

const orderWhere = (r: Range): Prisma.OrderWhereInput => ({
  status: { not: "VOID" },
  createdAt: { gte: r.from, lt: r.to },
  ...(r.locationId ? { locationId: r.locationId } : {}),
});

/** Net value of a line after refunds and all discounts. */
const lineNet = (l: { unitPriceCents: number; quantity: number; discountCents: number; refundedQty: number }) =>
  Math.round(((l.unitPriceCents * l.quantity - l.discountCents) * (l.quantity - l.refundedQty)) / l.quantity);

export async function salesSummary(db: Db, r: Range) {
  const [orders, lines, refunds, buylists] = await Promise.all([
    db.order.findMany({ where: orderWhere(r), select: { id: true, subtotalCents: true, discountCents: true, taxCents: true, totalCents: true, cardAdjustmentCents: true, cardAdjustmentTaxCents: true, loyaltyEarned: true } }),
    db.orderLine.findMany({ where: { order: orderWhere(r) }, select: { unitPriceCents: true, quantity: true, discountCents: true, promoDiscountCents: true, rewardDiscountCents: true, refundedQty: true, costCents: true } }),
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
  const [sales, taxes] = await Promise.all([
    db.$queryRaw<{ period: Date; orders: bigint; net: bigint; units: bigint }[]>`
      SELECT date_trunc(${group}, o."createdAt" AT TIME ZONE ${timeZone}) AS period,
             COUNT(DISTINCT o.id) AS orders,
             COALESCE(SUM(ROUND((l."unitPriceCents" * l.quantity - l."discountCents") * (l.quantity - l."refundedQty")::numeric / l.quantity)), 0) AS net,
             COALESCE(SUM(l.quantity - l."refundedQty"), 0) AS units
      FROM "Order" o JOIN "OrderLine" l ON l."orderId" = o.id
      WHERE o.status <> 'VOID' AND o."createdAt" >= ${r.from} AND o."createdAt" < ${r.to} AND (${loc}::text IS NULL OR o."locationId" = ${loc})
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

type Dim = "category" | "kind" | "employee" | "product" | "brand" | "game";

/** Net sales grouped by category / product type / employee / item / brand / game. */
export async function salesBy(db: Db, r: Range, dim: Dim, limit = 100) {
  const lines = await db.orderLine.findMany({
    where: { order: orderWhere(r) },
    include: { variant: { include: { product: { include: { category: true } } } }, order: { include: { staff: true } } },
  });
  const rows = new Map<string, { key: string; label: string; units: number; netCents: number; costCents: number; orders: Set<string> }>();
  for (const l of lines) {
    const p = l.variant.product;
    const [key, label] =
      dim === "category" ? [p.categoryId ?? "none", p.category?.name ?? "Uncategorized"]
      : dim === "kind" ? [p.kind, p.kind]
      : dim === "employee" ? [l.order.staffId ?? "none", l.order.staff?.name ?? "Online / unknown"]
      : dim === "product" ? [l.variantId, l.title]
      : dim === "brand" ? [p.brand ?? "none", p.brand ?? "No brand"]
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

/** What's on the shelves, at cost and at retail, by category. */
export async function inventoryValuation(db: Db, locationId?: string) {
  const levels = await db.inventoryLevel.findMany({
    where: { ...(locationId ? { locationId } : {}), onHand: { gt: 0 } },
    include: { variant: { include: { product: { include: { category: true } } } } },
  });
  const rows = new Map<string, { category: string; units: number; costCents: number; retailCents: number; skus: number }>();
  let total = { units: 0, costCents: 0, retailCents: 0, skus: 0 };
  for (const l of levels) {
    const key = l.variant.product.category?.name ?? "Uncategorized";
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

export async function lowStock(db: Db, locationId?: string) {
  const levels = await db.inventoryLevel.findMany({ where: { ...(locationId ? { locationId } : {}), lowStockQty: { not: null } }, include: { variant: { include: { product: true } }, location: true } });
  return levels
    .filter((l) => l.onHand <= (l.lowStockQty ?? 0))
    .map((l) => ({ variantId: l.variantId, sku: l.variant.sku, title: l.variant.product.title, location: l.location.name, onHand: l.onHand, lowStockQty: l.lowStockQty }))
    .sort((a, b) => a.onHand - b.onHand);
}

/** Items that haven't sold in the range but are in stock (dead stock). */
export async function noSales(db: Db, r: Range, limit = 200) {
  const sold = await db.orderLine.findMany({ where: { order: orderWhere(r) }, select: { variantId: true }, distinct: ["variantId"] });
  const soldIds = new Set(sold.map((s) => s.variantId));
  const levels = await db.inventoryLevel.findMany({ where: { ...(r.locationId ? { locationId: r.locationId } : {}), onHand: { gt: 0 } }, include: { variant: { include: { product: true } } } });
  return levels
    .filter((l) => !soldIds.has(l.variantId))
    .map((l) => ({ variantId: l.variantId, sku: l.variant.sku, title: l.variant.product.title, onHand: l.onHand, retailCents: l.variant.priceCents * l.onHand, costCents: (l.variant.costCents ?? 0) * l.onHand }))
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
