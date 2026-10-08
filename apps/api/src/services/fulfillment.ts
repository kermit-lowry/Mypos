import { formatBps } from "@mypos/shared";
import type { FulfillmentMethod, FulfillmentStatus, OrderStatus, Prisma } from "@prisma/client";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import type { Ctx } from "./context.js";
import { audit } from "./permissions.js";

/**
 * Online orders (web store, Shopify, eBay...) land in a queue the register
 * watches: NEW → ACKNOWLEDGED → PICKING → READY → PICKED_UP | SHIPPED.
 * PROBLEM parks one that can't be filled; reopen puts it back.
 */

/** Statuses still needing work. SHIPPED and PICKED_UP are done. */
export const OPEN_STATUSES: FulfillmentStatus[] = ["NEW", "ACKNOWLEDGED", "PICKING", "READY", "PROBLEM"];
/** A refunded or voided order leaves the queue whatever its fulfillment status. */
export const CLOSED_ORDER_STATUSES: OrderStatus[] = ["REFUNDED", "VOID"];

export const openWhere = (locationId?: string): Prisma.OrderWhereInput => ({
  fulfillmentStatus: { in: OPEN_STATUSES },
  status: { notIn: CLOSED_ORDER_STATUSES },
  ...(locationId ? { locationId } : {}),
});

const TENDER_LABELS: Record<string, string> = {
  CARD: "Card",
  CASH: "Cash",
  CHECK: "Check",
  STORE_CREDIT: "Store credit",
  LOYALTY: "Rewards",
  GIFT_CARD: "Gift card",
  PREORDER_DEPOSIT: "Preorder deposit",
  EXTERNAL: "Paid online",
};

export interface ShippingAddressJson {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
}

const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// ── Queue ────────────────────────────────────────────────────────

/** Cheap summary the register polls: open counts, how many new orders arrived since `since`, the newest ten. */
export async function fulfillmentQueue(db: Db, q: { locationId?: string; since?: Date }) {
  const where = openWhere(q.locationId);
  const [groups, newSince, latest] = await Promise.all([
    db.order.groupBy({ by: ["fulfillmentStatus"], where, _count: { _all: true } }),
    db.order.count({ where: { ...where, fulfillmentStatus: "NEW", ...(q.since ? { createdAt: { gt: q.since } } : {}) } }),
    db.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        number: true,
        channel: true,
        fulfillment: true,
        fulfillmentStatus: true,
        totalCents: true,
        cardAdjustmentCents: true,
        createdAt: true,
        customer: { select: { name: true } },
        lines: { select: { quantity: true } },
      },
    }),
  ]);
  const counts = { NEW: 0, ACKNOWLEDGED: 0, PICKING: 0, READY: 0, PROBLEM: 0, total: 0 };
  for (const g of groups) {
    const s = g.fulfillmentStatus as keyof typeof counts | null;
    if (s && s in counts) counts[s] = g._count._all;
  }
  counts.total = counts.NEW + counts.ACKNOWLEDGED + counts.PICKING + counts.READY + counts.PROBLEM;
  return {
    counts,
    newSince,
    latest: latest.map((o) => ({
      id: o.id,
      number: o.number,
      channel: o.channel,
      fulfillment: o.fulfillment,
      fulfillmentStatus: o.fulfillmentStatus,
      customer: { name: o.customer?.name ?? null },
      items: o.lines.reduce((a, l) => a + l.quantity, 0),
      /** What the customer paid (shipping and any card price adjustment included). */
      totalCents: o.totalCents + o.cardAdjustmentCents,
      createdAt: o.createdAt,
    })),
  };
}

// ── Orders ───────────────────────────────────────────────────────

const orderInclude = {
  customer: { select: { id: true, name: true, email: true, phone: true } },
  lines: { include: { variant: { select: { sku: true, imageUrl: true, product: { select: { imageUrl: true } } } } } },
  payments: true,
} satisfies Prisma.OrderInclude;
type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export interface FulfillmentOrder {
  id: string;
  number: number;
  channel: string;
  externalId: string | null;
  /** Payment status of the sale (PAID, PARTIALLY_REFUNDED, REFUNDED, VOID). */
  status: OrderStatus;
  fulfillment: FulfillmentMethod | null;
  fulfillmentStatus: FulfillmentStatus | null;
  customer: { id: string; name: string; email: string | null; phone: string | null } | null;
  customerNote: string | null;
  /** Staff/import note on the sale. */
  note: string | null;
  lines: { id: string; variantId: string; title: string; sku: string; quantity: number; unitPriceCents: number; discountCents: number; refundedQty: number; imageUrl: string | null; picked: boolean }[];
  pickedLineIds: string[];
  items: number;
  totals: { subtotalCents: number; discountCents: number; taxCents: number; shippingCents: number; totalCents: number; cardAdjustmentCents: number; chargedCents: number };
  shippingAddress: ShippingAddressJson | null;
  carrier: string | null;
  trackingNumber: string | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  readyAt: Date | null;
  shippedAt: Date | null;
  pickedUpAt: Date | null;
  fulfilledBy: { id: string; name: string } | null;
  /** Minutes since the order was placed. */
  ageMinutes: number;
  /** The note left when the order was flagged, while it is in PROBLEM. */
  problemNote: string | null;
}

export interface TimelineEntry {
  at: Date;
  event: string;
  by: string | null;
  note: string | null;
}

async function staffNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return new Map();
  const rows = await db.staff.findMany({ where: { id: { in: want } }, select: { id: true, name: true } });
  return new Map(rows.map((s) => [s.id, s.name]));
}

/** Latest PROBLEM note per order, for orders currently flagged. */
async function problemNotes(db: Db, orders: OrderRow[]): Promise<Map<string, string>> {
  const ids = orders.filter((o) => o.fulfillmentStatus === "PROBLEM").map((o) => o.id);
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const events = await db.auditEvent.findMany({ where: { action: "ORDER_PROBLEM" }, orderBy: { createdAt: "desc" }, take: 200 + ids.length * 5 });
  for (const e of events) {
    const d = e.details as { orderId?: string; note?: string } | null;
    if (d?.orderId && ids.includes(d.orderId) && !out.has(d.orderId)) out.set(d.orderId, d.note ?? "");
  }
  return out;
}

function shape(o: OrderRow, names: Map<string, string>, problemNote: string | null, now: Date): FulfillmentOrder {
  const picked = asIds(o.pickedLineIds);
  return {
    id: o.id,
    number: o.number,
    channel: o.channel,
    externalId: o.externalId,
    status: o.status,
    fulfillment: o.fulfillment,
    fulfillmentStatus: o.fulfillmentStatus,
    customer: o.customer ? { ...o.customer, phone: o.customerPhone ?? o.customer.phone } : null,
    customerNote: o.customerNote,
    note: o.note,
    lines: o.lines.map((l) => ({
      id: l.id,
      variantId: l.variantId,
      title: l.title,
      sku: l.variant.sku,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      discountCents: l.discountCents,
      refundedQty: l.refundedQty,
      imageUrl: l.variant.imageUrl ?? l.variant.product.imageUrl,
      picked: picked.includes(l.id),
    })),
    pickedLineIds: picked,
    items: o.lines.reduce((a, l) => a + l.quantity, 0),
    totals: {
      subtotalCents: o.subtotalCents,
      discountCents: o.discountCents,
      taxCents: o.taxCents,
      shippingCents: o.shippingCents,
      totalCents: o.totalCents,
      cardAdjustmentCents: o.cardAdjustmentCents,
      chargedCents: o.totalCents + o.cardAdjustmentCents,
    },
    shippingAddress: (o.shippingAddress as ShippingAddressJson | null) ?? null,
    carrier: o.carrier,
    trackingNumber: o.trackingNumber,
    createdAt: o.createdAt,
    acknowledgedAt: o.acknowledgedAt,
    readyAt: o.readyAt,
    shippedAt: o.shippedAt,
    pickedUpAt: o.pickedUpAt,
    fulfilledBy: o.fulfilledById ? { id: o.fulfilledById, name: names.get(o.fulfilledById) ?? "Unknown" } : null,
    ageMinutes: minutesBetween(o.createdAt, now),
    problemNote,
  };
}

export interface ListFilter {
  locationId?: string;
  /** Default: every open status. */
  status?: FulfillmentStatus[];
  fulfillment?: FulfillmentMethod;
  /** Order number ("#12" / "12"), customer name or email, or tracking number. */
  q?: string;
  /** Also show refunded / voided orders (hidden by default). */
  includeClosed?: boolean;
  take?: number;
}

export async function listFulfillmentOrders(db: Db, f: ListFilter): Promise<FulfillmentOrder[]> {
  const number = f.q && /^#?\d+$/.test(f.q) ? Number(f.q.replace("#", "")) : undefined;
  const where: Prisma.OrderWhereInput = {
    fulfillmentStatus: { in: f.status?.length ? f.status : OPEN_STATUSES },
    ...(f.includeClosed ? {} : { status: { notIn: CLOSED_ORDER_STATUSES } }),
    ...(f.locationId ? { locationId: f.locationId } : {}),
    ...(f.fulfillment ? { fulfillment: f.fulfillment } : {}),
    ...(f.q
      ? {
          OR: [
            // Digits are an order number, but also part of a tracking number or an outside channel's order id.
            ...(number !== undefined ? [{ number }] : [{ customer: { OR: [{ name: { contains: f.q, mode: "insensitive" as const } }, { email: { contains: f.q, mode: "insensitive" as const } }] } }]),
            { trackingNumber: { contains: f.q.replace(/^#/, ""), mode: "insensitive" } },
            { externalId: { contains: f.q.replace(/^#/, ""), mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const rows = await db.order.findMany({ where, orderBy: { createdAt: "desc" }, take: f.take ?? 50, include: orderInclude });
  const [names, problems] = await Promise.all([staffNames(db, rows.map((o) => o.fulfilledById)), problemNotes(db, rows)]);
  const now = new Date();
  return rows.map((o) => shape(o, names, problems.get(o.id) ?? null, now));
}

async function loadOnlineOrder(db: Db, id: string): Promise<OrderRow> {
  const o = await db.order.findUnique({ where: { id }, include: orderInclude });
  if (!o || !o.fulfillment) throw notFound("Online order");
  return o;
}

/** One order with its history: placed, each queue step (who, when, note), refunds. */
export async function getFulfillmentOrder(db: Db, id: string): Promise<FulfillmentOrder & { timeline: TimelineEntry[] }> {
  const o = await loadOnlineOrder(db, id);
  const events = await db.auditEvent.findMany({
    where: { action: { not: "REQUEST" }, details: { path: ["orderId"], equals: id } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const names = await staffNames(db, [o.fulfilledById, ...events.map((e) => e.staffId)]);
  const timeline: TimelineEntry[] = [{ at: o.createdAt, event: "ORDER_PLACED", by: null, note: null }];
  for (const e of events) {
    const d = e.details as { note?: string | null } | null;
    timeline.push({ at: e.createdAt, event: e.action, by: e.staffId ? (names.get(e.staffId) ?? null) : null, note: d?.note ?? null });
  }
  // Timestamps set without a logged step (e.g. readyAt stamped when an order ships straight from picking).
  const stamped: [Date | null, string][] = [
    [o.acknowledgedAt, "ORDER_ACKNOWLEDGED"],
    [o.readyAt, "ORDER_READY"],
    [o.shippedAt, "ORDER_SHIPPED"],
    [o.pickedUpAt, "ORDER_PICKED_UP"],
  ];
  for (const [at, event] of stamped) {
    if (at && !timeline.some((t) => t.event === event)) timeline.push({ at, event, by: o.fulfilledById ? (names.get(o.fulfilledById) ?? null) : null, note: null });
  }
  timeline.sort((a, b) => a.at.getTime() - b.at.getTime());
  const problem = o.fulfillmentStatus === "PROBLEM" ? ([...events].reverse().find((e) => e.action === "ORDER_PROBLEM")?.details as { note?: string } | undefined)?.note ?? null : null;
  return { ...shape(o, names, problem, new Date()), timeline };
}

// ── Actions ──────────────────────────────────────────────────────

export const FULFILLMENT_ACTIONS = {
  acknowledge: "ORDER_ACKNOWLEDGED",
  pick: "ORDER_PICKED",
  ready: "ORDER_READY",
  ship: "ORDER_SHIPPED",
  pickedUp: "ORDER_PICKED_UP",
  problem: "ORDER_PROBLEM",
  reopen: "ORDER_REOPENED",
} as const;

interface Transition {
  action: string;
  from: FulfillmentStatus[];
  to: FulfillmentStatus;
  /** Only orders fulfilled this way. */
  method?: FulfillmentMethod;
  data?: (o: OrderRow, now: Date) => Prisma.OrderUpdateManyMutationInput;
  details?: Prisma.InputJsonObject;
}

const stateError = (o: OrderRow, allowed: FulfillmentStatus[]) =>
  conflict("FULFILLMENT_STATE", `Order #${o.number} is ${CLOSED_ORDER_STATUSES.includes(o.status) ? o.status.toLowerCase() : (o.fulfillmentStatus ?? "not an online order")}`, {
    status: o.fulfillmentStatus,
    orderStatus: o.status,
    allowed,
  });

async function transition(ctx: Ctx, id: string, t: Transition): Promise<FulfillmentOrder & { timeline: TimelineEntry[] }> {
  const { prisma, actor } = ctx;
  if (!actor) throw forbidden("Sign in at the register first");
  const o = await loadOnlineOrder(prisma, id);
  if (CLOSED_ORDER_STATUSES.includes(o.status) || !o.fulfillmentStatus || !t.from.includes(o.fulfillmentStatus)) throw stateError(o, t.from);
  if (t.method && o.fulfillment !== t.method) {
    throw badRequest("FULFILLMENT_METHOD", `Order #${o.number} is a ${o.fulfillment === "SHIP" ? "shipping" : "pickup"} order`, { fulfillment: o.fulfillment });
  }
  const now = new Date();
  const from = o.fulfillmentStatus;
  await prisma.$transaction(async (tx) => {
    // Guarded on the status we read, so two registers can't both take the same step.
    const r = await tx.order.updateMany({
      where: { id, fulfillmentStatus: from, status: { notIn: CLOSED_ORDER_STATUSES } },
      data: { ...(t.data?.(o, now) ?? {}), fulfillmentStatus: t.to, fulfilledById: actor.id },
    });
    if (r.count === 0) throw conflict("FULFILLMENT_STATE", `Order #${o.number} was just updated by someone else`, { status: from, allowed: t.from });
    await audit(tx, {
      action: t.action,
      staffId: actor.id,
      locationId: o.locationId,
      details: { orderId: o.id, orderNumber: o.number, channel: o.channel, fulfillment: o.fulfillment, from, to: t.to, ...(t.details ?? {}) },
    });
  });
  return getFulfillmentOrder(prisma, id);
}

/** NEW → ACKNOWLEDGED: someone has seen it. */
export const acknowledgeOrder = (ctx: Ctx, id: string) =>
  transition(ctx, id, { action: FULFILLMENT_ACTIONS.acknowledge, from: ["NEW"], to: "ACKNOWLEDGED", data: (_o, now) => ({ acknowledgedAt: now }) });

/** Tick off the lines set aside so far. From NEW it also counts as acknowledged. */
export async function pickOrder(ctx: Ctx, id: string, pickedLineIds: string[]) {
  const o = await loadOnlineOrder(ctx.prisma, id);
  const ids = [...new Set(pickedLineIds)];
  const unknown = ids.filter((x) => !o.lines.some((l) => l.id === x));
  if (unknown.length) throw badRequest("LINE_IDS", "Those lines aren't on this order", { unknown });
  return transition(ctx, id, {
    action: FULFILLMENT_ACTIONS.pick,
    from: ["NEW", "ACKNOWLEDGED", "PICKING"],
    to: "PICKING",
    data: (cur, now) => ({ pickedLineIds: ids, acknowledgedAt: cur.acknowledgedAt ?? now }),
    details: { pickedLineIds: ids, picked: ids.length, of: o.lines.length },
  });
}

/** Everything is set aside (or `force` says so): READY for pickup / to pack. */
export async function readyOrder(ctx: Ctx, id: string, opts: { force?: boolean } = {}) {
  const o = await loadOnlineOrder(ctx.prisma, id);
  const picked = asIds(o.pickedLineIds);
  const missing = o.lines.filter((l) => l.quantity > l.refundedQty && !picked.includes(l.id)).map((l) => l.id);
  if (missing.length && !opts.force) throw conflict("NOT_ALL_PICKED", "Not every item has been set aside", { pickedLineIds: picked, missingLineIds: missing });
  return transition(ctx, id, {
    action: FULFILLMENT_ACTIONS.ready,
    from: ["NEW", "ACKNOWLEDGED", "PICKING"],
    to: "READY",
    data: (cur, now) => ({ readyAt: now, acknowledgedAt: cur.acknowledgedAt ?? now }),
    details: { forced: missing.length > 0, missingLineIds: missing },
  });
}

/** Shipping orders: handed to the carrier. */
export const shipOrder = (ctx: Ctx, id: string, input: { carrier: string; trackingNumber?: string; note?: string }) =>
  transition(ctx, id, {
    action: FULFILLMENT_ACTIONS.ship,
    from: ["READY", "PICKING"],
    to: "SHIPPED",
    method: "SHIP",
    data: (cur, now) => ({ shippedAt: now, readyAt: cur.readyAt ?? now, acknowledgedAt: cur.acknowledgedAt ?? now, carrier: input.carrier, trackingNumber: input.trackingNumber ?? null }),
    details: { carrier: input.carrier, trackingNumber: input.trackingNumber ?? null, note: input.note ?? null },
  });

/** Pickup orders: the customer collected it. */
export const pickedUpOrder = (ctx: Ctx, id: string, input: { note?: string } = {}) =>
  transition(ctx, id, {
    action: FULFILLMENT_ACTIONS.pickedUp,
    from: ["READY"],
    to: "PICKED_UP",
    method: "PICKUP",
    data: (_o, now) => ({ pickedUpAt: now }),
    details: { note: input.note ?? null },
  });

/** Park an order that can't be filled (out of stock, can't reach the customer...). */
export const problemOrder = (ctx: Ctx, id: string, input: { note: string }) =>
  transition(ctx, id, { action: FULFILLMENT_ACTIONS.problem, from: OPEN_STATUSES, to: "PROBLEM", details: { note: input.note } });

/** Put a parked (or ready) order back in the queue to be picked again. */
export const reopenOrder = (ctx: Ctx, id: string, input: { note?: string } = {}) =>
  transition(ctx, id, {
    action: FULFILLMENT_ACTIONS.reopen,
    from: ["PROBLEM", "READY"],
    to: "ACKNOWLEDGED",
    data: (cur, now) => ({ readyAt: null, acknowledgedAt: cur.acknowledgedAt ?? now }),
    details: { note: input.note ?? null },
  });

// ── Pick ticket / packing slip ───────────────────────────────────

export interface PickTicket {
  store: { name: string; address: string | null; phone: string | null; header: string | null; footer: string | null; timeZone: string };
  orderId: string;
  orderNumber: number;
  channel: string;
  externalId: string | null;
  fulfillment: FulfillmentMethod;
  fulfillmentStatus: FulfillmentStatus | null;
  createdAt: Date;
  customer: { name: string; email: string | null; phone: string | null } | null;
  customerNote: string | null;
  shippingAddress: ShippingAddressJson | null;
  pickupInstructions: string | null;
  lines: { id: string; sku: string; title: string; quantity: number; unitCents: number; totalCents: number; picked: boolean }[];
  items: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  shippingCents: number;
  /** Extra a card payment added over the cash price, when dual pricing is on. */
  cardAdjustmentCents: number;
  cardPricePercent: string | null;
  /** What the customer paid. */
  totalCents: number;
  payments: { label: string; amountCents: number; detail?: string }[];
  setAsideBy: string | null;
  setAsideAt: Date | null;
  carrier: string | null;
  trackingNumber: string | null;
}

export async function buildPickTicket(db: Db, id: string): Promise<PickTicket> {
  const o = await loadOnlineOrder(db, id);
  const [location, names] = await Promise.all([db.location.findUniqueOrThrow({ where: { id: o.locationId } }), staffNames(db, [o.fulfilledById])]);
  const picked = asIds(o.pickedLineIds);
  const paid = o.payments.filter((p) => p.amountCents > 0 && p.status === "APPROVED");
  return {
    store: { name: location.name, address: location.address, phone: location.phone, header: location.receiptHeader, footer: location.receiptFooter, timeZone: location.timezone },
    orderId: o.id,
    orderNumber: o.number,
    channel: o.channel,
    externalId: o.externalId,
    fulfillment: o.fulfillment!,
    fulfillmentStatus: o.fulfillmentStatus,
    createdAt: o.createdAt,
    customer: o.customer ? { name: o.customer.name, email: o.customer.email, phone: o.customerPhone ?? o.customer.phone } : null,
    customerNote: o.customerNote,
    shippingAddress: (o.shippingAddress as ShippingAddressJson | null) ?? null,
    pickupInstructions: o.fulfillment === "PICKUP" ? location.pickupInstructions : null,
    lines: o.lines.map((l) => ({
      id: l.id,
      sku: l.variant.sku,
      title: l.title,
      quantity: l.quantity,
      unitCents: l.unitPriceCents,
      totalCents: l.unitPriceCents * l.quantity - l.discountCents,
      picked: picked.includes(l.id),
    })),
    items: o.lines.reduce((a, l) => a + l.quantity, 0),
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    taxCents: o.taxCents,
    shippingCents: o.shippingCents,
    cardAdjustmentCents: o.cardAdjustmentCents,
    cardPricePercent: o.cardPriceBps > 0 ? formatBps(o.cardPriceBps) : null,
    totalCents: o.totalCents + o.cardAdjustmentCents,
    payments: paid.map((p) => ({
      label: TENDER_LABELS[p.tender] ?? p.tender,
      amountCents: p.amountCents,
      detail: p.cardLast4 ? `${p.cardBrand ?? "Card"} •••• ${p.cardLast4}` : p.tender === "EXTERNAL" && p.gatewayRef ? `#${p.gatewayRef}` : undefined,
    })),
    setAsideBy: o.readyAt && o.fulfilledById ? (names.get(o.fulfilledById) ?? null) : null,
    setAsideAt: o.readyAt,
    carrier: o.carrier,
    trackingNumber: o.trackingNumber,
  };
}

/** One line of a shipping address per element, for printing. */
export function addressLines(a: ShippingAddressJson | null): string[] {
  if (!a) return [];
  const cityLine = [a.city, a.state].filter(Boolean).join(", ") + (a.postalCode ? ` ${a.postalCode}` : "");
  return [a.name, a.line1, a.line2, cityLine.trim(), a.country && a.country !== "US" ? a.country : null, a.phone].filter((x): x is string => !!x && x.trim() !== "");
}
