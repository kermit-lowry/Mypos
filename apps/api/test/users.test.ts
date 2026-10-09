import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pinLookup } from "../src/services/permissions.js";
import { key, PINS, prisma, seedCatalog, setup, USERS, type World } from "./helpers.js";

let w: World;
beforeEach(async () => {
  w = await setup();
});
afterAll(() => prisma.$disconnect());

const webLogin = (email: string, password: string) => w.app.inject({ method: "POST", url: "/auth/web-login", payload: { email, password } });
const user = (email: string) => prisma.staff.findUniqueOrThrow({ where: { kind_email: { kind: "USER", email } } });
const employee = (role: "OWNER" | "MANAGER" | "CASHIER") => prisma.staff.findFirstOrThrow({ where: { kind: "EMPLOYEE", role } });
const REGISTER_ONLY = ["DISCOUNT_LINE", "DISCOUNT_CUSTOM", "PRICE_OVERRIDE", "LINE_VOID", "CART_CLEAR", "NO_SALE", "BUYLIST_PAYOUT", "BUYLIST_CREDIT", "BUYLIST_OVERRIDE", "TENDER_STORE_CREDIT", "DRAWER_OPEN_CLOSE", "LAYAWAY_CREATE", "CASH_IN_OUT", "CASH_VARIANCE_OVERRIDE"];

describe("website sign-in", () => {
  it("signs a user in with email + password, records the time, and says who they are", async () => {
    const before = await user(USERS.OWNER.email);
    expect(before.lastLoginAt).not.toBeNull(); // setup() signed them in once already
    await prisma.staff.update({ where: { id: before.id }, data: { lastLoginAt: null } });
    const res = await webLogin(USERS.OWNER.email, USERS.OWNER.password);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ staff: { id: before.id, name: "Web OWNER", role: "OWNER", kind: "USER" }, permissions: { levels: { MANAGE_USERS: "ALLOW" }, discountMaxBps: 0 } });
    expect((await user(USERS.OWNER.email)).lastLoginAt).not.toBeNull();
    const me = await w.as(res.json().token, "GET", "/auth/me");
    expect(me.body).toMatchObject({ via: "web", staff: { kind: "USER", role: "OWNER" } });
    const log = await w.as(w.webManager, "GET", "/audit?action=LOGIN");
    expect(log.body[0]).toMatchObject({ staffId: before.id, staffName: "Web OWNER", staffKind: "USER", details: { method: "web" } });
  });

  it("tells an employee that the website isn't where they sign in", async () => {
    const cashier = await employee("CASHIER");
    const res = await webLogin(cashier.email!, "anything at all");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "BAD_LOGIN", details: { code: "EMPLOYEE_ACCOUNT" } });
    expect(res.json().message).toContain("employee account");
    expect((await webLogin("nobody@shop.test", "anything at all")).json()).toMatchObject({ error: "BAD_LOGIN", message: "Wrong email or password" });
    const log = await w.as(w.webManager, "GET", "/audit?action=LOGIN_FAILED");
    expect(log.body[1].details).toMatchObject({ method: "web", email: cashier.email, reason: "EMPLOYEE_ACCOUNT" });
  });

  it("locks out after as many wrong passwords as the register allows wrong PINs", async () => {
    const attempts = [];
    for (let i = 0; i < 6; i++) attempts.push((await webLogin(USERS.MANAGER.email, `wrong ${i}`)).statusCode);
    expect(attempts).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await webLogin(USERS.MANAGER.email, USERS.MANAGER.password)).statusCode).toBe(429);
    // Employee-account mistakes count too.
    const cashier = await employee("CASHIER");
    expect((await webLogin(cashier.email!, "x")).statusCode).toBe(429);
  });

  it("a user never signs in at the register, even if a row somehow had a PIN", async () => {
    const u = await user(USERS.MANAGER.email);
    const bcrypt = (await import("bcryptjs")).default;
    await prisma.staff.update({ where: { id: u.id }, data: { pinHash: await bcrypt.hash("8787", 4), pinLookup: pinLookup("8787") } });
    expect((await w.app.inject({ method: "POST", url: "/auth/login", payload: { pin: "8787" } })).statusCode).toBe(401);
    expect((await w.app.inject({ method: "POST", url: "/auth/login", payload: { email: u.email, pin: "8787" } })).statusCode).toBe(401);
    // Nor can they approve anything with it.
    expect((await w.as(w.cashier, "POST", "/auth/approve", { pin: "8787", permissions: ["REFUND"] })).body.error).toBe("BAD_PIN");
    // The PIN clock button doesn't know them either.
    expect((await w.app.inject({ method: "POST", url: "/time/clock", payload: { pin: "8787", locationId: w.locationId } })).statusCode).toBe(401);
  });

  it("a register token for a user row, or a web token for an employee row, is no session at all", async () => {
    const u = await user(USERS.OWNER.email);
    const e = await employee("OWNER");
    const userAtRegister = w.app.jwt.sign({ sub: u.id, role: "OWNER", via: "register", kind: "USER" });
    const employeeOnWeb = w.app.jwt.sign({ sub: e.id, role: "OWNER", via: "web", kind: "EMPLOYEE" });
    const noVia = w.app.jwt.sign({ sub: u.id, role: "OWNER", kind: "USER" });
    for (const token of [userAtRegister, employeeOnWeb, noVia]) {
      const res = await w.as(token, "GET", "/auth/me");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("UNAUTHENTICATED");
    }
    // The genuine ones still work.
    expect((await w.as(w.webOwner, "GET", "/auth/me")).status).toBe(200);
    expect((await w.as(w.owner, "GET", "/auth/me")).status).toBe(200);
  });

  it("users change their own password; employees have none to change", async () => {
    expect((await w.as(w.webManager, "POST", "/auth/password", { current: "wrong", password: "a brand new password" })).status).toBe(401);
    expect((await w.as(w.webManager, "POST", "/auth/password", { current: USERS.MANAGER.password, password: "a brand new password" })).status).toBe(200);
    expect((await webLogin(USERS.MANAGER.email, USERS.MANAGER.password)).statusCode).toBe(401);
    expect((await webLogin(USERS.MANAGER.email, "a brand new password")).statusCode).toBe(200);
    const res = await w.as(w.manager, "POST", "/auth/password", { current: PINS.MANAGER, password: "a brand new password" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("NOT_A_USER");
  });
});

describe("what a website user can do", () => {
  it("has no register-only permissions, and PIN levels read as not allowed", async () => {
    await w.as(w.owner, "PUT", "/roles/MANAGER", { permissions: { REFUND: "PIN", LAYAWAY_MANAGE: "PIN" }, discountMaxBps: 5000 });
    const me = await w.as(w.webManager, "GET", "/auth/me");
    for (const p of REGISTER_ONLY) expect(me.body.permissions.levels[p]).toBe("DENY");
    expect(me.body.permissions.levels).toMatchObject({ REFUND: "DENY", LAYAWAY_MANAGE: "DENY", VIEW_REPORTS: "ALLOW", MANAGE_CATALOG: "ALLOW", MANAGE_USERS: "DENY" });
    expect(Object.values(me.body.permissions.levels)).not.toContain("PIN");
    expect(me.body.permissions.discountMaxBps).toBe(0);
    // An owner user has everything on the website and nothing register-only.
    const owner = await w.as(w.webOwner, "GET", "/auth/me");
    expect(owner.body.permissions.levels).toMatchObject({ MANAGE_USERS: "ALLOW", MANAGE_STAFF: "ALLOW", REFUND: "ALLOW", NO_SALE: "DENY", DRAWER_OPEN_CLOSE: "DENY" });
    // And an owner employee has everything at the register and nothing website-only.
    expect((await w.as(w.owner, "GET", "/auth/me")).body.permissions.levels).toMatchObject({ MANAGE_USERS: "DENY", NO_SALE: "ALLOW", MANAGE_STAFF: "ALLOW" });
  });

  it("can't use a manager's PIN approval: there is no PIN level on the website", async () => {
    const v = await seedCatalog(w);
    const order = await w.as(w.cashier, "POST", "/orders/checkout", { locationId: w.locationId, lines: [{ variantId: v.nm, quantity: 1 }], tenders: [{ type: "CASH", amountCents: 1083 }], idempotencyKey: key() });
    expect(order.status).toBe(201);
    await w.as(w.owner, "PUT", "/roles/MANAGER", { permissions: { REFUND: "PIN" }, discountMaxBps: 5000 });
    const refund = { lines: [{ orderLineId: order.body.order.lines[0].id, quantity: 1 }] };
    // A register manager would be asked for a PIN; the website manager is simply not allowed.
    expect((await w.as(w.manager, "POST", `/orders/${order.body.order.id}/refund`, refund)).body.error).toBe("APPROVAL_REQUIRED");
    expect((await w.as(w.webManager, "POST", `/orders/${order.body.order.id}/refund`, refund)).body.error).toBe("PERMISSION_DENIED");
    // Even holding a valid approval token issued to them.
    const grant = await w.as(w.webManager, "POST", "/auth/approve", { pin: PINS.OWNER, permissions: ["REFUND"] });
    expect(grant.status).toBe(200);
    const res = await w.app.inject({ method: "POST", url: `/orders/${order.body.order.id}/refund`, payload: refund, headers: { authorization: `Bearer ${w.webManager}`, "x-approval-token": grant.body.token } });
    expect(res.json().error).toBe("PERMISSION_DENIED");
    expect(await prisma.approvalGrant.findUniqueOrThrow({ where: { id: grant.body.token } })).toMatchObject({ usedAt: null });
  });

  it("isn't an employee: no clocking in, no tasks, no drawers", async () => {
    for (const [method, url, body] of [
      ["POST", "/time/clock-in", { locationId: w.locationId }],
      ["POST", "/time/clock-out", undefined],
      ["GET", `/tasks/mine?locationId=${w.locationId}`, undefined],
      ["POST", "/drawer/open", { locationId: w.locationId, openingFloatCents: 10000 }],
    ] as const) {
      const res = await w.as(w.webOwner, method, url, body);
      expect(res.status, url).toBe(403);
      expect(res.body.error, url).toBe("NOT_AN_EMPLOYEE");
    }
    // The same calls work for the owner at the register.
    expect((await w.as(w.owner, "GET", `/tasks/mine?locationId=${w.locationId}`)).status).toBe(200);
    expect((await w.as(w.owner, "POST", "/time/clock-in", { locationId: w.locationId })).status).toBe(201);
  });

  it("doesn't ring up sales, pay out trade-ins or take preorder money: those happen at a register", async () => {
    const { nm } = await seedCatalog(w);
    for (const [url, body] of [
      ["/orders/checkout", { locationId: w.locationId, lines: [{ variantId: nm, quantity: 1 }], tenders: [{ type: "CASH", amountCents: 1083 }], idempotencyKey: key() }],
      ["/buylist/anything/accept", { payout: "CASH", locationId: w.locationId }],
      ["/preorders", { locationId: w.locationId, preorderProductId: "anything", quantity: 1, tenders: [], idempotencyKey: key() }],
      ["/preorders/anything/fulfill", { locationId: w.locationId, tenders: [], idempotencyKey: key() }],
    ] as const) {
      const res = await w.as(w.webOwner, "POST", url, body);
      expect(res.status, url).toBe(403);
      expect(res.body.error, url).toBe("NOT_AN_EMPLOYEE");
    }
    expect(await prisma.order.count()).toBe(0);
    // The owner at the register still can.
    const sale = await w.as(w.owner, "POST", "/orders/checkout", { locationId: w.locationId, lines: [{ variantId: nm, quantity: 1 }], tenders: [{ type: "CASH", amountCents: 1083 }], idempotencyKey: key() });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
  });

  it("with staff access, adds and promotes employees up to their own role, never above it", async () => {
    const webManager = await user(USERS.MANAGER.email);
    expect((await w.as(w.webOwner, "PATCH", `/users/${webManager.id}`, { permissionOverrides: { MANAGE_STAFF: "ALLOW" } })).status).toBe(200);
    const added = await w.as(w.webManager, "POST", "/staff", { name: "New cashier", pin: "9876", role: "CASHIER" });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const promoted = await w.as(w.webManager, "PATCH", `/staff/${added.body.id}`, { role: "MANAGER" });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect((await w.as(w.webManager, "POST", "/staff", { name: "New owner", pin: "8765", role: "OWNER" })).status).toBe(403);
    // A manager's discount limit is the most they can hand out.
    const over = await w.as(w.webManager, "POST", "/staff", { name: "Generous", pin: "7654", role: "CASHIER", discountMaxBps: 10_000 });
    expect(over.status).toBe(201); // managers' default limit is 100%
    // Their own website restrictions still count for the permissions both sides share.
    await w.as(w.webOwner, "PATCH", `/users/${webManager.id}`, { permissionOverrides: { MANAGE_STAFF: "ALLOW", REFUND: "DENY" } });
    const cashier = await employee("CASHIER");
    const refunds = await w.as(w.webManager, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { REFUND: "ALLOW" } });
    expect(refunds.status).toBe(403);
    expect(refunds.body.message).toContain("Refund");
  });

  it("never appears in employee lists, and can't be given a task", async () => {
    const staff = await w.as(w.webOwner, "GET", "/staff");
    expect(staff.status).toBe(200);
    expect(staff.body).toHaveLength(3);
    expect(staff.body.every((s: any) => s.kind === "EMPLOYEE" && !("hasPassword" in s))).toBe(true);
    const assignees = await w.as(w.webManager, "GET", "/tasks/assignees");
    expect(assignees.body.employees.map((e: any) => e.name).sort()).toEqual(["CASHIER", "MANAGER", "OWNER"]);
    const u = await user(USERS.MANAGER.email);
    const task = await w.as(w.webManager, "POST", "/tasks", { title: "Count the safe", recurrence: "ONCE", startsOn: "2026-10-09", assigneeType: "EMPLOYEE", assigneeId: u.id });
    expect(task.status).toBe(400);
    expect(task.body.error).toBe("ASSIGNEE");
    // A website user isn't an employee for a hand-added time entry either.
    expect((await w.as(w.webManager, "POST", "/time/entries", { staffId: u.id, locationId: w.locationId, clockIn: new Date(Date.now() - 3_600_000).toISOString(), clockOut: new Date().toISOString() })).status).toBe(404);
    // And PATCH /staff doesn't reach user rows.
    expect((await w.as(w.webOwner, "PATCH", `/staff/${u.id}`, { name: "X" })).status).toBe(404);
  });
});

describe("managing website users", () => {
  it("owners list, create and update users; managers can't", async () => {
    expect((await w.as(w.webManager, "GET", "/users")).status).toBe(403);
    expect((await w.as(w.webManager, "POST", "/users", { name: "X", email: "x@shop.test", password: "a long enough password" })).status).toBe(403);
    // Register owners don't have MANAGE_USERS at all.
    expect((await w.as(w.owner, "GET", "/users")).status).toBe(403);

    const list = await w.as(w.webOwner, "GET", "/users");
    expect(list.status).toBe(200);
    expect(list.body.map((u: any) => u.email).sort()).toEqual([USERS.MANAGER.email, USERS.OWNER.email]);
    expect(list.body[0]).toMatchObject({ role: expect.any(String), active: true, permissionOverrides: {}, lastLoginAt: expect.any(String), createdAt: expect.any(String) });
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|pinHash|pinLookup|discountMaxBps/);

    const created = await w.as(w.webOwner, "POST", "/users", { name: "Nina", email: "nina@shop.test", password: "ninas first password", permissionOverrides: { VIEW_REPORTS: "DENY" } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Nina", email: "nina@shop.test", role: "MANAGER", active: true, permissionOverrides: { VIEW_REPORTS: "DENY" }, lastLoginAt: null });
    expect((await w.as(w.webOwner, "POST", "/users", { name: "Short", email: "s@shop.test", password: "short" })).status).toBe(400);
    const login = await webLogin("nina@shop.test", "ninas first password");
    expect(login.statusCode).toBe(200);
    expect(login.json().permissions.levels.VIEW_REPORTS).toBe("DENY");

    const updated = await w.as(w.webOwner, "PATCH", `/users/${created.body.id}`, { name: "Nina R", role: "OWNER", permissionOverrides: {}, password: "ninas second password" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: "Nina R", role: "OWNER", permissionOverrides: {} });
    expect((await webLogin("nina@shop.test", "ninas first password")).statusCode).toBe(401);
    expect((await webLogin("nina@shop.test", "ninas second password")).statusCode).toBe(200);
    expect((await w.as(w.webOwner, "PATCH", "/users/nope", { name: "X" })).status).toBe(404);

    const events = await w.as(w.webOwner, "GET", "/audit?action=USER_CREATED,USER_UPDATED");
    expect(events.body.map((r: any) => r.action)).toEqual(["USER_UPDATED", "USER_CREATED"]);
    expect(events.body[1]).toMatchObject({ staffName: "Web OWNER", staffKind: "USER", details: { target: created.body.id, targetName: "Nina", role: "MANAGER", permissionOverrides: { VIEW_REPORTS: "DENY" } } });
    expect(events.body[0]).toMatchObject({ staffKind: "USER", details: { target: created.body.id, targetName: "Nina", passwordChanged: true, changes: { name: { from: "Nina", to: "Nina R" }, role: { from: "MANAGER", to: "OWNER" }, permissionOverrides: { from: { VIEW_REPORTS: "DENY" }, to: {} } } } });
    const everything = JSON.stringify([events.body, (await w.as(w.webOwner, "GET", "/audit?kind=requests")).body]);
    expect(everything).not.toContain("ninas first password");
    expect(everything).not.toContain("ninas second password");
  });

  it("ignores the retired back-office sign-in permission when a saved map is sent back", async () => {
    const cashier = await employee("CASHIER");
    await prisma.staff.update({ where: { id: cashier.id }, data: { permissionOverrides: { REFUND: "ALLOW", BACK_OFFICE_LOGIN: "ALLOW" } } });
    await prisma.rolePolicy.upsert({ where: { role: "CASHIER" }, create: { role: "CASHIER", permissions: { BACK_OFFICE_LOGIN: "ALLOW", NO_SALE: "ALLOW" }, discountMaxBps: 1000 }, update: {} });
    const roles = await w.as(w.webOwner, "GET", "/roles");
    const cashierRole = roles.body.find((r: any) => r.role === "CASHIER");
    expect(cashierRole.permissions).not.toHaveProperty("BACK_OFFICE_LOGIN");
    expect(cashierRole.permissions.NO_SALE).toBe("ALLOW");
    // Sending back what was read (old key included) is fine; the key is dropped.
    const saved = await w.as(w.webOwner, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { REFUND: "ALLOW", BACK_OFFICE_LOGIN: "ALLOW" } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.permissionOverrides).toEqual({ REFUND: "ALLOW" });
    expect((await w.as(w.webOwner, "PUT", "/roles/CASHIER", { permissions: { BACK_OFFICE_LOGIN: "ALLOW", NO_SALE: "PIN" }, discountMaxBps: 1000 })).status).toBe(200);
    expect((await prisma.rolePolicy.findUniqueOrThrow({ where: { role: "CASHIER" } })).permissions).toEqual({ NO_SALE: "PIN" });
    // A key that never existed is still a mistake.
    expect((await w.as(w.webOwner, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { MAKE_COFFEE: "ALLOW" } })).status).toBe(400);
  });

  it("shows what each user can do on the website: role defaults plus their own overrides", async () => {
    const webManager = await user(USERS.MANAGER.email);
    await w.as(w.webOwner, "PATCH", `/users/${webManager.id}`, { permissionOverrides: { VIEW_REPORTS: "DENY", MANAGE_USERS: "ALLOW" } });
    const list = await w.as(w.webOwner, "GET", "/users");
    const m = list.body.find((u: any) => u.id === webManager.id);
    expect(m.permissions).toMatchObject({ VIEW_REPORTS: "DENY", MANAGE_USERS: "ALLOW", MANAGE_CATALOG: "ALLOW", MANAGE_SETTINGS: "DENY" });
    // Only website permissions, never a PIN level, never a password hash.
    expect(Object.keys(m.permissions)).not.toContain("DISCOUNT_LINE");
    expect(Object.values(m.permissions).every((l) => l === "ALLOW" || l === "DENY")).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|pinHash/);
    const o = list.body.find((u: any) => u.role === "OWNER");
    expect(Object.values(o.permissions).every((l) => l === "ALLOW")).toBe(true);
  });

  it("only takes website permissions, and only as allowed / not allowed", async () => {
    const registerOnly = await w.as(w.webOwner, "POST", "/users", { name: "X", email: "x@shop.test", password: "a long enough password", permissionOverrides: { NO_SALE: "ALLOW" } });
    expect(registerOnly.status).toBe(400);
    expect(registerOnly.body.error).toBe("VALIDATION");
    expect(JSON.stringify(registerOnly.body.details)).toContain("NO_SALE");
    const pin = await w.as(w.webOwner, "POST", "/users", { name: "X", email: "x@shop.test", password: "a long enough password", permissionOverrides: { REFUND: "PIN" } });
    expect(pin.status).toBe(400);
    expect(JSON.stringify(pin.body.details)).toContain("PIN pad");
    const u = await user(USERS.MANAGER.email);
    expect((await w.as(w.webOwner, "PATCH", `/users/${u.id}`, { permissionOverrides: { DRAWER_OPEN_CLOSE: "DENY" } })).status).toBe(400);
    expect((await w.as(w.webOwner, "PATCH", `/users/${u.id}`, { permissionOverrides: { REFUND: "DENY", MANAGE_USERS: "ALLOW" } })).status).toBe(200);
    expect((await w.as(w.webOwner, "POST", "/users", { name: "C", email: "c@shop.test", password: "a long enough password", role: "CASHIER" })).status).toBe(400);
  });

  it("nobody changes their own standing; managers with MANAGE_USERS can't reach above themselves", async () => {
    const me = await user(USERS.OWNER.email);
    const mgr = await user(USERS.MANAGER.email);
    const other = (await w.as(w.webOwner, "POST", "/users", { name: "Second owner", email: "second@shop.test", password: "a long enough password", role: "OWNER" })).body;
    for (const body of [{ role: "MANAGER" }, { active: false }, { permissionOverrides: {} }]) {
      const res = await w.as(w.webOwner, "PATCH", `/users/${me.id}`, body);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("SELF");
    }
    // Their own name, email and password are theirs to change.
    expect((await w.as(w.webOwner, "PATCH", `/users/${me.id}`, { name: "The owner", password: "a brand new password" })).status).toBe(200);

    // The owner lets the manager run users, but they can't see reports.
    expect((await w.as(w.webOwner, "PATCH", `/users/${mgr.id}`, { permissionOverrides: { MANAGE_USERS: "ALLOW", VIEW_REPORTS: "DENY" } })).status).toBe(200);
    expect((await w.as(w.webManager, "GET", "/users")).status).toBe(200);
    expect((await w.as(w.webManager, "PATCH", `/users/${mgr.id}`, { permissionOverrides: { VIEW_REPORTS: "ALLOW" } })).body.error).toBe("SELF");
    expect((await w.as(w.webManager, "POST", "/users", { name: "O", email: "o@shop.test", password: "a long enough password", role: "OWNER" })).status).toBe(403);
    expect((await w.as(w.webManager, "PATCH", `/users/${other.id}`, { name: "Renamed" })).body.message).toContain("Only an owner");
    const above = await w.as(w.webManager, "POST", "/users", { name: "N", email: "n@shop.test", password: "a long enough password", permissionOverrides: { MANAGE_SETTINGS: "ALLOW", VIEW_REPORTS: "DENY" } });
    expect(above.status).toBe(403);
    expect(above.body.message).toContain("Store settings");
    // A new manager would see reports, which this manager can't.
    const plain = await w.as(w.webManager, "POST", "/users", { name: "N", email: "n@shop.test", password: "a long enough password" });
    expect(plain.status).toBe(403);
    expect(plain.body.message).toContain("View sales reports");
    const hire = await w.as(w.webManager, "POST", "/users", { name: "N", email: "n@shop.test", password: "a long enough password", permissionOverrides: { VIEW_REPORTS: "DENY" } });
    expect(hire.status).toBe(201);
    // Another manager's sign-in is an owner's to reset; their name isn't.
    expect((await w.as(w.webManager, "PATCH", `/users/${hire.body.id}`, { password: "a different password" })).status).toBe(403);
    expect((await w.as(w.webManager, "PATCH", `/users/${hire.body.id}`, { email: "n2@shop.test" })).status).toBe(403);
    expect((await w.as(w.webManager, "PATCH", `/users/${hire.body.id}`, { name: "Nn" })).status).toBe(200);
    expect((await w.as(w.webOwner, "PATCH", `/users/${hire.body.id}`, { password: "a different password", role: "OWNER" })).status).toBe(200);

    // Emails are unique among users; the employee with the same email is a different account.
    const dup = await w.as(w.webOwner, "POST", "/users", { name: "Dup", email: USERS.MANAGER.email, password: "a long enough password" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("EMAIL_TAKEN");
    expect((await w.as(w.webOwner, "PATCH", `/users/${other.id}`, { email: USERS.MANAGER.email })).body.error).toBe("EMAIL_TAKEN");
    expect((await w.as(w.webOwner, "POST", "/users", { name: "Cashier online", email: "cashier@shop.test", password: "a long enough password" })).status).toBe(201);
  });

  it("the last active owner can't be demoted or deactivated; deactivating ends a session at once", async () => {
    const me = await user(USERS.OWNER.email);
    for (const body of [{ role: "MANAGER" }, { active: false }]) {
      const res = await w.as(w.webOwner, "PATCH", `/users/${me.id}`, body);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("LAST_OWNER");
    }
    const other = (await w.as(w.webOwner, "POST", "/users", { name: "Other", email: "other@shop.test", password: "a long enough password", role: "OWNER" })).body;
    const asOther = (await webLogin("other@shop.test", "a long enough password")).json().token as string;
    // With two owners, one can deactivate the other, whose session ends right there.
    expect((await w.as(asOther, "PATCH", `/users/${me.id}`, { active: false })).status).toBe(200);
    expect((await w.as(w.webOwner, "GET", "/auth/me")).status).toBe(401);
    expect((await webLogin(USERS.OWNER.email, USERS.OWNER.password)).statusCode).toBe(401);
    // Now the other is the last.
    expect((await w.as(asOther, "PATCH", `/users/${other.id}`, { role: "MANAGER" })).body.error).toBe("LAST_OWNER");
    expect((await w.as(asOther, "PATCH", `/users/${me.id}`, { active: true })).status).toBe(200);
    expect((await w.as(w.webOwner, "GET", "/auth/me")).status).toBe(200);
    // Two again: stepping down is possible, but not by yourself.
    expect((await w.as(asOther, "PATCH", `/users/${other.id}`, { role: "MANAGER" })).body.error).toBe("SELF");
    expect((await w.as(w.webOwner, "PATCH", `/users/${other.id}`, { role: "MANAGER" })).status).toBe(200);
    expect((await w.as(asOther, "GET", "/users")).status).toBe(403);
    // Owner employees at the register are counted separately: the register still needs its owner too.
    const ownerEmployee = await employee("OWNER");
    expect((await w.as(w.owner, "PATCH", `/staff/${ownerEmployee.id}`, { role: "MANAGER" })).body.error).toBe("LAST_OWNER");
    const audits = await w.as(w.webOwner, "GET", "/audit?action=USER_UPDATED");
    expect(audits.body[0]).toMatchObject({ staffName: "Web OWNER", staffKind: "USER", details: { target: other.id, targetName: "Other", changes: { role: { from: "OWNER", to: "MANAGER" } }, passwordChanged: false } });
  });
});
