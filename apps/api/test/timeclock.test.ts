import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, PINS, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let ids: { cashier: string; manager: string };
beforeEach(async () => {
  w = await setup();
  const [c, m] = await Promise.all([prisma.staff.findFirstOrThrow({ where: { role: "CASHIER" } }), prisma.staff.findFirstOrThrow({ where: { role: "MANAGER" } })]);
  ids = { cashier: c.id, manager: m.id };
});
afterAll(() => prisma.$disconnect());

/** The register's clock button: no token. */
const clock = (pin: string) => w.app.inject({ method: "POST", url: "/time/clock", payload: { pin, locationId: w.locationId } });
const audits = async (action: string) => (await w.as(w.manager, "GET", `/audit?action=${action}`)).body as any[];
const sale = (lines: object[], tenders: object[]) => w.as(w.cashier, "POST", "/orders/checkout", { locationId: w.locationId, lines, tenders, idempotencyKey: key() });

const HOUR = 3_600_000;
/** A closed entry on a fixed day, written straight to the table (no clock drift in the arithmetic). */
const seedEntry = (staffId: string, day: Date, inHour: number, outHour: number | null, breakMinutes = 0, extra: object = {}) =>
  prisma.timeEntry.create({
    data: {
      staffId,
      locationId: w.locationId,
      clockIn: new Date(day.getTime() + inHour * HOUR),
      clockOut: outHour === null ? null : new Date(day.getTime() + outHour * HOUR),
      breakMinutes,
      ...extra,
    },
  });
/** Midnight UTC two days ago: comfortably in the past, and the whole shift lands in one range. */
const DAY = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 2 * 86_400_000);
const around = (d: Date) => `from=${new Date(d.getTime() - 86_400_000).toISOString()}&to=${new Date(d.getTime() + 2 * 86_400_000).toISOString()}`;

describe("clocking in by PIN at the register", () => {
  it("toggles in, then out, with no token and an audit trail", async () => {
    const first = await clock(PINS.CASHIER);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ action: "in", staff: { id: ids.cashier, name: "CASHIER" }, entry: { staffId: ids.cashier, locationId: w.locationId, clockOut: null, source: "register", long: false }, minutes: 0 });

    const second = await clock(PINS.CASHIER);
    expect(second.statusCode).toBe(200);
    const out = second.json();
    expect(out.action).toBe("out");
    expect(out.entry.id).toBe(first.json().entry.id);
    expect(out.entry.clockOut).not.toBeNull();
    expect(out.minutes).toBeGreaterThanOrEqual(0);

    const [ins, outs] = await Promise.all([audits("TIME_CLOCK_IN"), audits("TIME_CLOCK_OUT")]);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ staffId: ids.cashier, locationId: w.locationId, details: { entryId: out.entry.id, locationId: w.locationId } });
    expect(outs[0]).toMatchObject({ staffId: ids.cashier, details: { entryId: out.entry.id, minutes: expect.any(Number) } });

    // A third press opens a fresh entry rather than touching the closed one.
    expect((await clock(PINS.CASHIER)).json()).toMatchObject({ action: "in" });
    expect(await prisma.timeEntry.count({ where: { staffId: ids.cashier } })).toBe(2);
  });

  it("rejects a wrong PIN with 401 and logs TIME_CLOCK_FAILED", async () => {
    const res = await clock("9999");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("BAD_PIN");
    const failed = await audits("TIME_CLOCK_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ staffId: null, locationId: w.locationId, details: { reason: "BAD_PIN" } });
    expect(await prisma.timeEntry.count()).toBe(0);

    // An inactive employee's PIN no longer clocks in either.
    await prisma.staff.update({ where: { id: ids.cashier }, data: { active: false } });
    expect((await clock(PINS.CASHIER)).statusCode).toBe(401);

    // Five wrong PINs from one address lock the clock for a while.
    for (let i = 0; i < 4; i++) await clock("9999");
    const locked = await clock("9999");
    expect(locked.statusCode).toBe(429);
    expect((await audits("TIME_CLOCK_FAILED")).map((r) => r.details.reason)).toContain("LOCKED_OUT");
  });

  it("clocks in at the location given and 404s an unknown one", async () => {
    const res = await w.app.inject({ method: "POST", url: "/time/clock", payload: { pin: PINS.CASHIER, locationId: "nope" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("the signed-in employee", () => {
  it("clocks in and out, sees status, and can't double up", async () => {
    expect((await w.as(w.cashier, "GET", "/time/status")).body).toEqual({ entry: null, today: { minutes: 0, hours: 0 } });

    const inRes = await w.as(w.cashier, "POST", "/time/clock-in", { locationId: w.locationId });
    expect(inRes.status).toBe(201);
    expect(inRes.body.entry).toMatchObject({ staffId: ids.cashier, source: "register", clockOut: null });
    expect((await w.as(w.cashier, "POST", "/time/clock-in", { locationId: w.locationId })).body.error).toBe("ALREADY_CLOCKED_IN");

    const status = await w.as(w.cashier, "GET", "/time/status");
    expect(status.body.entry.id).toBe(inRes.body.entry.id);
    expect(status.body.today.minutes).toBeGreaterThanOrEqual(0);

    const onClock = await w.as(w.manager, "GET", `/time/clocked-in?locationId=${w.locationId}`);
    expect(onClock.body).toHaveLength(1);
    expect(onClock.body[0]).toMatchObject({ staffId: ids.cashier, name: "CASHIER", entryId: inRes.body.entry.id, long: false });
    expect(typeof onClock.body[0].since).toBe("string");

    const outRes = await w.as(w.cashier, "POST", "/time/clock-out");
    expect(outRes.status).toBe(200);
    expect(outRes.body.entry.clockOut).not.toBeNull();
    expect((await w.as(w.cashier, "POST", "/time/clock-out")).body.error).toBe("NOT_CLOCKED_IN");
    expect((await w.as(w.manager, "GET", "/time/clocked-in")).body).toEqual([]);
  });

  it("records source \"web\" for a back-office session", async () => {
    const manager = await prisma.staff.findUniqueOrThrow({ where: { id: ids.manager } });
    await w.as(w.owner, "PATCH", `/staff/${manager.id}`, { password: "a back office password" });
    const login = await w.app.inject({ method: "POST", url: "/auth/web-login", payload: { email: manager.email, password: "a back office password" } });
    const web = login.json().token as string;
    const res = await w.as(web, "POST", "/time/clock-in", { locationId: w.locationId });
    expect(res.body.entry.source).toBe("web");
  });

  it("needs a session for everything but the PIN clock", async () => {
    expect((await w.app.inject({ method: "GET", url: "/time/status" })).statusCode).toBe(401);
    expect((await w.app.inject({ method: "POST", url: "/time/clock-in", payload: { locationId: w.locationId } })).statusCode).toBe(401);
  });
});

describe("time entries", () => {
  it("lets a cashier see only their own, and a manager see everyone's", async () => {
    await seedEntry(ids.cashier, DAY, 9, 17, 30);
    await seedEntry(ids.manager, DAY, 8, 12);

    const own = await w.as(w.cashier, "GET", "/time/entries");
    expect(own.status).toBe(200);
    expect(own.body).toHaveLength(1);
    expect(own.body[0]).toMatchObject({ staffId: ids.cashier, staff: { id: ids.cashier, name: "CASHIER" }, location: { name: "Main St" }, minutes: 450, breakMinutes: 30, long: false });

    expect((await w.as(w.cashier, "GET", `/time/entries?staffId=${ids.cashier}`)).body).toHaveLength(1);
    const theirs = await w.as(w.cashier, "GET", `/time/entries?staffId=${ids.manager}`);
    expect(theirs.status).toBe(403);
    expect(theirs.body.error).toBe("PERMISSION_DENIED");

    const all = await w.as(w.manager, "GET", "/time/entries");
    expect(all.body.map((e: any) => e.staff.name).sort()).toEqual(["CASHIER", "MANAGER"]);
    expect((await w.as(w.manager, "GET", `/time/entries?staffId=${ids.cashier}`)).body).toHaveLength(1);
    expect((await w.as(w.manager, "GET", `/time/entries?${around(DAY)}`)).body).toHaveLength(2);
    expect((await w.as(w.manager, "GET", `/time/entries?from=${new Date(DAY.getTime() + 10 * HOUR).toISOString()}`)).body).toHaveLength(0);
    expect((await w.as(w.manager, "GET", "/time/entries?open=true")).body).toHaveLength(0);
  });

  it("flags an open entry that has run past 16 hours", async () => {
    const started = new Date(Date.now() - 17 * HOUR);
    await prisma.timeEntry.create({ data: { staffId: ids.cashier, locationId: w.locationId, clockIn: started } });
    const open = await w.as(w.manager, "GET", "/time/entries?open=true");
    expect(open.body).toHaveLength(1);
    expect(open.body[0].long).toBe(true);
    expect(open.body[0].minutes).toBeGreaterThanOrEqual(17 * 60);
    expect((await w.as(w.manager, "GET", "/time/clocked-in")).body[0].long).toBe(true);
    const sheet = await w.as(w.manager, "GET", `/reports/timesheets?from=${new Date(Date.now() - 2 * 86_400_000).toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`);
    expect(sheet.body.staff[0]).toMatchObject({ staffId: ids.cashier, openNow: true, long: true });
  });

  it("are edited only with MANAGE_TIMESHEETS, validated, and logged", async () => {
    const e = await seedEntry(ids.cashier, DAY, 9, null);

    const denied = await w.as(w.cashier, "PATCH", `/time/entries/${e.id}`, { clockOut: new Date(DAY.getTime() + 17 * HOUR).toISOString() });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("PERMISSION_DENIED");

    const bad = await w.as(w.manager, "PATCH", `/time/entries/${e.id}`, { clockOut: new Date(DAY.getTime() + 8 * HOUR).toISOString() });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("CLOCK_OUT_BEFORE_IN");
    expect((await w.as(w.manager, "PATCH", `/time/entries/${e.id}`, { clockOut: new Date(DAY.getTime() + 10 * HOUR).toISOString(), breakMinutes: 90 })).body.error).toBe("BREAK_TOO_LONG");

    const clockOut = new Date(DAY.getTime() + 17.5 * HOUR);
    const ok = await w.as(w.manager, "PATCH", `/time/entries/${e.id}`, { clockOut: clockOut.toISOString(), breakMinutes: 30, note: "forgot to clock out" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ clockOut: clockOut.toISOString(), breakMinutes: 30, note: "forgot to clock out", source: "edited", editedById: ids.manager, minutes: 480, long: false });
    expect(ok.body.editedAt).not.toBeNull();

    const edited = await audits("TIME_ENTRY_EDITED");
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ staffId: ids.manager, details: { entryId: e.id, staffId: ids.cashier, changes: { clockOut: { from: null, to: clockOut.toISOString() }, breakMinutes: { from: 0, to: 30 } } } });

    // A no-op edit changes nothing and logs nothing.
    await w.as(w.manager, "PATCH", `/time/entries/${e.id}`, { breakMinutes: 30 });
    expect(await audits("TIME_ENTRY_EDITED")).toHaveLength(1);

    expect((await w.as(w.manager, "PATCH", "/time/entries/missing", { breakMinutes: 1 })).status).toBe(404);
  });

  it("are added by hand and deleted by a manager", async () => {
    const clockIn = new Date(DAY.getTime() + 9 * HOUR);
    const clockOut = new Date(DAY.getTime() + 13 * HOUR);
    expect((await w.as(w.cashier, "POST", "/time/entries", { staffId: ids.cashier, locationId: w.locationId, clockIn, clockOut })).status).toBe(403);

    const made = await w.as(w.manager, "POST", "/time/entries", { staffId: ids.cashier, locationId: w.locationId, clockIn: clockIn.toISOString(), clockOut: clockOut.toISOString(), breakMinutes: 15, note: "inventory day" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ staffId: ids.cashier, source: "edited", editedById: ids.manager, minutes: 225, staff: { name: "CASHIER" } });
    expect((await audits("TIME_ENTRY_CREATED"))[0]).toMatchObject({ staffId: ids.manager, details: { entryId: made.body.id, staffId: ids.cashier } });

    expect((await w.as(w.manager, "POST", "/time/entries", { staffId: ids.cashier, locationId: w.locationId, clockIn: clockOut, clockOut: clockIn })).body.error).toBe("CLOCK_OUT_BEFORE_IN");
    expect((await w.as(w.manager, "POST", "/time/entries", { staffId: "nobody", locationId: w.locationId, clockIn })).status).toBe(404);
    // Open entries can be added, but not a second one for the same person.
    expect((await w.as(w.manager, "POST", "/time/entries", { staffId: ids.cashier, locationId: w.locationId, clockIn: new Date(Date.now() - HOUR).toISOString() })).status).toBe(201);
    expect((await w.as(w.manager, "POST", "/time/entries", { staffId: ids.cashier, locationId: w.locationId, clockIn: new Date(Date.now() - HOUR).toISOString() })).body.error).toBe("ALREADY_CLOCKED_IN");

    expect((await w.as(w.cashier, "DELETE", `/time/entries/${made.body.id}`)).status).toBe(403);
    const gone = await w.as(w.manager, "DELETE", `/time/entries/${made.body.id}`);
    expect(gone.body).toEqual({ deleted: true, id: made.body.id });
    expect(await prisma.timeEntry.findUnique({ where: { id: made.body.id } })).toBeNull();
    expect((await audits("TIME_ENTRY_DELETED"))[0]).toMatchObject({ staffId: ids.manager, details: { entryId: made.body.id, staffId: ids.cashier, minutes: 225 } });
    expect((await w.as(w.manager, "DELETE", `/time/entries/${made.body.id}`)).status).toBe(404);
  });
});

describe("reports", () => {
  it("timesheets add up per employee, with entry detail on request", async () => {
    await seedEntry(ids.cashier, DAY, 9, 17, 30); // 7.5 h
    await seedEntry(ids.cashier, DAY, 19, 23); // 4 h
    await seedEntry(ids.manager, DAY, 8, 12, 0, { source: "edited", editedById: ids.manager, note: "opened" }); // 4 h
    await seedEntry(ids.manager, new Date(DAY.getTime() - 10 * 86_400_000), 8, 12); // outside the range

    expect((await w.as(w.cashier, "GET", `/reports/timesheets?${around(DAY)}`)).status).toBe(403);

    const summary = await w.as(w.manager, "GET", `/reports/timesheets?${around(DAY)}`);
    expect(summary.status).toBe(200);
    expect(summary.body.entries).toBeUndefined();
    expect(summary.body.staff).toEqual([
      { staffId: ids.cashier, name: "CASHIER", entries: 2, minutes: 690, hours: 11.5, openNow: false, long: false },
      { staffId: ids.manager, name: "MANAGER", entries: 1, minutes: 240, hours: 4, openNow: false, long: false },
    ]);

    const detail = await w.as(w.manager, "GET", `/reports/timesheets?${around(DAY)}&detail=true`);
    expect(detail.body.entries).toHaveLength(3);
    const managerRow = detail.body.entries.find((r: any) => r.staffId === ids.manager);
    expect(managerRow).toMatchObject({ name: "MANAGER", break: 0, minutes: 240, note: "opened", edited: true, open: false, long: false });
    expect(managerRow.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(managerRow.in).toMatch(/^\d{2}:\d{2}$/);
    expect(managerRow.out).toMatch(/^\d{2}:\d{2}$/);

    const one = await w.as(w.manager, "GET", `/reports/timesheets?${around(DAY)}&staffId=${ids.cashier}`);
    expect(one.body.staff).toHaveLength(1);
    expect(one.body.entries.map((r: any) => r.minutes)).toEqual([450, 240]);

    expect((await w.as(w.manager, "GET", `/reports/timesheets?from=${DAY.toISOString()}&to=${DAY.toISOString()}`)).status).toBe(400);
  });

  it("employee shifts count the sales rung up while on the clock", async () => {
    const v = await seedCatalog(w);
    // Sold before clocking in: not part of any shift.
    expect((await sale([{ variantId: v.lp, quantity: 1 }], [{ type: "CASH", amountCents: 920 }])).status).toBe(201);
    await new Promise((r) => setTimeout(r, 10));

    expect((await clock(PINS.CASHIER)).json().action).toBe("in");
    const rung = await sale([{ variantId: v.nm, quantity: 2 }], [{ type: "CASH", amountCents: 2165 }]);
    expect(rung.status).toBe(201);

    const now = new Date();
    const report = await w.as(w.manager, "GET", `/reports/employee-shifts?${around(now)}`);
    expect(report.status).toBe(200);
    expect(report.body).toHaveLength(1);
    expect(report.body[0]).toMatchObject({ staffId: ids.cashier, name: "CASHIER", location: "Main St", out: null, open: true, orders: 1, units: 2, netCents: 2000, long: false });

    // Clocking out closes the window; a later sale isn't counted.
    expect((await clock(PINS.CASHIER)).json().action).toBe("out");
    await new Promise((r) => setTimeout(r, 10));
    await sale([{ variantId: v.lp, quantity: 1 }], [{ type: "CASH", amountCents: 920 }]);
    const after = await w.as(w.manager, "GET", `/reports/employee-shifts?${around(now)}&locationId=${w.locationId}`);
    expect(after.body[0]).toMatchObject({ orders: 1, units: 2, netCents: 2000, open: false });
    expect(after.body[0].out).toMatch(/^\d{2}:\d{2}$/);
  });

  it("download as CSV", async () => {
    await seedEntry(ids.cashier, DAY, 9, 17, 30);
    const csv = await w.app.inject({ method: "GET", url: `/reports/timesheets?${around(DAY)}&format=csv`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="timesheets.csv"');
    const [header, row] = csv.body.split("\n");
    expect(header).toBe("staffId,name,entries,minutes,hours,openNow,long");
    expect(row).toBe(`${ids.cashier},CASHIER,1,450,7.5,false,false`);

    const detail = await w.app.inject({ method: "GET", url: `/reports/timesheets?${around(DAY)}&format=csv&detail=true`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(detail.body.split("\n")[0]).toContain("date,in,out");

    const shifts = await w.app.inject({ method: "GET", url: `/reports/employee-shifts?${around(DAY)}&format=csv`, headers: { authorization: `Bearer ${w.manager}` } });
    expect(shifts.headers["content-disposition"]).toBe('attachment; filename="employee-shifts.csv"');
    expect(shifts.body.split("\n")[0]).toContain("orders,units,netCents");
  });
});
