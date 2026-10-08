import type { Prisma, TimeEntry } from "@prisma/client";
import type { Db } from "../db.js";
import { AppError, badRequest, conflict, notFound } from "../errors.js";
import { audit, changes } from "./permissions.js";

/** An open entry longer than this is flagged `long` so a manager spots a forgotten clock-out. */
export const LONG_SHIFT_MINUTES = 16 * 60;

export type EntrySource = "register" | "web" | "edited";

const withNames = { staff: { select: { id: true, name: true } }, location: { select: { name: true } } } as const;
type EntryRow = Prisma.TimeEntryGetPayload<{ include: typeof withNames }>;

/** Worked minutes: clockOut − clockIn − break, or the running total while open. Never negative. */
export function minutesOf(e: { clockIn: Date; clockOut: Date | null; breakMinutes: number }, now = new Date()): number {
  const end = e.clockOut ?? now;
  return Math.max(0, Math.round((end.getTime() - e.clockIn.getTime()) / 60_000) - e.breakMinutes);
}

/** Open and running for more than LONG_SHIFT_MINUTES: probably a missed clock-out. */
export const isLong = (e: { clockIn: Date; clockOut: Date | null }, now = new Date()) => !e.clockOut && now.getTime() - e.clockIn.getTime() > LONG_SHIFT_MINUTES * 60_000;

export const hoursOf = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

/** An entry as the API shows it: names, worked minutes, and the long-shift flag. */
export function present(e: EntryRow, now = new Date()) {
  return { ...e, minutes: minutesOf(e, now), long: isLong(e, now) };
}
export type PresentedEntry = ReturnType<typeof present>;

// ── Local-time helpers (reports show the store's day, not UTC) ───

const fmt = new Map<string, { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat }>();
function formats(timeZone: string) {
  let f = fmt.get(timeZone);
  if (!f) {
    f = {
      date: new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }),
      time: new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    };
    fmt.set(timeZone, f);
  }
  return f;
}
/** YYYY-MM-DD in the store's time zone. */
export const localDate = (d: Date, timeZone: string) => formats(timeZone).date.format(d);
/** HH:MM in the store's time zone. */
export const localTime = (d: Date, timeZone: string) => formats(timeZone).time.format(d);

/** [start, end) of the local calendar day containing `now`, as instants. */
export function localDay(timeZone: string, now = new Date()): { from: Date; to: Date } {
  const local = new Date(now.toLocaleString("en-US", { timeZone }));
  const startLocal = new Date(local.getFullYear(), local.getMonth(), local.getDate());
  const offsetMs = local.getTime() - now.getTime();
  const from = new Date(startLocal.getTime() - offsetMs);
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

// ── Clocking in and out ──────────────────────────────────────────

/** The employee's open entry (at any location), if they're clocked in. */
export function openEntry(db: Db, staffId: string) {
  return db.timeEntry.findFirst({ where: { staffId, clockOut: null }, orderBy: { clockIn: "desc" }, include: withNames });
}

export async function clockIn(db: Db, input: { staffId: string; locationId: string; source: EntrySource; ip?: string }) {
  if (await openEntry(db, input.staffId)) throw conflict("ALREADY_CLOCKED_IN", "Already clocked in");
  if (!(await db.location.findUnique({ where: { id: input.locationId } }))) throw notFound("Location");
  const now = new Date();
  const entry = await db.timeEntry.create({ data: { staffId: input.staffId, locationId: input.locationId, clockIn: now, source: input.source }, include: withNames });
  await audit(db, { action: "TIME_CLOCK_IN", staffId: input.staffId, locationId: input.locationId, ip: input.ip, details: { entryId: entry.id, locationId: input.locationId, source: input.source } });
  return present(entry, now);
}

export async function clockOut(db: Db, input: { staffId: string; ip?: string }) {
  const open = await openEntry(db, input.staffId);
  if (!open) throw conflict("NOT_CLOCKED_IN", "Not clocked in");
  const now = new Date();
  const entry = await db.timeEntry.update({ where: { id: open.id }, data: { clockOut: now }, include: withNames });
  const minutes = minutesOf(entry, now);
  await audit(db, { action: "TIME_CLOCK_OUT", staffId: input.staffId, locationId: entry.locationId, ip: input.ip, details: { entryId: entry.id, locationId: entry.locationId, minutes } });
  return present(entry, now);
}

/** The register's one-button clock: in if out, out if in. */
export async function toggle(db: Db, input: { staffId: string; locationId: string; ip?: string }): Promise<{ action: "in" | "out"; entry: PresentedEntry; minutes: number }> {
  const open = await openEntry(db, input.staffId);
  const entry = open ? await clockOut(db, input) : await clockIn(db, { ...input, source: "register" });
  return { action: open ? "out" : "in", entry, minutes: entry.minutes };
}

/** What the signed-in employee sees: their open entry and today's total. */
export async function status(db: Db, staffId: string, timeZone: string, now = new Date()) {
  const open = await openEntry(db, staffId);
  const day = localDay(timeZone, now);
  // Everything touching today, clipped to today, so an overnight shift counts its hours on the right day.
  const rows = await db.timeEntry.findMany({ where: { staffId, clockIn: { lt: day.to }, OR: [{ clockOut: null }, { clockOut: { gte: day.from } }] } });
  let minutes = 0;
  for (const e of rows) {
    const start = Math.max(e.clockIn.getTime(), day.from.getTime());
    const end = Math.min((e.clockOut ?? now).getTime(), day.to.getTime());
    minutes += Math.max(0, Math.round((end - start) / 60_000) - e.breakMinutes);
  }
  return { entry: open ? present(open, now) : null, today: { minutes, hours: hoursOf(minutes) } };
}

/** Who's on the clock right now, newest first. */
export async function clockedIn(db: Db, locationId?: string, now = new Date()) {
  const rows = await db.timeEntry.findMany({ where: { clockOut: null, ...(locationId ? { locationId } : {}) }, orderBy: { clockIn: "desc" }, include: withNames });
  return rows.map((e) => ({ entryId: e.id, staffId: e.staffId, name: e.staff.name, locationId: e.locationId, location: e.location.name, since: e.clockIn, minutes: minutesOf(e, now), long: isLong(e, now) }));
}

// ── Entries ──────────────────────────────────────────────────────

export interface EntryFilter {
  staffId?: string;
  locationId?: string;
  from?: Date;
  to?: Date;
  /** Only entries still open. */
  open?: boolean;
  take?: number;
}

export async function listEntries(db: Db, f: EntryFilter, now = new Date()) {
  const rows = await db.timeEntry.findMany({
    where: {
      staffId: f.staffId,
      locationId: f.locationId,
      ...(f.from || f.to ? { clockIn: { gte: f.from, lt: f.to } } : {}),
      ...(f.open ? { clockOut: null } : {}),
    },
    orderBy: { clockIn: "desc" },
    take: f.take ?? 200,
    include: withNames,
  });
  return rows.map((e) => present(e, now));
}

export async function getEntry(db: Db, id: string) {
  const e = await db.timeEntry.findUnique({ where: { id }, include: withNames });
  if (!e) throw notFound("Time entry");
  return e;
}

/** The rules every entry (made or edited by a manager) must satisfy. */
function validate(e: { clockIn: Date; clockOut: Date | null; breakMinutes: number }, now = new Date()) {
  if (e.clockIn.getTime() > now.getTime() + 5 * 60_000) throw badRequest("CLOCK_IN_IN_FUTURE", "Clock-in can't be in the future");
  if (e.clockOut) {
    if (e.clockOut <= e.clockIn) throw badRequest("CLOCK_OUT_BEFORE_IN", "Clock-out must be after clock-in");
    if (e.clockOut.getTime() > now.getTime() + 5 * 60_000) throw badRequest("CLOCK_OUT_IN_FUTURE", "Clock-out can't be in the future");
    if (e.breakMinutes * 60_000 > e.clockOut.getTime() - e.clockIn.getTime()) throw badRequest("BREAK_TOO_LONG", "The break is longer than the shift");
  }
}

export async function createEntry(
  db: Db,
  input: { staffId: string; locationId: string; clockIn: Date; clockOut?: Date; breakMinutes?: number; note?: string; editedById: string },
) {
  const staff = await db.staff.findUnique({ where: { id: input.staffId } });
  if (!staff) throw notFound("Employee");
  if (!(await db.location.findUnique({ where: { id: input.locationId } }))) throw notFound("Location");
  const data = { clockIn: input.clockIn, clockOut: input.clockOut ?? null, breakMinutes: input.breakMinutes ?? 0 };
  validate(data);
  if (!data.clockOut && (await openEntry(db, input.staffId))) throw conflict("ALREADY_CLOCKED_IN", `${staff.name} already has an open entry`);
  const entry = await db.timeEntry.create({
    data: { ...data, staffId: input.staffId, locationId: input.locationId, note: input.note, source: "edited", editedById: input.editedById, editedAt: new Date() },
    include: withNames,
  });
  await audit(db, {
    action: "TIME_ENTRY_CREATED",
    staffId: input.editedById,
    locationId: input.locationId,
    details: { entryId: entry.id, staffId: input.staffId, clockIn: entry.clockIn.toISOString(), clockOut: entry.clockOut?.toISOString() ?? null, breakMinutes: entry.breakMinutes, note: entry.note ?? null },
  });
  return present(entry);
}

export async function editEntry(
  db: Db,
  id: string,
  data: { clockIn?: Date; clockOut?: Date | null; breakMinutes?: number; note?: string | null },
  editedById: string,
) {
  const before = await getEntry(db, id);
  const next = { clockIn: data.clockIn ?? before.clockIn, clockOut: data.clockOut === undefined ? before.clockOut : data.clockOut, breakMinutes: data.breakMinutes ?? before.breakMinutes };
  validate(next);
  if (before.clockOut && !next.clockOut) {
    const other = await openEntry(db, before.staffId);
    if (other && other.id !== id) throw conflict("ALREADY_CLOCKED_IN", `${before.staff.name} already has an open entry`);
  }
  const diff = changes(before as unknown as Record<string, unknown>, data as Record<string, unknown>);
  if (Object.keys(diff).length === 0) return present(before);
  const entry = await db.timeEntry.update({ where: { id }, data: { ...data, source: "edited", editedById, editedAt: new Date() }, include: withNames });
  await audit(db, { action: "TIME_ENTRY_EDITED", staffId: editedById, locationId: entry.locationId, details: { entryId: id, staffId: entry.staffId, changes: diff } });
  return present(entry);
}

export async function deleteEntry(db: Db, id: string, byId: string) {
  const e = await getEntry(db, id);
  await db.timeEntry.delete({ where: { id } });
  await audit(db, {
    action: "TIME_ENTRY_DELETED",
    staffId: byId,
    locationId: e.locationId,
    details: { entryId: id, staffId: e.staffId, clockIn: e.clockIn.toISOString(), clockOut: e.clockOut?.toISOString() ?? null, breakMinutes: e.breakMinutes, minutes: minutesOf(e) },
  });
  return { deleted: true as const, id };
}

// ── Reports ──────────────────────────────────────────────────────

export interface TimeRange {
  from: Date;
  to: Date;
  locationId?: string;
  staffId?: string;
}

/** Entries whose clock-in falls in the range, oldest first, with names. */
function entriesIn(db: Db, r: TimeRange) {
  return db.timeEntry.findMany({
    where: { clockIn: { gte: r.from, lt: r.to }, locationId: r.locationId, staffId: r.staffId },
    orderBy: [{ clockIn: "asc" }],
    include: withNames,
  });
}

/** One detail row per entry, in the store's local day and time. */
function detailRow(e: EntryRow, timeZone: string, now: Date) {
  return {
    id: e.id,
    staffId: e.staffId,
    name: e.staff.name,
    location: e.location.name,
    date: localDate(e.clockIn, timeZone),
    in: localTime(e.clockIn, timeZone),
    out: e.clockOut ? localTime(e.clockOut, timeZone) : null,
    clockIn: e.clockIn,
    clockOut: e.clockOut,
    break: e.breakMinutes,
    minutes: minutesOf(e, now),
    note: e.note,
    edited: e.source === "edited",
    open: !e.clockOut,
    long: isLong(e, now),
  };
}
export type TimesheetEntryRow = ReturnType<typeof detailRow>;

export interface TimesheetStaffRow {
  staffId: string;
  name: string;
  entries: number;
  minutes: number;
  hours: number;
  openNow: boolean;
  long: boolean;
}

/** Hours per employee in the range (and each entry when `detail`). */
export async function timesheets(db: Db, r: TimeRange, timeZone: string, detail: boolean, now = new Date()): Promise<{ staff: TimesheetStaffRow[]; entries?: TimesheetEntryRow[] }> {
  const rows = await entriesIn(db, r);
  const by = new Map<string, TimesheetStaffRow>();
  for (const e of rows) {
    const s = by.get(e.staffId) ?? { staffId: e.staffId, name: e.staff.name, entries: 0, minutes: 0, hours: 0, openNow: false, long: false };
    s.entries += 1;
    s.minutes += minutesOf(e, now);
    s.openNow ||= !e.clockOut;
    s.long ||= isLong(e, now);
    by.set(e.staffId, s);
  }
  const staff = [...by.values()].map((s) => ({ ...s, hours: hoursOf(s.minutes) })).sort((a, b) => a.name.localeCompare(b.name));
  return detail ? { staff, entries: rows.map((e) => detailRow(e, timeZone, now)) } : { staff };
}

/** Net value of a line after refunds and all discounts (same rule as the sales reports). */
const lineNet = (l: { unitPriceCents: number; quantity: number; discountCents: number; refundedQty: number }) =>
  Math.round(((l.unitPriceCents * l.quantity - l.discountCents) * (l.quantity - l.refundedQty)) / l.quantity);

/** One row per entry with the sales that employee rang up while on the clock. */
export async function employeeShifts(db: Db, r: TimeRange, timeZone: string, now = new Date()) {
  const rows = await entriesIn(db, r);
  if (rows.length === 0) return [];
  const staffIds = [...new Set(rows.map((e) => e.staffId))];
  const earliest = rows.reduce((a, e) => (e.clockIn < a ? e.clockIn : a), rows[0]!.clockIn);
  const latest = rows.reduce((a, e) => ((e.clockOut ?? now) > a ? (e.clockOut ?? now) : a), rows[0]!.clockOut ?? now);
  const orders = await db.order.findMany({
    where: { staffId: { in: staffIds }, status: { not: "VOID" }, createdAt: { gte: earliest, lte: latest } },
    select: { id: true, staffId: true, createdAt: true, lines: { select: { unitPriceCents: true, quantity: true, discountCents: true, refundedQty: true } } },
  });
  return rows.map((e) => {
    const end = e.clockOut ?? now;
    const mine = orders.filter((o) => o.staffId === e.staffId && o.createdAt >= e.clockIn && o.createdAt <= end);
    const units = mine.reduce((a, o) => a + o.lines.reduce((b, l) => b + l.quantity - l.refundedQty, 0), 0);
    const netCents = mine.reduce((a, o) => a + o.lines.reduce((b, l) => b + lineNet(l), 0), 0);
    const minutes = minutesOf(e, now);
    const hours = hoursOf(minutes);
    return { ...detailRow(e, timeZone, now), hours, orders: mine.length, units, netCents, netPerHourCents: minutes > 0 ? Math.round((netCents * 60) / minutes) : 0 };
  });
}

/** Thrown when someone asks to see another employee's time without the permission. */
export const cannotViewOthers = () => new AppError(403, "PERMISSION_DENIED", "You can only see your own time entries", { permission: "MANAGE_TIMESHEETS" });
