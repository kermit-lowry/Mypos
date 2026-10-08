import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, badRequest } from "../errors.js";
import { parse, requirePermission, requireStaff } from "../http.js";
import type { Ctx } from "../services/context.js";
import { audit, checkAttempts, clearFailures, pinLookup, recordFailure } from "../services/permissions.js";
import { toCsv } from "../services/reports.js";
import * as T from "../services/timeclock.js";

/** Time clock: clock in/out, timesheets, hours and shift reports. */
export function timeClockRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireStaff() };
  const manage = { preHandler: requirePermission("MANAGE_TIMESHEETS") };
  const reports = { preHandler: requirePermission("VIEW_REPORTS") };
  const ip = (req: FastifyRequest) => req.ip;
  const Id = z.object({ id: z.string().min(1) });
  const Note = z.string().trim().max(500);
  /** A "true"/"false" query flag (z.coerce.boolean would read "false" as true). */
  const Flag = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

  // ── The register's clock button: PIN only, no session ─────────

  /**
   * Clock in or out by PIN from the register's sign-in screen. Toggles: an
   * open entry (at any location) is closed, otherwise one is opened here.
   * Same brute-force lockout as /auth/login, keyed by IP.
   */
  app.post("/time/clock", async (req) => {
    const { pin, locationId } = parse(z.object({ pin: z.string().min(4).max(8), locationId: z.string().min(1) }), req.body);
    const key = `time-clock:${ip(req)}`;
    const failed = (reason: string) => audit(prisma, { action: "TIME_CLOCK_FAILED", locationId, ip: ip(req), details: { reason, locationId } });
    try {
      checkAttempts(key);
    } catch (e) {
      await failed("LOCKED_OUT");
      throw e;
    }
    const employee = await prisma.staff.findUnique({ where: { pinLookup: pinLookup(pin) } });
    if (!employee || !employee.active) {
      recordFailure(key);
      await failed("BAD_PIN");
      throw new AppError(401, "BAD_PIN", "That PIN isn't recognized");
    }
    clearFailures(key);
    const r = await T.toggle(prisma, { staffId: employee.id, locationId, ip: ip(req) });
    return { action: r.action, staff: { id: employee.id, name: employee.name }, entry: r.entry, minutes: r.minutes };
  });

  // ── Signed-in employee ────────────────────────────────────────

  app.post("/time/clock-in", staff, async (req, reply) => {
    const { locationId } = parse(z.object({ locationId: z.string().min(1) }), req.body);
    const entry = await T.clockIn(prisma, { staffId: req.user.sub, locationId, source: req.user.via === "web" ? "web" : "register", ip: ip(req) });
    return reply.code(201).send({ entry, minutes: entry.minutes });
  });

  app.post("/time/clock-out", staff, async (req) => {
    const entry = await T.clockOut(prisma, { staffId: req.user.sub, ip: ip(req) });
    return { entry, minutes: entry.minutes };
  });

  /** The signed-in employee's open entry (or null) and today's total. */
  app.get("/time/status", staff, async (req) => {
    const { locationId } = parse(z.object({ locationId: z.string().optional() }), req.query);
    return T.status(prisma, req.user.sub, await timeZoneOf(locationId));
  });

  /** Who's on the clock now, for the register header and the back office. */
  app.get("/time/clocked-in", staff, async (req) => {
    const { locationId } = parse(z.object({ locationId: z.string().optional() }), req.query);
    return T.clockedIn(prisma, locationId);
  });

  // ── Entries ───────────────────────────────────────────────────

  const canSeeOthers = (req: FastifyRequest) => req.perms?.levels.MANAGE_TIMESHEETS === "ALLOW" || req.perms?.levels.VIEW_REPORTS === "ALLOW";

  /** Own entries for anyone; everyone's with MANAGE_TIMESHEETS or VIEW_REPORTS. */
  app.get("/time/entries", staff, async (req) => {
    const q = parse(
      z.object({
        staffId: z.string().optional(),
        locationId: z.string().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        open: Flag.optional(),
        take: z.coerce.number().int().min(1).max(1000).default(200),
      }),
      req.query,
    );
    const self = req.user.sub;
    let staffId = q.staffId;
    if (staffId && staffId !== self && !canSeeOthers(req)) throw T.cannotViewOthers();
    if (!staffId && !canSeeOthers(req)) staffId = self;
    return T.listEntries(prisma, { ...q, staffId });
  });

  app.get("/time/entries/:id", staff, async (req) => {
    const { id } = parse(Id, req.params);
    const e = await T.getEntry(prisma, id);
    if (e.staffId !== req.user.sub && !canSeeOthers(req)) throw T.cannotViewOthers();
    return T.present(e);
  });

  /** A manager adds an entry by hand (a forgotten clock-in, a shift worked off-site). */
  app.post("/time/entries", manage, async (req, reply) => {
    const body = parse(
      z.object({
        staffId: z.string().min(1),
        locationId: z.string().min(1),
        clockIn: z.coerce.date(),
        clockOut: z.coerce.date().optional(),
        breakMinutes: z.number().int().min(0).max(24 * 60).optional(),
        note: Note.optional(),
      }),
      req.body,
    );
    return reply.code(201).send(await T.createEntry(prisma, { ...body, editedById: req.user.sub }));
  });

  app.patch("/time/entries/:id", manage, async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(
      z.object({
        clockIn: z.coerce.date().optional(),
        /** null reopens the entry. */
        clockOut: z.coerce.date().nullable().optional(),
        breakMinutes: z.number().int().min(0).max(24 * 60).optional(),
        note: Note.nullable().optional(),
      }),
      req.body ?? {},
    );
    return T.editEntry(prisma, id, body, req.user.sub);
  });

  app.delete("/time/entries/:id", manage, async (req) => {
    const { id } = parse(Id, req.params);
    return T.deleteEntry(prisma, id, req.user.sub);
  });

  // ── Reports ───────────────────────────────────────────────────

  const RangeQuery = z.object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    locationId: z.string().optional(),
    staffId: z.string().optional(),
    format: z.enum(["json", "csv"]).default("json"),
  });
  async function timeZoneOf(locationId?: string) {
    const loc = locationId ? await prisma.location.findUnique({ where: { id: locationId } }) : await prisma.location.findFirst({ orderBy: { createdAt: "asc" } });
    return loc?.timezone ?? "America/New_York";
  }
  async function range(q: z.infer<typeof RangeQuery>): Promise<T.TimeRange & { timeZone: string }> {
    if (q.to <= q.from) throw badRequest("RANGE", "End must be after start");
    if (q.to.getTime() - q.from.getTime() > 400 * 86_400_000) throw badRequest("RANGE", "Pick a range of up to a year");
    return { from: q.from, to: q.to, locationId: q.locationId, staffId: q.staffId, timeZone: await timeZoneOf(q.locationId) };
  }
  const send = (reply: FastifyReply, format: "json" | "csv", name: string, rows: unknown) => {
    if (format !== "csv") return rows;
    const list = Array.isArray(rows) ? rows : [rows];
    return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${name}.csv"`).send(toCsv(list as Record<string, unknown>[]));
  };

  /** Hours per employee; each entry too when `staffId` or `detail=true`. CSV is the entry rows in that case, else the per-employee rows. */
  app.get("/reports/timesheets", reports, async (req, reply) => {
    const q = parse(RangeQuery.extend({ detail: Flag.optional() }), req.query);
    const r = await range(q);
    const detail = !!q.staffId || !!q.detail;
    const out = await T.timesheets(prisma, r, r.timeZone, detail);
    return send(reply, q.format, "timesheets", q.format === "csv" ? (detail ? out.entries : out.staff) : out);
  });

  /** One row per entry with the sales rung up during it. */
  app.get("/reports/employee-shifts", reports, async (req, reply) => {
    const q = parse(RangeQuery, req.query);
    const r = await range(q);
    return send(reply, q.format, "employee-shifts", await T.employeeShifts(prisma, r, r.timeZone));
  });
}
