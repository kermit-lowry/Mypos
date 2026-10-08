import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, badRequest, notFound } from "../errors.js";
import { actorOf, authorize, parse, requirePermission, requireStaff } from "../http.js";
import type { Ctx } from "../services/context.js";
import { drawerReportHtml } from "../services/documents.js";
import {
  addMovement,
  closeDrawer,
  currentSession,
  expectedCash,
  openDrawer,
  sessionInclude,
  sessionReport,
  shiftRows,
  shiftTotals,
  type SessionReport,
  type SessionWithDetails,
  type ShiftRow,
} from "../services/drawer.js";
import { drawerReportEscPos, drawerReportText } from "../services/escpos.js";
import { sendToPrinter } from "../services/labels.js";
import { localDayRange, salesByTender, salesSummary, toCsv } from "../services/reports.js";

/**
 * Cash drawer sessions (shifts): open, paid in/out, close with a blind count,
 * closing and daily reports.
 *
 * A session is one register's drawer from "start shift" (float counted in)
 * to "close" (blind count, variance, Z report). It belongs to a terminal
 * (`terminalId`) or, with none, to the location's single shared drawer.
 * Checkout, refunds and trade-in payouts attribute their payments to the
 * open session for the `terminalId` they were made with.
 *
 * Session shape (GET /drawer/current, /drawer/:id, POST /drawer/open, /close):
 *   { id, number, status: "OPEN"|"CLOSED", locationId, terminalId, terminalName,
 *     openedBy: {id,name}|null, openedAt, openingFloatCents, openingCount,
 *     closedBy, closedAt, expectedCashCents, countedCashCents, varianceCents, closingCount,
 *     approvedBy: {id,name}|null, notes,
 *     movements: [{ id, kind, amountCents, reason, note, staff: {id,name}|null, approverId, createdAt }] }
 *
 * Expected cash breakdown (`expected`):
 *   { openingFloatCents, cashSalesCents, cashRefundsCents, tradeInCashCents, paidInCents, paidOutCents, dropCents, expectedCents }
 *   expected = float + cash sales − cash refunds − trade-ins paid in cash + paid in − paid out − drops.
 *
 * Report (`report`, GET /drawer/:id/report, stored as `closingReport` at close):
 *   { kind: "X"|"Z", generatedAt,
 *     session: { id, number, status, locationId, locationName, timeZone, terminalId, terminalName, openedBy, openedAt, closedBy, closedAt, approvedBy, notes },
 *     cash: { ...expected breakdown, countedCashCents, varianceCents, openingCount, closingCount },
 *     movements: [{ id, kind, amountCents, reason, note, staff, createdAt }],
 *     sales: { orders, units, grossCents, discountCents, manualDiscountCents, dealDiscountCents, rewardDiscountCents,
 *              netSalesCents, taxCents, cardAdjustmentCents, collectedCents,
 *              byTender: [{ tender, count, amountCents }],
 *              refunds: { count, amountCents, byTender: [...] },
 *              tradeIns: { tickets, paidCents, byPayout: { CASH: {tickets,paidCents}, STORE_CREDIT: {...} } } },
 *     byEmployee: [{ staffId, name, orders, netCents, collectedCents }] }
 *
 * Blind counts: while `location.blindCashCount` is on, an OPEN session's
 * `expected` and X report are only shown to people with VIEW_REPORTS (ALLOW);
 * everyone sees them once the drawer is closed.
 */
export function shiftRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireStaff() };
  const reports = { preHandler: requirePermission("VIEW_REPORTS") };
  const ctx = (req: FastifyRequest): Ctx => ({ ...base, actor: actorOf(req), perms: req.perms });
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;

  const MAX = 100_000_00; // $100,000 in cents
  /** Denomination counts: cents → how many ({ "2000": 5, "25": 40 }). */
  const Count = z.record(z.string().regex(/^\d+$/, "Denominations are in cents"), z.number().int().min(0));
  const OpenBody = z.object({
    locationId: z.string(),
    terminalId: z.string().optional(),
    openingFloatCents: z.number().int().min(0).max(MAX),
    openingCount: Count.optional(),
    notes: z.string().max(1000).optional(),
  });
  const MovementBody = z.object({
    kind: z.enum(["PAID_IN", "PAID_OUT", "DROP"]),
    amountCents: z.number().int().positive().max(MAX),
    reason: z.string().trim().min(1).max(200),
    note: z.string().max(1000).optional(),
  });
  const CloseBody = z.object({ countedCashCents: z.number().int().min(0).max(MAX), closingCount: Count.optional(), notes: z.string().max(1000).optional() });
  const Format = z.enum(["json", "csv"]).default("json");

  const canSeeExpected = (req: FastifyRequest, session: { status: string }, location: { blindCashCount: boolean }) =>
    session.status === "CLOSED" || !location.blindCashCount || req.perms?.levels.VIEW_REPORTS === "ALLOW";

  async function load(sessionId: string) {
    const session = await prisma.drawerSession.findUnique({ where: { id: sessionId }, include: sessionInclude });
    if (!session) throw notFound("Drawer session");
    const location = await prisma.location.findUniqueOrThrow({ where: { id: session.locationId } });
    return { session, location };
  }

  /** The session with names filled in; the stored closing report is returned as `report`, not repeated here. */
  async function present({ closingReport: _report, ...s }: SessionWithDetails) {
    const [terminal, approver] = await Promise.all([
      s.terminalId ? prisma.terminal.findUnique({ where: { id: s.terminalId }, select: { id: true, name: true } }) : null,
      s.approvedById ? prisma.staff.findUnique({ where: { id: s.approvedById }, select: { id: true, name: true } }) : null,
    ]);
    return { ...s, terminalName: terminal?.name ?? null, approvedBy: approver };
  }

  /** The Z report for a closed session, the live X report for an open one. */
  const reportFor = async (s: SessionWithDetails): Promise<SessionReport> =>
    s.status === "CLOSED" && s.closingReport ? (s.closingReport as unknown as SessionReport) : sessionReport(prisma, s);

  const settingsOf = (l: { requireDrawerSession: boolean; blindCashCount: boolean; cashVarianceAlertCents: number }) => ({
    requireDrawerSession: l.requireDrawerSession,
    blindCashCount: l.blindCashCount,
    cashVarianceAlertCents: l.cashVarianceAlertCents,
  });

  // ── Register ───────────────────────────────────────────────

  /** The open session for a register (its own, else the location's shared drawer), with the location's drawer settings. */
  app.get("/drawer/current", staff, async (req) => {
    const q = parse(z.object({ locationId: z.string(), terminalId: z.string().optional() }), req.query);
    const location = await prisma.location.findUnique({ where: { id: q.locationId } });
    if (!location) throw notFound("Location");
    const settings = settingsOf(location);
    const open = await currentSession(prisma, location.id, q.terminalId);
    if (!open) return { session: null, expected: null, settings };
    const session = await prisma.drawerSession.findUniqueOrThrow({ where: { id: open.id }, include: sessionInclude });
    const expected = canSeeExpected(req, session, location) ? await expectedCash(prisma, session) : null;
    return { session: await present(session), expected, settings };
  });

  /** Start a shift: count the float in. 409 DRAWER_ALREADY_OPEN if this register already has one. */
  app.post("/drawer/open", { preHandler: requirePermission("DRAWER_OPEN_CLOSE") }, async (req, reply) => {
    const body = parse(OpenBody, req.body);
    const session = await openDrawer(ctx(req), body);
    return reply.code(201).send(await present(session));
  });

  /** Sessions, newest first. */
  app.get("/drawer/sessions", staff, async (req) => {
    const q = parse(
      z.object({
        locationId: z.string().optional(),
        terminalId: z.string().optional(),
        status: z.enum(["OPEN", "CLOSED"]).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        take: z.coerce.number().int().min(1).max(500).default(50),
      }),
      req.query,
    );
    const rows = await prisma.drawerSession.findMany({
      where: { locationId: q.locationId, terminalId: q.terminalId, status: q.status, openedAt: { gte: q.from, lt: q.to } },
      orderBy: [{ openedAt: "desc" }, { number: "desc" }],
      take: q.take,
      include: { openedBy: { select: { id: true, name: true } }, closedBy: { select: { id: true, name: true } }, _count: { select: { movements: true } } },
    });
    const terminalIds = [...new Set(rows.map((r) => r.terminalId).filter((x): x is string => !!x))];
    const approverIds = [...new Set(rows.map((r) => r.approvedById).filter((x): x is string => !!x))];
    const [terminals, approvers] = await Promise.all([
      prisma.terminal.findMany({ where: { id: { in: terminalIds } }, select: { id: true, name: true } }),
      prisma.staff.findMany({ where: { id: { in: approverIds } }, select: { id: true, name: true } }),
    ]);
    return rows.map(({ closingReport: _report, openingCount: _oc, closingCount: _cc, _count, ...s }) => ({
      ...s,
      terminalName: s.terminalId ? (terminals.find((t) => t.id === s.terminalId)?.name ?? null) : null,
      approvedBy: s.approvedById ? (approvers.find((a) => a.id === s.approvedById) ?? null) : null,
      movements: _count.movements,
    }));
  });

  /** One session with its movements, expected cash (see blind rules above) and report (live X, or the stored Z). */
  app.get("/drawer/:id", staff, async (req) => {
    const { session, location } = await load(id(req));
    const visible = canSeeExpected(req, session, location);
    const [expected, report] = await Promise.all([visible ? expectedCash(prisma, session) : null, visible ? reportFor(session) : null]);
    return { ...(await present(session)), expected, report };
  });

  /** Paid in / paid out / drop. Pops the drawer through the register's receipt printer when it has one. */
  app.post("/drawer/:id/movements", { preHandler: requirePermission("CASH_IN_OUT") }, async (req, reply) => {
    const body = parse(MovementBody, req.body);
    const movement = await addMovement(ctx(req), id(req), { ...body, approverId: req.approverId });
    return reply.code(201).send(movement);
  });

  /**
   * Close with a blind count. A variance beyond the location's alert amount
   * needs CASH_VARIANCE_OVERRIDE (a manager's PIN for cashiers), recorded as
   * `approvedBy`. Returns the closed session with `expected` and its Z `report`.
   */
  app.post("/drawer/:id/close", { preHandler: requirePermission("DRAWER_OPEN_CLOSE") }, async (req) => {
    const body = parse(CloseBody, req.body);
    const { session, report } = await closeDrawer(ctx(req), id(req), body, async () => {
      await authorize(req, "CASH_VARIANCE_OVERRIDE", `drawer ${id(req)} close variance`);
      return req.approverId;
    });
    const { countedCashCents: _c, varianceCents: _v, openingCount: _oc, closingCount: _cc, ...expected } = report.cash;
    return { ...(await present(session)), expected, report };
  });

  // ── Reports ────────────────────────────────────────────────

  const blindCheck = (req: FastifyRequest, session: { status: string }, location: { blindCashCount: boolean }) => {
    if (!canSeeExpected(req, session, location)) throw new AppError(403, "BLIND_COUNT", "The count is blind: close the drawer before viewing its report");
  };

  /** The closing (Z) report, or the live X report while open: JSON, printable HTML, or thermal-printer text (`width` columns). */
  app.get("/drawer/:id/report", staff, async (req, reply) => {
    const q = parse(z.object({ format: z.enum(["json", "html", "text"]).default("json"), width: z.coerce.number().int().min(24).max(64).default(42) }), req.query);
    const { session, location } = await load(id(req));
    blindCheck(req, session, location);
    const report = await reportFor(session);
    if (q.format === "html") return reply.type("text/html; charset=utf-8").send(drawerReportHtml(report));
    if (q.format === "text") return reply.type("text/plain; charset=utf-8").send(drawerReportText(report, q.width));
    return report;
  });

  /** Print the text report on a register's ESC/POS receipt printer. */
  app.post("/drawer/:id/report/print", staff, async (req) => {
    const body = parse(z.object({ terminalId: z.string(), width: z.coerce.number().int().min(24).max(64).default(42) }), req.body);
    const { session, location } = await load(id(req));
    blindCheck(req, session, location);
    const terminal = await prisma.terminal.findUnique({ where: { id: body.terminalId } });
    if (!terminal) throw notFound("Terminal");
    if (terminal.locationId !== session.locationId) throw badRequest("TERMINAL", "That register isn't at this drawer's location");
    if (!terminal.receiptPrinterHost) throw badRequest("NO_PRINTER", "No receipt printer set up for this register");
    await sendToPrinter(terminal.receiptPrinterHost, drawerReportEscPos(await reportFor(session), body.width));
    return { printed: true, on: "printer" };
  });

  const csvRows = (rows: ShiftRow[]) => rows.map((r) => ({ ...r, openedAt: r.openedAt.toISOString(), closedAt: r.closedAt?.toISOString() ?? null }));
  const send = (reply: FastifyReply, format: "json" | "csv", name: string, json: unknown, rows: ShiftRow[]) =>
    format === "csv" ? reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}.csv"`).send(toCsv(csvRows(rows))) : json;

  /**
   * Daily close-out: every session opened or closed on a local day (the
   * location's time zone), with per-session cash figures, day totals, the
   * day's sales summary and tenders. `open` lists sessions still open.
   * Row: { id, number, status, register, terminalId, openedBy, openedAt, closedBy, closedAt, floatCents, cashSalesCents,
   *        cashRefundsCents, tradeInCashCents, paidInCents, paidOutCents, dropCents, expectedCents, countedCents, varianceCents, approvedBy }
   */
  app.get("/reports/daily-close", reports, async (req, reply) => {
    const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"), locationId: z.string().optional(), format: Format }), req.query);
    const location = q.locationId ? await prisma.location.findUnique({ where: { id: q.locationId } }) : await prisma.location.findFirst({ orderBy: { createdAt: "asc" } });
    if (!location) throw notFound("Location");
    const { from, to } = localDayRange(q.date, location.timezone);
    const sessions = await prisma.drawerSession.findMany({
      where: { locationId: q.locationId, OR: [{ openedAt: { gte: from, lt: to } }, { closedAt: { gte: from, lt: to } }] },
      orderBy: [{ openedAt: "asc" }, { number: "asc" }],
      include: sessionInclude,
    });
    const rows = await shiftRows(prisma, sessions);
    const range = { from, to, locationId: q.locationId };
    const [sales, tenders] = await Promise.all([salesSummary(prisma, range), salesByTender(prisma, range)]);
    const json = { date: q.date, timeZone: location.timezone, from, to, locationId: q.locationId ?? null, sessions: rows, open: rows.filter((r) => r.status === "OPEN"), totals: shiftTotals(rows), sales, tenders };
    return send(reply, q.format, `daily-close-${q.date}`, json, rows);
  });

  /** Closed sessions in a range (by close time), one row each (same row shape as the daily close), with totals. */
  app.get("/reports/shifts", reports, async (req, reply) => {
    const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date(), locationId: z.string().optional(), terminalId: z.string().optional(), format: Format }), req.query);
    if (q.to <= q.from) throw badRequest("RANGE", "End must be after start");
    const sessions = await prisma.drawerSession.findMany({
      where: { locationId: q.locationId, terminalId: q.terminalId, status: "CLOSED", closedAt: { gte: q.from, lt: q.to } },
      orderBy: [{ closedAt: "desc" }, { number: "desc" }],
      include: sessionInclude,
    });
    const rows = await shiftRows(prisma, sessions);
    return send(reply, q.format, "shifts", { from: q.from, to: q.to, locationId: q.locationId ?? null, rows, totals: shiftTotals(rows) }, rows);
  });
}
