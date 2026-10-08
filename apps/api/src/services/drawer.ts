import type { CashMovementKind, DrawerSession, Prisma } from "@prisma/client";
import { formatCents } from "@mypos/shared";
import type { Db } from "../db.js";
import { badRequest, conflict, notFound } from "../errors.js";
import type { Ctx } from "./context.js";
import { drawerKickBytes } from "./escpos.js";
import { sendToPrinter } from "./labels.js";
import { audit } from "./permissions.js";

/**
 * Cash drawer sessions (shifts). A session belongs to one register: the
 * terminal it was opened for, or, with no terminal, the location's single
 * drawer. Cash sales, cash refunds, cash trade-in payouts and paid in/out
 * movements are attributed to the open session, so at close the expected
 * cash can be compared with a blind count.
 */

/** Denomination counts, cents → how many: { "2000": 5, "100": 20, "25": 40 }. */
export type DenominationCount = Record<string, number>;

/** What a denomination count adds up to; null when there is no count. */
export const countTotal = (count: DenominationCount | null | undefined): number | null =>
  count ? Object.entries(count).reduce((a, [denom, n]) => a + Number(denom) * n, 0) : null;

function checkCount(count: DenominationCount | undefined, enteredCents: number) {
  const sum = countTotal(count);
  if (sum !== null && sum !== enteredCents) {
    throw badRequest("COUNT_MISMATCH", `The denominations add up to ${formatCents(sum)}, not ${formatCents(enteredCents)}`, { countedCents: sum, enteredCents });
  }
}

const staffSelect = { select: { id: true, name: true } } as const;
export const sessionInclude = {
  openedBy: staffSelect,
  closedBy: staffSelect,
  movements: { include: { staff: staffSelect }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.DrawerSessionInclude;
export type SessionWithDetails = Prisma.DrawerSessionGetPayload<{ include: typeof sessionInclude }>;

// ── Open ─────────────────────────────────────────────────────────

export interface OpenDrawerInput {
  locationId: string;
  /** The register's card terminal; omit for a location with one shared drawer. */
  terminalId?: string;
  openingFloatCents: number;
  openingCount?: DenominationCount;
  notes?: string;
}

/** Start a shift: count the float in. One open session per register. */
export async function openDrawer(ctx: Ctx, input: OpenDrawerInput): Promise<SessionWithDetails> {
  const { prisma, actor } = ctx;
  const location = await prisma.location.findUnique({ where: { id: input.locationId } });
  if (!location) throw notFound("Location");
  const terminalId = input.terminalId ?? null;
  if (terminalId) {
    const t = await prisma.terminal.findUnique({ where: { id: terminalId } });
    if (!t || !t.active || t.locationId !== location.id) throw badRequest("TERMINAL", "That register isn't available at this location");
  }
  checkCount(input.openingCount, input.openingFloatCents);

  return prisma.$transaction(async (tx) => {
    // Serialize opens at a location so two registers can't both open the same drawer.
    await tx.$queryRaw`SELECT id FROM "Location" WHERE id = ${location.id} FOR UPDATE`;
    const open = await tx.drawerSession.findFirst({ where: { locationId: location.id, terminalId, status: "OPEN" } });
    if (open) {
      throw conflict("DRAWER_ALREADY_OPEN", `Drawer #${open.number} is already open on this register`, { sessionId: open.id, number: open.number });
    }
    const session = await tx.drawerSession.create({
      data: {
        locationId: location.id,
        terminalId,
        openedById: actor?.id,
        openingFloatCents: input.openingFloatCents,
        openingCount: input.openingCount,
        notes: input.notes,
      },
      include: sessionInclude,
    });
    await audit(tx, {
      action: "DRAWER_OPENED",
      staffId: actor?.id,
      locationId: location.id,
      details: { sessionId: session.id, number: session.number, terminalId, openingFloatCents: input.openingFloatCents },
    });
    return session;
  });
}

/**
 * The open session for a register: the terminal's own, else (for a terminal)
 * the location's terminal-less drawer, else null.
 */
export async function currentSession(db: Db, locationId: string, terminalId?: string | null): Promise<DrawerSession | null> {
  if (terminalId) {
    const own = await db.drawerSession.findFirst({ where: { locationId, terminalId, status: "OPEN" } });
    if (own) return own;
  }
  return db.drawerSession.findFirst({ where: { locationId, terminalId: null, status: "OPEN" } });
}

/** 409 DRAWER_CLOSED: the location insists cash goes into an open drawer session. */
export const drawerClosed = () => conflict("DRAWER_CLOSED", "Start a shift (open the cash drawer) before taking cash");

// ── Paid in / paid out / drops ───────────────────────────────────

export interface MovementInput {
  kind: CashMovementKind;
  /** Always positive; `kind` says which way the cash went. */
  amountCents: number;
  reason: string;
  note?: string;
  /** Manager who approved it with their PIN, if any. */
  approverId?: string;
}

const MOVEMENT_AUDIT: Record<CashMovementKind, string> = { PAID_IN: "CASH_PAID_IN", PAID_OUT: "CASH_PAID_OUT", DROP: "CASH_DROP" };

export async function addMovement(ctx: Ctx, sessionId: string, input: MovementInput) {
  const { prisma, actor } = ctx;
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw badRequest("AMOUNT", "Amount must be more than zero");
  const session = await prisma.drawerSession.findUnique({ where: { id: sessionId } });
  if (!session) throw notFound("Drawer session");
  if (session.status !== "OPEN") throw conflict("DRAWER_NOT_OPEN", `Drawer #${session.number} is closed`);

  const movement = await prisma.$transaction(async (tx) => {
    const m = await tx.cashMovement.create({
      data: { sessionId, kind: input.kind, amountCents: input.amountCents, reason: input.reason, note: input.note, staffId: actor?.id, approverId: input.approverId },
      include: { staff: staffSelect },
    });
    await audit(tx, {
      action: MOVEMENT_AUDIT[input.kind],
      staffId: actor?.id,
      approverId: input.approverId,
      locationId: session.locationId,
      details: { sessionId, number: session.number, amountCents: input.amountCents, reason: input.reason },
    });
    return m;
  });
  const drawerOpened = await kickDrawer(prisma, session.terminalId);
  return { ...movement, drawerOpened };
}

/** Pop the drawer through the register's receipt printer. Best effort: the cash moved either way. */
async function kickDrawer(db: Db, terminalId: string | null): Promise<boolean> {
  if (!terminalId) return false;
  const t = await db.terminal.findUnique({ where: { id: terminalId } });
  if (!t?.receiptPrinterHost) return false;
  try {
    await sendToPrinter(t.receiptPrinterHost, drawerKickBytes(), 2_000);
    return true;
  } catch (e) {
    console.warn(`[drawer] couldn't open the drawer at ${t.receiptPrinterHost}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ── Expected cash ────────────────────────────────────────────────

export interface ExpectedCash {
  openingFloatCents: number;
  /** Cash taken on sales, net of change handed back (a payment's amountCents is tendered − change). */
  cashSalesCents: number;
  /** Cash handed back on refunds (positive). */
  cashRefundsCents: number;
  /** Cash paid out for trade-ins (positive). */
  tradeInCashCents: number;
  paidInCents: number;
  paidOutCents: number;
  dropCents: number;
  /** float + sales − refunds − trade-ins + paid in − paid out − drops. */
  expectedCents: number;
}

export async function expectedCash(db: Db, session: Pick<DrawerSession, "id" | "openingFloatCents">): Promise<ExpectedCash> {
  const cash = { drawerSessionId: session.id, tender: "CASH", status: "APPROVED" as const };
  const [sales, refunds, tradeIns, moves] = await Promise.all([
    db.payment.aggregate({ where: { ...cash, amountCents: { gt: 0 } }, _sum: { amountCents: true } }),
    db.payment.aggregate({ where: { ...cash, amountCents: { lt: 0 } }, _sum: { amountCents: true } }),
    db.buylistTicket.aggregate({ where: { drawerSessionId: session.id, status: "ACCEPTED", payout: "CASH" }, _sum: { paidCents: true } }),
    db.cashMovement.groupBy({ by: ["kind"], where: { sessionId: session.id }, _sum: { amountCents: true } }),
  ]);
  const moved = (kind: CashMovementKind) => moves.find((m) => m.kind === kind)?._sum.amountCents ?? 0;
  const e = {
    openingFloatCents: session.openingFloatCents,
    cashSalesCents: sales._sum.amountCents ?? 0,
    cashRefundsCents: -(refunds._sum.amountCents ?? 0),
    tradeInCashCents: tradeIns._sum.paidCents ?? 0,
    paidInCents: moved("PAID_IN"),
    paidOutCents: moved("PAID_OUT"),
    dropCents: moved("DROP"),
  };
  return { ...e, expectedCents: e.openingFloatCents + e.cashSalesCents - e.cashRefundsCents - e.tradeInCashCents + e.paidInCents - e.paidOutCents - e.dropCents };
}

// ── X / Z report ─────────────────────────────────────────────────

export interface TenderRow {
  tender: string;
  count: number;
  amountCents: number;
}

export interface SessionReport {
  /** X = live, drawer still open; Z = closing report. */
  kind: "X" | "Z";
  generatedAt: string;
  session: {
    id: string;
    number: number;
    status: "OPEN" | "CLOSED";
    locationId: string;
    locationName: string;
    timeZone: string;
    terminalId: string | null;
    terminalName: string | null;
    openedBy: string | null;
    openedAt: string;
    closedBy: string | null;
    closedAt: string | null;
    approvedBy: string | null;
    notes: string | null;
  };
  cash: ExpectedCash & {
    countedCashCents: number | null;
    /** counted − expected (negative = short). */
    varianceCents: number | null;
    openingCount: DenominationCount | null;
    closingCount: DenominationCount | null;
  };
  movements: { id: string; kind: CashMovementKind; amountCents: number; reason: string; note: string | null; staff: string | null; createdAt: string }[];
  /** Sales rung up in this session (orders whose payments went into it). Refunds are listed separately, not netted. */
  sales: {
    orders: number;
    units: number;
    grossCents: number;
    discountCents: number;
    manualDiscountCents: number;
    dealDiscountCents: number;
    rewardDiscountCents: number;
    netSalesCents: number;
    taxCents: number;
    cardAdjustmentCents: number;
    /** What customers paid: net + tax + card adjustment. */
    collectedCents: number;
    byTender: TenderRow[];
    refunds: { count: number; amountCents: number; byTender: TenderRow[] };
    tradeIns: { tickets: number; paidCents: number; byPayout: Record<"CASH" | "STORE_CREDIT", { tickets: number; paidCents: number }> };
  };
  byEmployee: { staffId: string | null; name: string; orders: number; netCents: number; collectedCents: number }[];
}

export async function sessionReport(db: Db, session: DrawerSession): Promise<SessionReport> {
  const [location, terminal, staff, payments, buylists, movements, cash] = await Promise.all([
    db.location.findUniqueOrThrow({ where: { id: session.locationId } }),
    session.terminalId ? db.terminal.findUnique({ where: { id: session.terminalId } }) : null,
    db.staff.findMany({ where: { id: { in: [session.openedById, session.closedById, session.approvedById].filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    db.payment.findMany({
      where: { drawerSessionId: session.id, status: "APPROVED" },
      include: { order: { include: { lines: true, staff: staffSelect } } },
    }),
    db.buylistTicket.findMany({ where: { drawerSessionId: session.id, status: "ACCEPTED" } }),
    db.cashMovement.findMany({ where: { sessionId: session.id }, include: { staff: staffSelect }, orderBy: { createdAt: "asc" } }),
    expectedCash(db, session),
  ]);
  const name = (id: string | null) => (id ? (staff.find((s) => s.id === id)?.name ?? null) : null);

  const tenderRows = (rows: { tender: string; amountCents: number }[]): TenderRow[] => {
    const by = new Map<string, TenderRow>();
    for (const p of rows) {
      const e = by.get(p.tender) ?? { tender: p.tender, count: 0, amountCents: 0 };
      e.count++;
      e.amountCents += Math.abs(p.amountCents);
      by.set(p.tender, e);
    }
    return [...by.values()].sort((a, b) => b.amountCents - a.amountCents);
  };
  const taken = payments.filter((p) => p.amountCents > 0);
  const refunded = payments.filter((p) => p.amountCents < 0);

  // Each order once, however many tenders paid it.
  const orders = new Map<string, NonNullable<(typeof payments)[number]["order"]>>();
  for (const p of taken) if (p.order && p.order.status !== "VOID") orders.set(p.order.id, p.order);
  const sales = { orders: orders.size, units: 0, grossCents: 0, discountCents: 0, manualDiscountCents: 0, dealDiscountCents: 0, rewardDiscountCents: 0, netSalesCents: 0, taxCents: 0, cardAdjustmentCents: 0, collectedCents: 0 };
  const byEmployee = new Map<string, SessionReport["byEmployee"][number]>();
  for (const o of orders.values()) {
    const gross = o.lines.reduce((a, l) => a + l.unitPriceCents * l.quantity, 0);
    const discount = o.lines.reduce((a, l) => a + l.discountCents, 0);
    sales.units += o.lines.reduce((a, l) => a + l.quantity, 0);
    sales.grossCents += gross;
    sales.discountCents += discount;
    sales.dealDiscountCents += o.lines.reduce((a, l) => a + l.promoDiscountCents, 0);
    sales.rewardDiscountCents += o.lines.reduce((a, l) => a + l.rewardDiscountCents, 0);
    sales.taxCents += o.taxCents + o.cardAdjustmentTaxCents;
    sales.cardAdjustmentCents += o.cardAdjustmentCents;
    sales.collectedCents += o.totalCents + o.cardAdjustmentCents;
    const key = o.staffId ?? "none";
    const e = byEmployee.get(key) ?? { staffId: o.staffId, name: o.staff?.name ?? "Unknown", orders: 0, netCents: 0, collectedCents: 0 };
    e.orders++;
    e.netCents += gross - discount;
    e.collectedCents += o.totalCents + o.cardAdjustmentCents;
    byEmployee.set(key, e);
  }
  sales.manualDiscountCents = sales.discountCents - sales.dealDiscountCents - sales.rewardDiscountCents;
  sales.netSalesCents = sales.grossCents - sales.discountCents;

  const byPayout = { CASH: { tickets: 0, paidCents: 0 }, STORE_CREDIT: { tickets: 0, paidCents: 0 } };
  for (const t of buylists) {
    const p = byPayout[t.payout ?? "CASH"];
    p.tickets++;
    p.paidCents += t.paidCents ?? 0;
  }

  return {
    kind: session.status === "CLOSED" ? "Z" : "X",
    generatedAt: new Date().toISOString(),
    session: {
      id: session.id,
      number: session.number,
      status: session.status,
      locationId: location.id,
      locationName: location.name,
      timeZone: location.timezone,
      terminalId: session.terminalId,
      terminalName: terminal?.name ?? null,
      openedBy: name(session.openedById),
      openedAt: session.openedAt.toISOString(),
      closedBy: name(session.closedById),
      closedAt: session.closedAt?.toISOString() ?? null,
      approvedBy: name(session.approvedById),
      notes: session.notes,
    },
    cash: {
      ...cash,
      countedCashCents: session.countedCashCents,
      varianceCents: session.varianceCents,
      openingCount: (session.openingCount as DenominationCount | null) ?? null,
      closingCount: (session.closingCount as DenominationCount | null) ?? null,
    },
    movements: movements.map((m) => ({ id: m.id, kind: m.kind, amountCents: m.amountCents, reason: m.reason, note: m.note, staff: m.staff?.name ?? null, createdAt: m.createdAt.toISOString() })),
    sales: {
      ...sales,
      byTender: tenderRows(taken),
      refunds: { count: refunded.length, amountCents: refunded.reduce((a, p) => a - p.amountCents, 0), byTender: tenderRows(refunded) },
      tradeIns: { tickets: buylists.length, paidCents: buylists.reduce((a, t) => a + (t.paidCents ?? 0), 0), byPayout },
    },
    byEmployee: [...byEmployee.values()].sort((a, b) => b.netCents - a.netCents),
  };
}

// ── Close ────────────────────────────────────────────────────────

export interface CloseDrawerInput {
  countedCashCents: number;
  closingCount?: DenominationCount;
  notes?: string;
}

/**
 * Close with a blind count. A variance beyond the location's alert amount
 * calls `authorizeVariance` (which throws unless a manager approved; it may
 * return the approver's id). The closing (Z) report is stored on the session.
 */
export async function closeDrawer(
  ctx: Ctx,
  sessionId: string,
  input: CloseDrawerInput,
  authorizeVariance: () => Promise<string | undefined | void> = async () => undefined,
): Promise<{ session: SessionWithDetails; report: SessionReport }> {
  const { prisma, actor } = ctx;
  checkCount(input.closingCount, input.countedCashCents);
  return prisma.$transaction(async (tx) => {
    // Lock the session so two closes (or a close and a movement) serialize.
    await tx.$queryRaw`SELECT id FROM "DrawerSession" WHERE id = ${sessionId} FOR UPDATE`;
    const session = await tx.drawerSession.findUnique({ where: { id: sessionId }, include: { location: true } });
    if (!session) throw notFound("Drawer session");
    if (session.status !== "OPEN") throw conflict("DRAWER_NOT_OPEN", `Drawer #${session.number} is already closed`);

    const expected = await expectedCash(tx, session);
    const varianceCents = input.countedCashCents - expected.expectedCents;
    let approvedById: string | undefined;
    if (Math.abs(varianceCents) > session.location.cashVarianceAlertCents) approvedById = (await authorizeVariance()) ?? undefined;

    const closed = await tx.drawerSession.update({
      where: { id: sessionId },
      data: {
        status: "CLOSED",
        closedById: actor?.id,
        closedAt: new Date(),
        expectedCashCents: expected.expectedCents,
        countedCashCents: input.countedCashCents,
        varianceCents,
        closingCount: input.closingCount,
        approvedById,
        notes: input.notes ?? session.notes,
      },
    });
    const report = await sessionReport(tx, closed);
    const final = await tx.drawerSession.update({ where: { id: sessionId }, data: { closingReport: report as unknown as Prisma.InputJsonValue }, include: sessionInclude });
    await audit(tx, {
      action: "DRAWER_CLOSED",
      staffId: actor?.id,
      approverId: approvedById,
      locationId: session.locationId,
      details: { sessionId, number: session.number, expectedCents: expected.expectedCents, countedCents: input.countedCashCents, varianceCents },
    });
    return { session: final, report };
  });
}

// ── Shift rows for the daily close / shifts reports ──────────────

export interface ShiftRow {
  id: string;
  number: number;
  status: "OPEN" | "CLOSED";
  register: string | null;
  terminalId: string | null;
  openedBy: string | null;
  openedAt: Date;
  closedBy: string | null;
  closedAt: Date | null;
  floatCents: number;
  cashSalesCents: number;
  cashRefundsCents: number;
  tradeInCashCents: number;
  paidInCents: number;
  paidOutCents: number;
  dropCents: number;
  expectedCents: number;
  countedCents: number | null;
  varianceCents: number | null;
  approvedBy: string | null;
}

/** One row per session with its cash figures (live for open sessions). */
export async function shiftRows(db: Db, sessions: SessionWithDetails[]): Promise<ShiftRow[]> {
  const terminalIds = [...new Set(sessions.map((s) => s.terminalId).filter((x): x is string => !!x))];
  const approverIds = [...new Set(sessions.map((s) => s.approvedById).filter((x): x is string => !!x))];
  const [terminals, approvers] = await Promise.all([
    db.terminal.findMany({ where: { id: { in: terminalIds } }, select: { id: true, name: true } }),
    db.staff.findMany({ where: { id: { in: approverIds } }, select: { id: true, name: true } }),
  ]);
  return Promise.all(
    sessions.map(async (s) => {
      const cash = await expectedCash(db, s);
      return {
        id: s.id,
        number: s.number,
        status: s.status,
        register: s.terminalId ? (terminals.find((t) => t.id === s.terminalId)?.name ?? null) : null,
        terminalId: s.terminalId,
        openedBy: s.openedBy?.name ?? null,
        openedAt: s.openedAt,
        closedBy: s.closedBy?.name ?? null,
        closedAt: s.closedAt,
        floatCents: s.openingFloatCents,
        cashSalesCents: cash.cashSalesCents,
        cashRefundsCents: cash.cashRefundsCents,
        tradeInCashCents: cash.tradeInCashCents,
        paidInCents: cash.paidInCents,
        paidOutCents: cash.paidOutCents,
        dropCents: cash.dropCents,
        expectedCents: s.status === "CLOSED" && s.expectedCashCents !== null ? s.expectedCashCents : cash.expectedCents,
        countedCents: s.countedCashCents,
        varianceCents: s.varianceCents,
        approvedBy: s.approvedById ? (approvers.find((a) => a.id === s.approvedById)?.name ?? null) : null,
      };
    }),
  );
}

export function shiftTotals(rows: ShiftRow[]) {
  const sum = (f: (r: ShiftRow) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  return {
    sessions: rows.length,
    open: rows.filter((r) => r.status === "OPEN").length,
    floatCents: sum((r) => r.floatCents),
    cashSalesCents: sum((r) => r.cashSalesCents),
    cashRefundsCents: sum((r) => r.cashRefundsCents),
    tradeInCashCents: sum((r) => r.tradeInCashCents),
    paidInCents: sum((r) => r.paidInCents),
    paidOutCents: sum((r) => r.paidOutCents),
    dropCents: sum((r) => r.dropCents),
    expectedCents: sum((r) => r.expectedCents),
    countedCents: sum((r) => r.countedCents),
    varianceCents: sum((r) => r.varianceCents),
  };
}
