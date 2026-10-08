import type { Prisma, StaffRole, Task, TaskAssignee, TaskPriority, TaskRecurrence, TaskStatus } from "@prisma/client";
import type { Db } from "../db.js";
import { AppError, badRequest, conflict, notFound } from "../errors.js";
import { audit, changes } from "./permissions.js";
import { toCsv } from "./reports.js";
import { localDate } from "./timeclock.js";

/**
 * Employee tasks. A Task is the definition (one-off or recurring, for a store
 * or every store, for anyone / a role / one employee); a TaskOccurrence is one
 * day's instance at one location, which is what employees tick off. Occurrences
 * are materialized lazily at the start of every read, so there is no cron.
 */

/** A store-local calendar day, "YYYY-MM-DD". */
export type DayISO = string;

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** How far back and ahead occurrences are created on each read. */
export const MATERIALIZE_BACK_DAYS = 14;
export const MATERIALIZE_AHEAD_DAYS = 7;
const MAX_MATERIALIZE_DAYS = 400;

// ── Day arithmetic (on the ISO string, never on server-local Date parts) ──

const partsOf = (day: DayISO): [number, number, number] => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return [y, m, d];
};
/** A @db.Date value for Prisma: midnight UTC of that day. */
export const dayToDate = (day: DayISO) => new Date(`${day}T00:00:00.000Z`);
/** The day string a @db.Date column came back as. */
export const dateToDay = (d: Date): DayISO => d.toISOString().slice(0, 10);
export const isValidDay = (day: string) => {
  if (!DAY_RE.test(day)) return false;
  const d = dayToDate(day);
  return !Number.isNaN(d.getTime()) && dateToDay(d) === day;
};
export function addDays(day: DayISO, n: number): DayISO {
  const [y, m, d] = partsOf(day);
  return dateToDay(new Date(Date.UTC(y, m - 1, d + n)));
}
/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(day: DayISO): number {
  const [y, m, d] = partsOf(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function daysInMonth(day: DayISO): number {
  const [y, m] = partsOf(day);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Whole days from `a` to `b` (negative when b is earlier). */
export const daysBetween = (a: DayISO, b: DayISO) => Math.round((dayToDate(b).getTime() - dayToDate(a).getTime()) / 86_400_000);

// ── Zoned time → instant ─────────────────────────────────────────

const offsetFmt = new Map<string, Intl.DateTimeFormat>();
/** The zone's UTC offset (ms) at `instant`, found via Intl so no tz dependency is needed. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  let f = offsetFmt.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    offsetFmt.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(instant)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant of a wall-clock time in `timeZone` (two-pass offset search). A wall
 * time inside a spring-forward gap rolls forward past it (02:30 → 03:30), i.e. it
 * is read with the pre-transition offset; an ambiguous fall-back time takes its first
 * (pre-transition) reading.
 */
export function zonedToUtc(day: DayISO, hour: number, minute: number, second = 0, ms = 0, timeZone: string): Date {
  const [y, m, d] = partsOf(day);
  const wall = Date.UTC(y, m - 1, d, hour, minute, second, ms);
  const guess = wall - tzOffsetMs(new Date(wall), timeZone);
  const o1 = tzOffsetMs(new Date(guess), timeZone);
  const r = new Date(wall - o1);
  const o2 = tzOffsetMs(r, timeZone);
  // The two passes only disagree inside a gap, where {o1, o2} are the offsets either side of it.
  return o2 === o1 ? r : new Date(wall - Math.min(o1, o2));
}

/** When a task on `day` is due: `dueTime` in the store's zone, else the last millisecond of that local day. */
export function dueAtFor(day: DayISO, dueTime: string | null | undefined, timeZone: string): Date {
  if (dueTime) {
    const [hh, mm] = dueTime.split(":").map(Number) as [number, number];
    return zonedToUtc(day, hh, mm, 0, 0, timeZone);
  }
  return zonedToUtc(day, 23, 59, 59, 999, timeZone);
}

// ── Schedule ─────────────────────────────────────────────────────

export interface Schedule {
  recurrence: TaskRecurrence;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  startsOn: Date | DayISO;
  endsOn: Date | DayISO | null;
}
const asDay = (v: Date | DayISO) => (typeof v === "string" ? v : dateToDay(v));

/** Does the task fall on this store-local day? Bounded by startsOn ≤ day ≤ endsOn. */
export function occursOn(task: Schedule, day: DayISO): boolean {
  const startsOn = asDay(task.startsOn);
  if (day < startsOn) return false;
  if (task.endsOn && day > asDay(task.endsOn)) return false;
  switch (task.recurrence) {
    case "ONCE":
      return day === startsOn;
    case "DAILY":
      return true;
    case "WEEKLY":
      return task.daysOfWeek.includes(weekdayOf(day));
    case "MONTHLY": {
      if (!task.dayOfMonth) return false;
      const [, , d] = partsOf(day);
      return d === Math.min(task.dayOfMonth, daysInMonth(day));
    }
  }
}

/** The next day ≥ `from` the task occurs, or null (none within 400 days / past endsOn). */
export function nextDueOn(task: Schedule, from: DayISO): DayISO | null {
  const startsOn = asDay(task.startsOn);
  let day = from < startsOn ? startsOn : from;
  const last = task.endsOn ? asDay(task.endsOn) : null;
  for (let i = 0; i < MAX_MATERIALIZE_DAYS; i++, day = addDays(day, 1)) {
    if (last && day > last) return null;
    if (occursOn(task, day)) return day;
  }
  return null;
}

// ── Presentation ─────────────────────────────────────────────────

const person = { select: { id: true, name: true } } as const;
const occInclude = { task: { include: { assignee: person } }, completedBy: person } as const;
type OccRow = Prisma.TaskOccurrenceGetPayload<{ include: typeof occInclude }>;
const taskInclude = { assignee: person, location: { select: { id: true, name: true } }, createdBy: person } as const;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

const PRIORITY_RANK: Record<TaskPriority, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };

const checklistOf = (t: { checklist: unknown }) => (Array.isArray(t.checklist) ? (t.checklist as string[]) : []);
const doneOf = (o: { checklistDone: unknown }) => (Array.isArray(o.checklistDone) ? (o.checklistDone as number[]) : []);

const assigneeOf = (t: { assigneeType: TaskAssignee; assigneeRole: StaffRole | null; assignee: { id: string; name: string } | null }) => ({
  type: t.assigneeType,
  ...(t.assigneeType === "ROLE" ? { role: t.assigneeRole } : {}),
  ...(t.assigneeType === "EMPLOYEE" ? { employee: t.assignee } : {}),
});

/** An occurrence as the API shows it: the task's words plus this day's state. */
export function presentOccurrence(o: OccRow) {
  return {
    id: o.id,
    taskId: o.taskId,
    locationId: o.locationId,
    title: o.task.title,
    instructions: o.task.instructions,
    checklist: checklistOf(o.task),
    checklistDone: doneOf(o),
    priority: o.task.priority,
    recurrence: o.task.recurrence,
    requireNote: o.task.requireNote,
    dueOn: dateToDay(o.dueOn),
    dueAt: o.dueAt,
    dueTime: o.task.dueTime,
    status: o.status,
    assignee: assigneeOf(o.task),
    completedBy: o.completedBy,
    completedAt: o.completedAt,
    late: o.late,
    note: o.note,
    skipReason: o.skipReason,
  };
}
export type Occurrence = ReturnType<typeof presentOccurrence>;

/** Soonest first; HIGH before NORMAL before LOW on the same day; then by the time due. */
export const byUrgency = (a: Occurrence, b: Occurrence) =>
  a.dueOn.localeCompare(b.dueOn) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.dueAt.getTime() - b.dueAt.getTime();

/** A task as the API shows it: names for its relations and the next day it is due. */
export function presentTask(t: TaskRow, today: DayISO) {
  return { ...t, checklist: checklistOf(t), startsOn: dateToDay(t.startsOn), endsOn: t.endsOn ? dateToDay(t.endsOn) : null, nextDueOn: t.active ? nextDueOn(t, today) : null };
}

/** Who may complete an occurrence: anyone, that role, or that one employee. */
export const visibleTo = (task: { assigneeType: TaskAssignee; assigneeRole: StaffRole | null; assigneeId: string | null }, who: { staffId: string; role: StaffRole }) =>
  task.assigneeType === "ANYONE" || (task.assigneeType === "ROLE" && task.assigneeRole === who.role) || (task.assigneeType === "EMPLOYEE" && task.assigneeId === who.staffId);

// ── Materializing occurrences ────────────────────────────────────

async function locationOf(db: Db, locationId: string) {
  const loc = await db.location.findUnique({ where: { id: locationId } });
  if (!loc) throw notFound("Location");
  return loc;
}

/**
 * Create the missing OPEN occurrences at a location for every active task that
 * applies to it (its own, or every-store), for each day in [from, to].
 * Idempotent: existing rows (any status) are left alone.
 */
export async function materialize(db: Db, input: { locationId: string; from?: DayISO; to?: DayISO; now?: Date }) {
  const loc = await locationOf(db, input.locationId);
  const today = localDate(input.now ?? new Date(), loc.timezone);
  const from = input.from ?? addDays(today, -MATERIALIZE_BACK_DAYS);
  const to = input.to ?? addDays(today, MATERIALIZE_AHEAD_DAYS);
  if (to < from) return { created: 0, from, to };
  const tasks = await db.task.findMany({
    where: { active: true, OR: [{ locationId: loc.id }, { locationId: null }], startsOn: { lte: dayToDate(to) }, AND: [{ OR: [{ endsOn: null }, { endsOn: { gte: dayToDate(from) } }] }] },
  });
  const data: Prisma.TaskOccurrenceCreateManyInput[] = [];
  // A task's days start when its schedule was (re)defined, in this store's zone: a task
  // created or rescheduled today never gets backdated days nobody was asked to do.
  const floors = new Map(tasks.map((t) => [t.id, localDate(t.scheduleChangedAt, loc.timezone)]));
  const days = Math.min(daysBetween(from, to), MAX_MATERIALIZE_DAYS);
  for (let i = 0, day = from; i <= days; i++, day = addDays(day, 1)) {
    for (const t of tasks) {
      if (day < floors.get(t.id)! || !occursOn(t, day)) continue;
      data.push({ taskId: t.id, locationId: loc.id, dueOn: dayToDate(day), dueAt: dueAtFor(day, t.dueTime, loc.timezone) });
    }
  }
  const r = data.length ? await db.taskOccurrence.createMany({ data, skipDuplicates: true }) : { count: 0 };
  return { created: r.count, from, to };
}

/** Every active location, so every-store tasks and location-less reads cover them all. */
const activeLocations = (db: Db) => db.location.findMany({ where: { active: true }, orderBy: { createdAt: "asc" } });

/** Materialize at one location, or at every active one. */
export async function materializeAll(db: Db, input: { locationId?: string; from?: DayISO; to?: DayISO; now?: Date }) {
  const locations = input.locationId ? [await locationOf(db, input.locationId)] : await activeLocations(db);
  for (const loc of locations) await materialize(db, { ...input, locationId: loc.id });
  return locations;
}

// ── What an employee sees at sign-in ─────────────────────────────

/** Today's tasks, what is overdue, and what is coming up: everything the sign-in screen needs in one call. */
export async function mine(db: Db, input: { staffId: string; role: StaffRole; locationId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const loc = await locationOf(db, input.locationId);
  await materialize(db, { locationId: loc.id, now });
  const today = localDate(now, loc.timezone);
  const horizon = addDays(today, MATERIALIZE_AHEAD_DAYS);
  const rows = await db.taskOccurrence.findMany({
    where: { locationId: loc.id, OR: [{ status: "OPEN", dueOn: { lte: dayToDate(horizon) } }, { dueOn: dayToDate(today) }] },
    include: occInclude,
  });
  const visible = rows.filter((o) => visibleTo(o.task, input)).map(presentOccurrence).sort(byUrgency);
  const open = visible.filter((o) => o.status === "OPEN");
  const todays = open.filter((o) => o.dueOn === today);
  const overdue = open.filter((o) => o.dueOn < today);
  const upcoming = open.filter((o) => o.dueOn > today);
  const doneToday = visible.filter((o) => o.dueOn === today && o.status !== "OPEN").length;
  return { today: todays, overdue, upcoming, counts: { open: todays.length + overdue.length, overdue: overdue.length, doneToday } };
}

/** A manager's view of one day at a store: every occurrence (all statuses, all assignees) plus what is still overdue. */
export async function board(db: Db, input: { locationId: string; date: DayISO; now?: Date }) {
  const now = input.now ?? new Date();
  const loc = await locationOf(db, input.locationId);
  const today = localDate(now, loc.timezone);
  // The usual window, plus just that one day when it lies outside it (never the days between).
  const win = await materialize(db, { locationId: loc.id, now });
  if (input.date < win.from || input.date > win.to) await materialize(db, { locationId: loc.id, from: input.date, to: input.date, now });
  const rows = await db.taskOccurrence.findMany({
    where: { locationId: loc.id, OR: [{ dueOn: dayToDate(input.date) }, { status: "OPEN", dueOn: { lt: dayToDate(today) } }] },
    include: occInclude,
  });
  const all = rows.map(presentOccurrence).sort(byUrgency);
  return { date: input.date, occurrences: all.filter((o) => o.dueOn === input.date), overdue: all.filter((o) => o.dueOn !== input.date && o.status === "OPEN" && o.dueOn < today) };
}

export interface OccurrenceFilter {
  locationId?: string;
  from?: DayISO;
  to?: DayISO;
  status?: TaskStatus;
  /** Completed or skipped by this employee. */
  staffId?: string;
  taskId?: string;
  take?: number;
}

/** History, newest first. */
export async function listOccurrences(db: Db, f: OccurrenceFilter, now = new Date()) {
  await materializeAll(db, { locationId: f.locationId, now });
  const rows = await db.taskOccurrence.findMany({
    where: {
      locationId: f.locationId,
      status: f.status,
      completedById: f.staffId,
      taskId: f.taskId,
      ...(f.from || f.to ? { dueOn: { gte: f.from ? dayToDate(f.from) : undefined, lte: f.to ? dayToDate(f.to) : undefined } } : {}),
    },
    orderBy: [{ dueOn: "desc" }, { dueAt: "desc" }, { createdAt: "desc" }],
    take: Math.min(f.take ?? 500, 500),
    include: occInclude,
  });
  return rows.map(presentOccurrence);
}

// ── Defining tasks ───────────────────────────────────────────────

export interface TaskInput {
  locationId?: string | null;
  title: string;
  instructions?: string | null;
  checklist?: string[];
  priority?: TaskPriority;
  recurrence: TaskRecurrence;
  daysOfWeek?: number[];
  dayOfMonth?: number | null;
  dueTime?: string | null;
  startsOn: DayISO;
  endsOn?: DayISO | null;
  assigneeType?: TaskAssignee;
  assigneeRole?: StaffRole | null;
  assigneeId?: string | null;
  requireNote?: boolean;
  active?: boolean;
}

/**
 * The rules every task (new or edited) must satisfy; returns the normalized data to store.
 * `before` is the stored task on an edit: an employee it was already assigned to may
 * have since been deactivated, which must not block editing its other fields.
 */
async function validateTask(db: Db, t: Required<TaskInput>, before?: { assigneeType: TaskAssignee; assigneeId: string | null }) {
  const title = t.title.trim();
  if (title.length < 1 || title.length > 120) throw badRequest("TITLE", "A title is 1 to 120 characters");
  if (t.checklist.length > 30) throw badRequest("CHECKLIST_TOO_LONG", "A checklist has at most 30 steps");
  const checklist = t.checklist.map((s) => String(s).trim());
  if (checklist.some((s) => s.length < 1 || s.length > 120)) throw badRequest("CHECKLIST_STEP", "Each checklist step is 1 to 120 characters");
  if (!isValidDay(t.startsOn)) throw badRequest("STARTS_ON", "startsOn must be a YYYY-MM-DD date");
  let endsOn = t.endsOn ?? null;
  if (t.recurrence === "ONCE") endsOn = null;
  if (endsOn && !isValidDay(endsOn)) throw badRequest("ENDS_ON", "endsOn must be a YYYY-MM-DD date");
  if (endsOn && endsOn < t.startsOn) throw badRequest("ENDS_BEFORE_START", "The end date is before the start date");
  const daysOfWeek = t.recurrence === "WEEKLY" ? [...new Set(t.daysOfWeek)].sort((a, b) => a - b) : [];
  if (t.recurrence === "WEEKLY" && (daysOfWeek.length === 0 || daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) {
    throw badRequest("DAYS_OF_WEEK", "A weekly task needs at least one day of the week (0 = Sunday … 6 = Saturday)");
  }
  const dayOfMonth = t.recurrence === "MONTHLY" ? t.dayOfMonth : null;
  if (t.recurrence === "MONTHLY" && (!dayOfMonth || !Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)) {
    throw badRequest("DAY_OF_MONTH", "A monthly task needs a day of the month from 1 to 31");
  }
  const dueTime = t.dueTime || null;
  if (dueTime && !TIME_RE.test(dueTime)) throw badRequest("DUE_TIME", "dueTime is HH:mm (24-hour)");
  let assigneeRole: StaffRole | null = null;
  let assigneeId: string | null = null;
  if (t.assigneeType === "ROLE") {
    if (!t.assigneeRole) throw badRequest("ASSIGNEE_ROLE", "Pick the role this task is for");
    assigneeRole = t.assigneeRole;
  } else if (t.assigneeType === "EMPLOYEE") {
    if (!t.assigneeId) throw badRequest("ASSIGNEE", "Pick the employee this task is for");
    const who = await db.staff.findUnique({ where: { id: t.assigneeId } });
    const unchanged = before?.assigneeType === "EMPLOYEE" && before.assigneeId === t.assigneeId;
    if (!who || (!who.active && !unchanged)) throw badRequest("ASSIGNEE", "That employee isn't active");
    assigneeId = who.id;
  }
  const locationId = t.locationId || null;
  if (locationId && !(await db.location.findUnique({ where: { id: locationId } }))) throw notFound("Location");
  return {
    locationId,
    title,
    instructions: t.instructions?.trim() || null,
    checklist,
    priority: t.priority,
    recurrence: t.recurrence,
    daysOfWeek,
    dayOfMonth,
    dueTime,
    startsOn: dayToDate(t.startsOn),
    endsOn: endsOn ? dayToDate(endsOn) : null,
    assigneeType: t.assigneeType,
    assigneeRole,
    assigneeId,
    requireNote: t.requireNote,
    active: t.active,
  };
}

const withDefaults = (t: TaskInput): Required<TaskInput> => ({
  locationId: t.locationId ?? null,
  title: t.title,
  instructions: t.instructions ?? null,
  checklist: t.checklist ?? [],
  priority: t.priority ?? "NORMAL",
  recurrence: t.recurrence,
  daysOfWeek: t.daysOfWeek ?? [],
  dayOfMonth: t.dayOfMonth ?? null,
  dueTime: t.dueTime ?? null,
  startsOn: t.startsOn,
  endsOn: t.endsOn ?? null,
  assigneeType: t.assigneeType ?? "ANYONE",
  assigneeRole: t.assigneeRole ?? null,
  assigneeId: t.assigneeId ?? null,
  requireNote: t.requireNote ?? false,
  active: t.active ?? true,
});

/** Fields that decide when, where and for whom occurrences exist. */
const SCHEDULE_FIELDS = ["recurrence", "daysOfWeek", "dayOfMonth", "dueTime", "startsOn", "endsOn", "locationId", "assigneeType", "assigneeRole", "assigneeId", "active"] as const;

export async function getTask(db: Db, id: string) {
  const t = await db.task.findUnique({ where: { id }, include: taskInclude });
  if (!t) throw notFound("Task");
  return t;
}

/** The store-local "today" at the task's own location, or the first one for every-store tasks. */
async function todayFor(db: Db, task: { locationId: string | null }, now: Date) {
  const loc = task.locationId ? await db.location.findUnique({ where: { id: task.locationId } }) : await db.location.findFirst({ orderBy: { createdAt: "asc" } });
  return localDate(now, loc?.timezone ?? "America/New_York");
}

export interface TaskFilter {
  locationId?: string;
  active?: boolean;
  recurrence?: TaskRecurrence;
  assigneeId?: string;
}

/** Task definitions with names and the next day each is due. `locationId` includes every-store tasks. */
export async function listTasks(db: Db, f: TaskFilter, now = new Date()) {
  const rows = await db.task.findMany({
    where: {
      ...(f.locationId ? { OR: [{ locationId: f.locationId }, { locationId: null }] } : {}),
      active: f.active,
      recurrence: f.recurrence,
      assigneeId: f.assigneeId,
    },
    orderBy: [{ active: "desc" }, { title: "asc" }],
    include: taskInclude,
  });
  const locations = await db.location.findMany({ orderBy: { createdAt: "asc" } });
  const fallback = locations.find((l) => l.id === f.locationId) ?? locations[0];
  const todayAt = (locationId: string | null) => localDate(now, (locations.find((l) => l.id === locationId) ?? fallback)?.timezone ?? "America/New_York");
  return rows.map((t) => presentTask(t, todayAt(t.locationId)));
}

/** Drop the task's OPEN occurrences from today on (every location, each in its own zone); history stays. */
async function dropFutureOpen(db: Db, taskId: string, now: Date) {
  for (const loc of await db.location.findMany()) {
    await db.taskOccurrence.deleteMany({ where: { taskId, locationId: loc.id, status: "OPEN", dueOn: { gte: dayToDate(localDate(now, loc.timezone)) } } });
  }
}

/** Create occurrences at the task's location, or everywhere for an every-store task. */
const materializeFor = (db: Db, task: { locationId: string | null }, now: Date) => materializeAll(db, { locationId: task.locationId ?? undefined, now });

export async function createTask(db: Db, input: TaskInput, byId: string, now = new Date()) {
  const data = await validateTask(db, withDefaults(input));
  const task = await db.task.create({ data: { ...data, createdById: byId }, include: taskInclude });
  if (task.active) await materializeFor(db, task, now);
  await audit(db, { action: "TASK_CREATED", staffId: byId, locationId: task.locationId, details: { taskId: task.id, title: task.title, recurrence: task.recurrence, startsOn: dateToDay(task.startsOn), assignee: assigneeOf(task) } });
  return presentTask(task, await todayFor(db, task, now));
}

export async function updateTask(db: Db, id: string, input: Partial<TaskInput>, byId: string, now = new Date()) {
  const before = await getTask(db, id);
  const merged: Required<TaskInput> = {
    ...withDefaults({ ...before, checklist: checklistOf(before), startsOn: dateToDay(before.startsOn), endsOn: before.endsOn ? dateToDay(before.endsOn) : null }),
    ...(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<TaskInput>),
  } as Required<TaskInput>;
  const data = await validateTask(db, merged, before);
  const diff = changes(
    { ...before, checklist: checklistOf(before), startsOn: dateToDay(before.startsOn), endsOn: before.endsOn ? dateToDay(before.endsOn) : null },
    { ...data, startsOn: dateToDay(data.startsOn), endsOn: data.endsOn ? dateToDay(data.endsOn) : null },
  );
  if (Object.keys(diff).length === 0) return presentTask(before, await todayFor(db, before, now));
  // A schedule change restarts the task's days from now: what was due before stays as it was.
  const rescheduled = SCHEDULE_FIELDS.some((f) => f in diff);
  const task = await db.task.update({ where: { id }, data: rescheduled ? { ...data, scheduleChangedAt: now } : data, include: taskInclude });
  if (rescheduled) {
    await dropFutureOpen(db, id, now);
    if (task.active) await materializeFor(db, task, now);
  }
  await audit(db, { action: "TASK_UPDATED", staffId: byId, locationId: task.locationId, details: { taskId: id, title: task.title, changes: diff } });
  return presentTask(task, await todayFor(db, task, now));
}

/** Deactivate: no new occurrences, today's and future OPEN ones are dropped, completed history stays. */
export async function deactivateTask(db: Db, id: string, byId: string, now = new Date()) {
  const before = await getTask(db, id);
  const task = before.active ? await db.task.update({ where: { id }, data: { active: false }, include: taskInclude }) : before;
  await dropFutureOpen(db, id, now);
  await audit(db, { action: "TASK_DELETED", staffId: byId, locationId: task.locationId, details: { taskId: id, title: task.title, recurrence: task.recurrence } });
  return presentTask(task, await todayFor(db, task, now));
}

// ── Working an occurrence ────────────────────────────────────────

async function getOccurrence(db: Db, id: string) {
  const o = await db.taskOccurrence.findUnique({ where: { id }, include: occInclude });
  if (!o) throw notFound("Task");
  return o;
}

const mustBeOpen = (o: { status: TaskStatus }) => {
  if (o.status !== "OPEN") throw conflict("TASK_NOT_OPEN", "This task was already completed");
};
const mustBeVisible = (o: OccRow, who: { staffId: string; role: StaffRole; manage: boolean }) => {
  if (!who.manage && !visibleTo(o.task, who)) throw new AppError(403, "TASK_NOT_YOURS", "This task is assigned to someone else", { permission: "MANAGE_TASKS" });
};
/** Checklist indices must point at real steps; duplicates collapse. */
const checklistIndices = (o: OccRow, done: number[]) => {
  const n = checklistOf(o.task).length;
  if (done.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) throw badRequest("CHECKLIST_INDEX", `Checklist steps are numbered 0 to ${n - 1}`);
  return [...new Set(done)].sort((a, b) => a - b);
};
const auditDetails = (o: OccRow) => ({ taskId: o.taskId, occurrenceId: o.id, title: o.task.title, dueOn: dateToDay(o.dueOn) });

/** Save partial checklist progress without completing. */
export async function saveChecklist(db: Db, input: { occurrenceId: string; staffId: string; role: StaffRole; manage: boolean; done: number[] }) {
  const o = await getOccurrence(db, input.occurrenceId);
  mustBeOpen(o);
  mustBeVisible(o, input);
  const done = checklistIndices(o, input.done);
  return presentOccurrence(await db.taskOccurrence.update({ where: { id: o.id }, data: { checklistDone: done }, include: occInclude }));
}

/** Mark it done. Every checklist step is ticked unless told otherwise; `late` when past dueAt. */
export async function complete(
  db: Db,
  input: { occurrenceId: string; staffId: string; role: StaffRole; manage: boolean; note?: string | null; checklistDone?: number[]; now?: Date; ip?: string },
) {
  const now = input.now ?? new Date();
  const o = await getOccurrence(db, input.occurrenceId);
  mustBeOpen(o);
  mustBeVisible(o, input);
  const note = input.note?.trim() || null;
  if (o.task.requireNote && !note) throw badRequest("NOTE_REQUIRED", "This task needs a note to be completed");
  const done = input.checklistDone ? checklistIndices(o, input.checklistDone) : checklistOf(o.task).map((_, i) => i);
  const late = now.getTime() > o.dueAt.getTime();
  const updated = await db.taskOccurrence.update({
    where: { id: o.id },
    data: { status: "DONE", completedById: input.staffId, completedAt: now, late, note, checklistDone: done },
    include: occInclude,
  });
  await audit(db, { action: "TASK_COMPLETED", staffId: input.staffId, locationId: o.locationId, ip: input.ip, details: { ...auditDetails(o), late, note } });
  return presentOccurrence(updated);
}

/** Skip with a reason (gated by TASK_SKIP at the route); someone else's task needs MANAGE_TASKS, like completing it. */
export async function skip(
  db: Db,
  input: { occurrenceId: string; staffId: string; role: StaffRole; manage: boolean; reason: string; approverId?: string; now?: Date; ip?: string },
) {
  const now = input.now ?? new Date();
  const o = await getOccurrence(db, input.occurrenceId);
  mustBeOpen(o);
  mustBeVisible(o, input);
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 300) throw badRequest("REASON", "Say why in 1 to 300 characters");
  const updated = await db.taskOccurrence.update({
    where: { id: o.id },
    data: { status: "SKIPPED", completedById: input.staffId, completedAt: now, late: false, skipReason: reason },
    include: occInclude,
  });
  await audit(db, { action: "TASK_SKIPPED", staffId: input.staffId, approverId: input.approverId, locationId: o.locationId, ip: input.ip, details: { ...auditDetails(o), reason } });
  return presentOccurrence(updated);
}

/** Back to OPEN (a manager undoing a mistaken complete or skip). Checklist progress is kept. */
export async function reopen(db: Db, input: { occurrenceId: string; staffId: string; ip?: string }) {
  const o = await getOccurrence(db, input.occurrenceId);
  if (o.status === "OPEN") throw conflict("TASK_OPEN", "This task is already open");
  const updated = await db.taskOccurrence.update({
    where: { id: o.id },
    data: { status: "OPEN", completedById: null, completedAt: null, late: false, note: null, skipReason: null },
    include: occInclude,
  });
  await audit(db, { action: "TASK_REOPENED", staffId: input.staffId, locationId: o.locationId, ip: input.ip, details: { ...auditDetails(o), was: o.status, completedById: o.completedById } });
  return presentOccurrence(updated);
}

// ── Reports ──────────────────────────────────────────────────────

export interface TaskReportRow {
  taskId: string;
  title: string;
  recurrence: TaskRecurrence;
  due: number;
  done: number;
  late: number;
  skipped: number;
  missed: number;
  /** done / due, 0..1 */
  completionRate: number;
}
export interface EmployeeReportRow {
  staffId: string;
  name: string;
  done: number;
  late: number;
  skipped: number;
}
const rate = (done: number, due: number) => (due > 0 ? Math.round((done / due) * 1000) / 1000 : 0);

/** Completion per task and per employee over a range of store-local days. `missed` = still open past its due time. */
export async function report(db: Db, input: { locationId?: string; from: DayISO; to: DayISO; now?: Date }) {
  const now = input.now ?? new Date();
  if (!isValidDay(input.from) || !isValidDay(input.to)) throw badRequest("RANGE", "from and to are YYYY-MM-DD dates");
  if (input.to < input.from) throw badRequest("RANGE", "End must be after start");
  if (daysBetween(input.from, input.to) > MAX_MATERIALIZE_DAYS) throw badRequest("RANGE", "Pick a range of up to a year");
  // Only the usual window: a report never backfills history nobody saw (it would all show as overdue).
  await materializeAll(db, { locationId: input.locationId, now });
  const rows = await db.taskOccurrence.findMany({
    where: { locationId: input.locationId, dueOn: { gte: dayToDate(input.from), lte: dayToDate(input.to) } },
    include: occInclude,
    orderBy: { dueOn: "asc" },
  });
  const tasks = new Map<string, TaskReportRow>();
  const staff = new Map<string, EmployeeReportRow>();
  const totals = { due: 0, done: 0, late: 0, skipped: 0, missed: 0, completionRate: 0 };
  for (const o of rows) {
    const t = tasks.get(o.taskId) ?? { taskId: o.taskId, title: o.task.title, recurrence: o.task.recurrence, due: 0, done: 0, late: 0, skipped: 0, missed: 0, completionRate: 0 };
    t.due += 1;
    totals.due += 1;
    const done = o.status === "DONE";
    const late = done && o.late;
    const skipped = o.status === "SKIPPED";
    const missed = o.status === "OPEN" && o.dueAt.getTime() < now.getTime();
    if (done) (t.done += 1), (totals.done += 1);
    if (late) (t.late += 1), (totals.late += 1);
    if (skipped) (t.skipped += 1), (totals.skipped += 1);
    if (missed) (t.missed += 1), (totals.missed += 1);
    tasks.set(o.taskId, t);
    if ((done || skipped) && o.completedBy) {
      const s = staff.get(o.completedBy.id) ?? { staffId: o.completedBy.id, name: o.completedBy.name, done: 0, late: 0, skipped: 0 };
      if (done) s.done += 1;
      if (late) s.late += 1;
      if (skipped) s.skipped += 1;
      staff.set(s.staffId, s);
    }
  }
  const byTask = [...tasks.values()].map((t) => ({ ...t, completionRate: rate(t.done, t.due) })).sort((a, b) => a.title.localeCompare(b.title));
  const byEmployee = [...staff.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { from: input.from, to: input.to, byTask, byEmployee, totals: { ...totals, completionRate: rate(totals.done, totals.due) } };
}
export type TaskReport = Awaited<ReturnType<typeof report>>;

export const reportCsv = (r: TaskReport) => toCsv(r.byTask as unknown as Record<string, unknown>[]);
