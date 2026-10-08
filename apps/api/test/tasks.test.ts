import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, dayToDate, dueAtFor, materialize, nextDueOn, occursOn, weekdayOf } from "../src/services/tasks.js";
import { localDate } from "../src/services/timeclock.js";
import { PINS, prisma, setup, type World } from "./helpers.js";

let w: World;
let ids: { cashier: string; manager: string; owner: string };
/** Today in the test store's zone (America/New_York, the Location default). */
let today: string;
const day = (n: number) => addDays(today, n);

beforeEach(async () => {
  w = await setup();
  const [c, m, o] = await Promise.all([
    prisma.staff.findFirstOrThrow({ where: { role: "CASHIER" } }),
    prisma.staff.findFirstOrThrow({ where: { role: "MANAGER" } }),
    prisma.staff.findFirstOrThrow({ where: { role: "OWNER" } }),
  ]);
  ids = { cashier: c.id, manager: m.id, owner: o.id };
  today = localDate(new Date(), "America/New_York");
});
afterAll(() => prisma.$disconnect());

const audits = async (action: string) => (await w.as(w.manager, "GET", `/audit?action=${action}`)).body as any[];
/** A task at the test store (a manager makes it). */
const mk = async (body: object, as = w.manager) => {
  const res = await w.as(as, "POST", "/tasks", { locationId: w.locationId, recurrence: "DAILY", startsOn: today, ...body });
  if (res.status !== 201) throw new Error(`POST /tasks ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.task as any;
};
const mine = async (token: string) => {
  const res = await w.as(token, "GET", `/tasks/mine?locationId=${w.locationId}`);
  expect(res.status).toBe(200);
  return res.body as { today: any[]; overdue: any[]; upcoming: any[]; counts: { open: number; overdue: number; doneToday: number } };
};
/** The occurrence of a task on a day (after a read has materialized it). */
const occ = (taskId: string, on: string) => prisma.taskOccurrence.findFirstOrThrow({ where: { taskId, locationId: w.locationId, dueOn: dayToDate(on) } });
const occurrences = (taskId: string) => prisma.taskOccurrence.findMany({ where: { taskId }, orderBy: { dueOn: "asc" } });
const withApproval = (token: string, url: string, body: object, as = w.cashier) =>
  w.app.inject({ method: "POST", url, payload: body, headers: { authorization: `Bearer ${as}`, "x-approval-token": token } });

describe("schedule rules", () => {
  const base = { daysOfWeek: [] as number[], dayOfMonth: null, startsOn: "2026-01-10", endsOn: null };

  it("ONCE is only its day; DAILY is every day from startsOn to endsOn", () => {
    const once = { ...base, recurrence: "ONCE" as const };
    expect(occursOn(once, "2026-01-10")).toBe(true);
    expect(occursOn(once, "2026-01-09")).toBe(false);
    expect(occursOn(once, "2026-01-11")).toBe(false);
    const daily = { ...base, recurrence: "DAILY" as const, endsOn: "2026-01-12" };
    expect(occursOn(daily, "2026-01-09")).toBe(false);
    expect(occursOn(daily, "2026-01-10")).toBe(true);
    expect(occursOn(daily, "2026-01-12")).toBe(true);
    expect(occursOn(daily, "2026-01-13")).toBe(false);
  });

  it("WEEKLY falls on each listed weekday (computed from the day string, not server time)", () => {
    // 2026-01-10 is a Saturday.
    expect(weekdayOf("2026-01-10")).toBe(6);
    const weekly = { ...base, recurrence: "WEEKLY" as const, daysOfWeek: [1, 3] };
    expect(occursOn(weekly, "2026-01-12")).toBe(true); // Monday
    expect(occursOn(weekly, "2026-01-13")).toBe(false);
    expect(occursOn(weekly, "2026-01-14")).toBe(true); // Wednesday
    expect(occursOn(weekly, "2026-01-05")).toBe(false); // a Monday before startsOn
    expect(nextDueOn(weekly, "2026-01-10")).toBe("2026-01-12");
  });

  it("MONTHLY 31 lands on the last day of shorter months, including February 28 and 29", () => {
    const monthly = { ...base, recurrence: "MONTHLY" as const, dayOfMonth: 31 };
    expect(occursOn(monthly, "2026-01-31")).toBe(true);
    expect(occursOn(monthly, "2026-02-28")).toBe(true);
    expect(occursOn(monthly, "2026-02-27")).toBe(false);
    expect(occursOn(monthly, "2028-02-29")).toBe(true);
    expect(occursOn(monthly, "2028-02-28")).toBe(false);
    expect(occursOn(monthly, "2026-04-30")).toBe(true);
    expect(occursOn({ ...monthly, dayOfMonth: 15 }, "2026-02-15")).toBe(true);
    expect(occursOn({ ...monthly, endsOn: "2026-03-01" }, "2026-03-31")).toBe(false);
    expect(nextDueOn(monthly, "2026-02-01")).toBe("2026-02-28");
  });

  it("dueAtFor converts the store's wall clock to an instant across DST", () => {
    // New York springs forward on 2026-03-08: EST the day before, EDT that day.
    expect(dueAtFor("2026-03-07", "10:00", "America/New_York").toISOString()).toBe("2026-03-07T15:00:00.000Z");
    expect(dueAtFor("2026-03-08", "10:00", "America/New_York").toISOString()).toBe("2026-03-08T14:00:00.000Z");
    expect(dueAtFor("2026-03-08", null, "America/New_York").toISOString()).toBe("2026-03-09T03:59:59.999Z");
    // Fall back on 2026-11-01.
    expect(dueAtFor("2026-11-01", "10:00", "America/New_York").toISOString()).toBe("2026-11-01T15:00:00.000Z");
    // A west-coast store.
    expect(dueAtFor("2026-07-01", "09:00", "America/Los_Angeles").toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(dueAtFor("2026-01-15", null, "America/Los_Angeles").toISOString()).toBe("2026-01-16T07:59:59.999Z");
  });
});

describe("materializing occurrences", () => {
  it("is idempotent and covers today − 14 to today + 7, bounded by endsOn", async () => {
    const t = await mk({ title: "Sweep", startsOn: day(-3) });
    expect(await occurrences(t.id)).toHaveLength(3 + 1 + 7);
    await mine(w.cashier);
    await materialize(prisma, { locationId: w.locationId });
    expect(await occurrences(t.id)).toHaveLength(11);
    const first = await occ(t.id, day(-3));
    expect(first.status).toBe("OPEN");
    expect(first.dueAt.toISOString()).toBe(dueAtFor(day(-3), null, "America/New_York").toISOString());

    const ends = await mk({ title: "Short run", startsOn: day(-3), endsOn: day(1) });
    expect((await occurrences(ends.id)).map((o) => o.dueOn.toISOString().slice(0, 10))).toEqual([day(-3), day(-2), day(-1), day(0), day(1)]);

    const timed = await mk({ title: "Timed", dueTime: "10:30" });
    expect((await occ(timed.id, today)).dueAt.toISOString()).toBe(dueAtFor(today, "10:30", "America/New_York").toISOString());
  });

  it("an every-store task appears at every location; a store's task only there", async () => {
    const second = await prisma.location.create({ data: { name: "Uptown", timezone: "America/Los_Angeles" } });
    const everywhere = await mk({ title: "Everywhere", locationId: null, recurrence: "ONCE" });
    const here = await mk({ title: "Here", recurrence: "ONCE" });
    await materialize(prisma, { locationId: second.id });
    const at = async (taskId: string) => (await prisma.taskOccurrence.findMany({ where: { taskId } })).map((o) => o.locationId).sort();
    expect(await at(everywhere.id)).toEqual([w.locationId, second.id].sort());
    expect(await at(here.id)).toEqual([w.locationId]);
    // Due at the end of the day in each store's own zone.
    const la = await prisma.taskOccurrence.findFirstOrThrow({ where: { taskId: everywhere.id, locationId: second.id } });
    expect(la.dueAt.toISOString()).toBe(dueAtFor(today, null, "America/Los_Angeles").toISOString());
    expect(everywhere.location).toBeNull();
    expect(here.location).toMatchObject({ id: w.locationId, name: "Main St" });
  });
});

describe("what an employee sees at sign-in", () => {
  it("shows tasks for anyone, their role, or them, in today / overdue / upcoming buckets", async () => {
    const anyone = await mk({ title: "Open up", priority: "HIGH", checklist: ["Lights", "Float"] });
    const managers = await mk({ title: "Count the safe", assigneeType: "ROLE", assigneeRole: "MANAGER" });
    const cashierOnly = await mk({ title: "Sort singles", assigneeType: "EMPLOYEE", assigneeId: ids.cashier, recurrence: "ONCE", startsOn: day(-1) });
    const soon = await mk({ title: "Deep clean", recurrence: "ONCE", startsOn: day(3), priority: "LOW" });
    await mk({ title: "Far off", recurrence: "ONCE", startsOn: day(10) });

    const c = await mine(w.cashier);
    expect(c.today.map((o) => o.title)).toEqual(["Open up"]);
    expect(c.overdue.map((o) => o.title)).toEqual(["Sort singles"]);
    // The daily task's next seven days, with the LOW one-off after that day's NORMAL one.
    expect(c.upcoming.map((o) => `${o.title}@${o.dueOn}`)).toEqual([...[1, 2, 3].map((n) => `Open up@${day(n)}`), `Deep clean@${day(3)}`, ...[4, 5, 6, 7].map((n) => `Open up@${day(n)}`)]);
    expect(c.counts).toEqual({ open: 2, overdue: 1, doneToday: 0 });
    expect(c.today[0]).toMatchObject({
      taskId: anyone.id,
      title: "Open up",
      checklist: ["Lights", "Float"],
      checklistDone: [],
      priority: "HIGH",
      recurrence: "DAILY",
      dueOn: today,
      dueTime: null,
      status: "OPEN",
      assignee: { type: "ANYONE" },
      completedBy: null,
      late: false,
    });
    expect(c.overdue[0].assignee).toEqual({ type: "EMPLOYEE", employee: { id: ids.cashier, name: "CASHIER" } });
    expect(c.upcoming[3]).toMatchObject({ taskId: soon.id, dueOn: day(3), priority: "LOW" });

    const m = await mine(w.manager);
    expect(m.today.map((o) => o.title)).toEqual(["Open up", "Count the safe"]);
    expect(m.today[1].assignee).toEqual({ type: "ROLE", role: "MANAGER" });
    expect(m.overdue).toEqual([]);
    expect(m.today.map((o) => o.taskId)).toContain(managers.id);
    expect(m.today.map((o) => o.taskId)).not.toContain(cashierOnly.id);
  });

  it("orders today's list HIGH first, then by the time due", async () => {
    await mk({ title: "Low late", priority: "LOW", dueTime: "09:00" });
    await mk({ title: "Normal", dueTime: "18:00" });
    await mk({ title: "High", priority: "HIGH", dueTime: "20:00" });
    await mk({ title: "Normal early", dueTime: "08:00" });
    expect((await mine(w.cashier)).today.map((o) => o.title)).toEqual(["High", "Normal early", "Normal", "Low late"]);
  });
});

describe("completing", () => {
  it("marks it done with everyone's checklist ticked, and logs it", async () => {
    const t = await mk({ title: "Open up", checklist: ["Lights", "Float", "Display"] });
    const o = await occ(t.id, today);
    // Partial progress first.
    const partial = await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/checklist`, { done: [1, 1] });
    expect(partial.status).toBe(200);
    expect(partial.body.occurrence).toMatchObject({ status: "OPEN", checklistDone: [1] });
    expect((await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/checklist`, { done: [3] })).body.error).toBe("CHECKLIST_INDEX");

    const done = await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/complete`, { note: "all good" });
    expect(done.status).toBe(200);
    expect(done.body.occurrence).toMatchObject({ id: o.id, status: "DONE", checklistDone: [0, 1, 2], completedBy: { id: ids.cashier, name: "CASHIER" }, late: false, note: "all good" });
    expect(done.body.occurrence.completedAt).not.toBeNull();

    const after = await mine(w.cashier);
    expect(after.today).toEqual([]);
    expect(after.counts).toEqual({ open: 0, overdue: 0, doneToday: 1 });

    const log = await audits("TASK_COMPLETED");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ staffId: ids.cashier, locationId: w.locationId, details: { taskId: t.id, occurrenceId: o.id, title: "Open up", dueOn: today, late: false, note: "all good" } });

    expect((await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/complete`)).status).toBe(409);
    expect((await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/complete`)).body.error).toBe("TASK_NOT_OPEN");
    expect((await w.as(w.cashier, "POST", "/tasks/occurrences/nope/complete")).status).toBe(404);
  });

  it("flags a late completion", async () => {
    const t = await mk({ title: "Yesterday's", recurrence: "ONCE", startsOn: day(-1) });
    const o = await occ(t.id, day(-1));
    const done = await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/complete`);
    expect(done.body.occurrence).toMatchObject({ status: "DONE", late: true });
  });

  it("insists on a note when the task asks for one", async () => {
    const t = await mk({ title: "Safe reading", requireNote: true });
    const o = await occ(t.id, today);
    const bare = await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/complete`);
    expect(bare.status).toBe(400);
    expect(bare.body.error).toBe("NOTE_REQUIRED");
    expect((await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/complete`, { note: "  " })).body.error).toBe("NOTE_REQUIRED");
    expect((await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/complete`, { note: "$412.50", checklistDone: [] })).status).toBe(200);
  });

  it("is only for the people it's assigned to, unless you manage tasks", async () => {
    const t = await mk({ title: "Count the safe", assigneeType: "ROLE", assigneeRole: "MANAGER" });
    const o = await occ(t.id, today);
    const denied = await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/complete`);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("TASK_NOT_YOURS");
    expect((await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/checklist`, { done: [] })).body.error).toBe("TASK_NOT_YOURS");

    const forCashier = await mk({ title: "Sort singles", assigneeType: "EMPLOYEE", assigneeId: ids.cashier });
    const theirs = await occ(forCashier.id, today);
    const byManager = await w.as(w.manager, "POST", `/tasks/occurrences/${theirs.id}/complete`);
    expect(byManager.status).toBe(200);
    expect(byManager.body.occurrence.completedBy).toEqual({ id: ids.manager, name: "MANAGER" });
  });
});

describe("skipping and reopening", () => {
  it("a cashier needs a manager's PIN to skip; a manager just can", async () => {
    const t = await mk({ title: "Wipe the case" });
    const o = await occ(t.id, today);
    expect((await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/skip`, {})).status).toBe(400);
    const denied = await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/skip`, { reason: "Case is being replaced" });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: "APPROVAL_REQUIRED", details: { permission: "TASK_SKIP" } });
    expect((await occ(t.id, today)).status).toBe("OPEN");

    const grant = await w.as(w.cashier, "POST", "/auth/approve", { pin: PINS.MANAGER, permissions: ["TASK_SKIP"] });
    const approved = await withApproval(grant.body.token, `/tasks/occurrences/${o.id}/skip`, { reason: "Case is being replaced" });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().occurrence).toMatchObject({ status: "SKIPPED", skipReason: "Case is being replaced", completedBy: { id: ids.cashier } });
    const log = await audits("TASK_SKIPPED");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ staffId: ids.cashier, approverId: ids.manager, details: { taskId: t.id, occurrenceId: o.id, title: "Wipe the case", reason: "Case is being replaced" } });

    const t2 = await mk({ title: "Other" });
    const o2 = await occ(t2.id, today);
    const byManager = await w.as(w.manager, "POST", `/tasks/occurrences/${o2.id}/skip`, { reason: "Closed early" });
    expect(byManager.status).toBe(200);
    expect(byManager.body.occurrence).toMatchObject({ status: "SKIPPED", skipReason: "Closed early", completedBy: { id: ids.manager } });
    expect((await audits("TASK_SKIPPED"))[0]).toMatchObject({ staffId: ids.manager, approverId: null, details: { reason: "Closed early" } });
    expect((await w.as(w.manager, "POST", `/tasks/occurrences/${o2.id}/skip`, { reason: "again" })).body.error).toBe("TASK_NOT_OPEN");
    expect((await mine(w.cashier)).counts.doneToday).toBe(2);
  });

  it("a manager reopens a done or skipped task; the checklist progress stays", async () => {
    const t = await mk({ title: "Open up", checklist: ["Lights", "Float"] });
    const o = await occ(t.id, today);
    await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/complete`, { note: "ok", checklistDone: [0] });
    expect((await w.as(w.cashier, "POST", `/tasks/occurrences/${o.id}/reopen`)).status).toBe(403);
    const reopened = await w.as(w.manager, "POST", `/tasks/occurrences/${o.id}/reopen`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.occurrence).toMatchObject({ status: "OPEN", completedBy: null, completedAt: null, late: false, note: null, checklistDone: [0] });
    expect((await w.as(w.manager, "POST", `/tasks/occurrences/${o.id}/reopen`)).status).toBe(409);
    expect((await audits("TASK_REOPENED"))[0]).toMatchObject({ staffId: ids.manager, details: { occurrenceId: o.id, was: "DONE", completedById: ids.cashier } });
    expect((await mine(w.cashier)).today.map((x) => x.id)).toEqual([o.id]);
  });
});

describe("defining tasks", () => {
  it("validates the schedule and the assignee", async () => {
    const bad = async (body: object) => {
      const res = await w.as(w.manager, "POST", "/tasks", { locationId: w.locationId, startsOn: today, ...body });
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      return res.body.error as string;
    };
    expect(await bad({ title: "Weekly", recurrence: "WEEKLY" })).toBe("DAYS_OF_WEEK");
    expect(await bad({ title: "Weekly", recurrence: "WEEKLY", daysOfWeek: [7] })).toBe("VALIDATION");
    expect(await bad({ title: "Monthly", recurrence: "MONTHLY" })).toBe("DAY_OF_MONTH");
    expect(await bad({ title: "Timed", recurrence: "DAILY", dueTime: "25:00" })).toBe("VALIDATION");
    expect(await bad({ title: "Timed", recurrence: "DAILY", dueTime: "9:00" })).toBe("VALIDATION");
    expect(await bad({ title: "Who", recurrence: "DAILY", assigneeType: "EMPLOYEE" })).toBe("ASSIGNEE");
    expect(await bad({ title: "Who", recurrence: "DAILY", assigneeType: "EMPLOYEE", assigneeId: "nobody" })).toBe("ASSIGNEE");
    expect(await bad({ title: "Role", recurrence: "DAILY", assigneeType: "ROLE" })).toBe("ASSIGNEE_ROLE");
    expect(await bad({ title: "Ends", recurrence: "DAILY", endsOn: day(-1) })).toBe("ENDS_BEFORE_START");
    expect(await bad({ title: "Where", recurrence: "DAILY", locationId: "nope" })).toBe("NOT_FOUND");
    expect(await bad({ title: "", recurrence: "DAILY" })).toBe("VALIDATION");
    expect(await bad({ title: "Long list", recurrence: "DAILY", checklist: Array.from({ length: 31 }, (_, i) => `step ${i}`) })).toBe("VALIDATION");
    expect(await bad({ title: "Bad day", recurrence: "ONCE", startsOn: "2026-02-30" })).toBe("VALIDATION");

    // A one-off ignores endsOn; stray schedule fields are dropped.
    const once = await mk({ title: "Once", recurrence: "ONCE", endsOn: day(5), daysOfWeek: [1], dayOfMonth: 3 });
    expect(once).toMatchObject({ endsOn: null, daysOfWeek: [], dayOfMonth: null, nextDueOn: today, startsOn: today });
  });

  it("lists them with names and the next due day; cashiers can't", async () => {
    const t = await mk({ title: "Count the safe", recurrence: "WEEKLY", daysOfWeek: [weekdayOf(day(2))], assigneeType: "EMPLOYEE", assigneeId: ids.cashier, dueTime: "12:00" });
    expect((await w.as(w.cashier, "GET", "/tasks")).status).toBe(403);
    const list = await w.as(w.manager, "GET", `/tasks?locationId=${w.locationId}`);
    expect(list.status).toBe(200);
    expect(list.body.tasks).toHaveLength(1);
    expect(list.body.tasks[0]).toMatchObject({ id: t.id, title: "Count the safe", nextDueOn: day(2), assignee: { id: ids.cashier, name: "CASHIER" }, location: { name: "Main St" }, createdBy: { id: ids.manager, name: "MANAGER" }, active: true });
    expect((await w.as(w.manager, "GET", `/tasks?assigneeId=${ids.manager}`)).body.tasks).toHaveLength(0);
    expect((await w.as(w.manager, "GET", "/tasks?recurrence=WEEKLY")).body.tasks).toHaveLength(1);
    expect((await audits("TASK_CREATED"))[0]).toMatchObject({ staffId: ids.manager, locationId: w.locationId, details: { taskId: t.id, title: "Count the safe", recurrence: "WEEKLY" } });
  });

  it("a schedule change drops open occurrences from today on but keeps history", async () => {
    const t = await mk({ title: "Sweep", startsOn: day(-2) });
    const yesterday = await occ(t.id, day(-1));
    await w.as(w.cashier, "POST", `/tasks/occurrences/${yesterday.id}/complete`);
    expect(await occurrences(t.id)).toHaveLength(2 + 1 + 7);

    // Words only: nothing is regenerated.
    const renamed = await w.as(w.manager, "PATCH", `/tasks/${t.id}`, { title: "Sweep the floor", instructions: "Behind the counter too" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.task).toMatchObject({ title: "Sweep the floor", instructions: "Behind the counter too" });
    expect(await occurrences(t.id)).toHaveLength(10);

    const target = day(2);
    const changed = await w.as(w.manager, "PATCH", `/tasks/${t.id}`, { recurrence: "WEEKLY", daysOfWeek: [weekdayOf(target)] });
    expect(changed.status).toBe(200);
    expect(changed.body.task).toMatchObject({ recurrence: "WEEKLY", daysOfWeek: [weekdayOf(target)], nextDueOn: target });
    const left = await occurrences(t.id);
    // The DONE one and the past OPEN one stay; today and later are only the new weekday.
    expect(left.map((o) => [o.dueOn.toISOString().slice(0, 10), o.status])).toEqual([
      [day(-2), "OPEN"],
      [day(-1), "DONE"],
      [target, "OPEN"],
    ]);
    const log = await audits("TASK_UPDATED");
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ staffId: ids.manager, details: { taskId: t.id, changes: { recurrence: { from: "DAILY", to: "WEEKLY" }, daysOfWeek: { from: [], to: [weekdayOf(target)] } } } });
    expect(log[1].details.changes).toHaveProperty("title");

    // A no-op edit changes nothing and logs nothing.
    await w.as(w.manager, "PATCH", `/tasks/${t.id}`, { title: "Sweep the floor" });
    expect(await audits("TASK_UPDATED")).toHaveLength(2);
    expect((await w.as(w.manager, "PATCH", "/tasks/missing", { title: "x" })).status).toBe(404);
    expect((await w.as(w.cashier, "PATCH", `/tasks/${t.id}`, { title: "x" })).status).toBe(403);
  });

  it("deactivating stops future occurrences and keeps the completed ones", async () => {
    const t = await mk({ title: "Sweep", startsOn: day(-1) });
    const yesterday = await occ(t.id, day(-1));
    await w.as(w.cashier, "POST", `/tasks/occurrences/${yesterday.id}/complete`);
    expect((await w.as(w.cashier, "DELETE", `/tasks/${t.id}`)).status).toBe(403);
    const gone = await w.as(w.manager, "DELETE", `/tasks/${t.id}`);
    expect(gone.status).toBe(200);
    expect(gone.body.task).toMatchObject({ id: t.id, active: false, nextDueOn: null });
    expect((await occurrences(t.id)).map((o) => o.status)).toEqual(["DONE"]);
    expect((await mine(w.cashier)).today).toEqual([]);
    expect((await w.as(w.manager, "GET", "/tasks?active=true")).body.tasks).toHaveLength(0);
    expect((await w.as(w.manager, "GET", "/tasks?active=false")).body.tasks).toHaveLength(1);
    expect((await audits("TASK_DELETED"))[0]).toMatchObject({ staffId: ids.manager, details: { taskId: t.id, title: "Sweep" } });
    // Reads don't bring it back.
    await mine(w.cashier);
    expect(await occurrences(t.id)).toHaveLength(1);
  });
});

describe("the board and the history", () => {
  it("shows a day's occurrences in every state plus what's overdue", async () => {
    const daily = await mk({ title: "Open up", startsOn: day(-2) });
    const old = await mk({ title: "Old one-off", recurrence: "ONCE", startsOn: day(-5), assigneeType: "ROLE", assigneeRole: "MANAGER" });
    await w.as(w.cashier, "POST", `/tasks/occurrences/${(await occ(daily.id, today)).id}/complete`);
    expect((await w.as(w.cashier, "GET", `/tasks/board?locationId=${w.locationId}`)).status).toBe(403);
    const board = await w.as(w.manager, "GET", `/tasks/board?locationId=${w.locationId}`);
    expect(board.status).toBe(200);
    expect(board.body.date).toBe(today);
    expect(board.body.occurrences.map((o: any) => [o.title, o.status])).toEqual([["Open up", "DONE"]]);
    expect(board.body.overdue.map((o: any) => [o.title, o.dueOn])).toEqual([
      [old.title, day(-5)],
      ["Open up", day(-2)],
      ["Open up", day(-1)],
    ]);
    const past = await w.as(w.manager, "GET", `/tasks/board?locationId=${w.locationId}&date=${day(-1)}`);
    expect(past.body.occurrences.map((o: any) => o.title)).toEqual(["Open up"]);
    expect(past.body.overdue.map((o: any) => o.dueOn)).toEqual([day(-5), day(-2)]);

    const history = await w.as(w.manager, "GET", `/tasks/occurrences?locationId=${w.locationId}&from=${day(-2)}&to=${today}`);
    expect(history.body.occurrences.map((o: any) => o.dueOn)).toEqual([today, day(-1), day(-2)]);
    expect((await w.as(w.manager, "GET", `/tasks/occurrences?status=DONE&staffId=${ids.cashier}`)).body.occurrences).toHaveLength(1);
    expect((await w.as(w.manager, "GET", `/tasks/occurrences?taskId=${old.id}`)).body.occurrences).toHaveLength(1);
  });
});

describe("the report", () => {
  it("counts due, done, late, skipped and missed per task and per employee, and downloads as CSV", async () => {
    const t = await mk({ title: "Open up", startsOn: day(-3) });
    const other = await mk({ title: "Count the safe", recurrence: "ONCE", startsOn: day(-1), assigneeType: "ROLE", assigneeRole: "MANAGER" });
    await w.as(w.cashier, "POST", `/tasks/occurrences/${(await occ(t.id, day(-3))).id}/complete`); // late
    await w.as(w.manager, "POST", `/tasks/occurrences/${(await occ(t.id, day(-2))).id}/skip`, { reason: "Closed" });
    await w.as(w.cashier, "POST", `/tasks/occurrences/${(await occ(t.id, today)).id}/complete`); // on time
    // day(-1) stays open: missed. Tomorrow onward: open but not yet due.
    await w.as(w.manager, "POST", `/tasks/occurrences/${(await occ(other.id, day(-1))).id}/complete`); // late

    expect((await w.as(w.cashier, "GET", `/tasks/report?from=${day(-3)}&to=${day(7)}`)).status).toBe(403);
    const r = await w.as(w.manager, "GET", `/tasks/report?locationId=${w.locationId}&from=${day(-3)}&to=${day(7)}`);
    expect(r.status).toBe(200);
    expect(r.body.totals).toEqual({ due: 12, done: 3, late: 2, skipped: 1, missed: 1, completionRate: 0.25 });
    expect(r.body.byTask).toEqual([
      { taskId: other.id, title: "Count the safe", recurrence: "ONCE", due: 1, done: 1, late: 1, skipped: 0, missed: 0, completionRate: 1 },
      { taskId: t.id, title: "Open up", recurrence: "DAILY", due: 11, done: 2, late: 1, skipped: 1, missed: 1, completionRate: 0.182 },
    ]);
    expect(r.body.byEmployee).toEqual([
      { staffId: ids.cashier, name: "CASHIER", done: 2, late: 1, skipped: 0 },
      { staffId: ids.manager, name: "MANAGER", done: 1, late: 1, skipped: 1 },
    ]);
    // Just the past: nothing future counts as due.
    expect((await w.as(w.manager, "GET", `/tasks/report?from=${day(-3)}&to=${today}`)).body.totals).toMatchObject({ due: 5, done: 3, missed: 1 });
    expect((await w.as(w.manager, "GET", `/tasks/report?from=${today}&to=${day(-1)}`)).status).toBe(400);

    const csv = await w.app.inject({ method: "GET", url: `/tasks/report?from=${day(-3)}&to=${day(7)}&format=csv`, headers: { authorization: `Bearer ${w.owner}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="tasks.csv"');
    const [header, first] = csv.body.split("\n");
    expect(header).toBe("taskId,title,recurrence,due,done,late,skipped,missed,completionRate");
    expect(first).toBe(`${other.id},Count the safe,ONCE,1,1,1,0,0,1`);
  });

  it("is open to anyone with VIEW_REPORTS, even without MANAGE_TASKS", async () => {
    await w.as(w.owner, "PATCH", `/staff/${ids.cashier}`, { permissionOverrides: { VIEW_REPORTS: "ALLOW" } });
    const r = await w.as(w.cashier, "GET", `/tasks/report?from=${day(-1)}&to=${today}`);
    expect(r.status).toBe(200);
    expect(r.body.totals.due).toBe(0);
  });
});
