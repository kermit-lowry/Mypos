import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { key, PINS, prisma, seedCatalog, setup, type World } from "./helpers.js";

let w: World;
let v: Awaited<ReturnType<typeof seedCatalog>>;

beforeEach(async () => {
  w = await setup();
  v = await seedCatalog(w);
});
afterAll(() => prisma.$disconnect());

const withApproval = (token: string, method: "POST" | "PATCH", url: string, body: object, as = w.cashier) =>
  w.app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${as}`, "x-approval-token": token } });
const approve = (pin: string, permissions: string[], extra: object = {}, as = w.cashier) =>
  w.as(as, "POST", "/auth/approve", { pin, permissions, ...extra });
const sale = (lines: object[], tenders: object[]) => ({ locationId: w.locationId, lines, tenders, idempotencyKey: key() });

describe("sign-in", () => {
  it("works with a PIN alone and returns the employee's permissions", async () => {
    const res = await w.app.inject({ method: "POST", url: "/auth/login", payload: { pin: PINS.CASHIER } });
    expect(res.json()).toMatchObject({ staff: { role: "CASHIER" }, permissions: { levels: { REFUND: "PIN", MANAGE_STAFF: "DENY" }, discountMaxBps: 1000 } });
  });

  it("locks out after repeated wrong PINs", async () => {
    for (let i = 0; i < 5; i++) await w.app.inject({ method: "POST", url: "/auth/login", payload: { pin: "9999" } });
    const res = await w.app.inject({ method: "POST", url: "/auth/login", payload: { pin: PINS.CASHIER } });
    expect(res.statusCode).toBe(429);
  });

  it("deactivated employees are signed out immediately", async () => {
    const cashier = await prisma.staff.findFirstOrThrow({ where: { role: "CASHIER" } });
    await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { active: false });
    expect((await w.as(w.cashier, "GET", "/auth/me")).status).toBe(401);
  });
});

describe("manager PIN approvals", () => {
  it("a refund needs a manager's PIN, which works once", async () => {
    const order = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ variantId: v.nm, quantity: 2 }], [{ type: "CASH", amountCents: 2165 }]));
    const refund = { lines: [{ orderLineId: order.body.order.lines[0].id, quantity: 1 }] };
    const denied = await w.as(w.cashier, "POST", `/orders/${order.body.order.id}/refund`, refund);
    expect(denied.body).toMatchObject({ error: "APPROVAL_REQUIRED", details: { permission: "REFUND" } });

    const grant = await approve(PINS.MANAGER, ["REFUND"]);
    expect(grant.body.approver.name).toBe("MANAGER");
    const ok = await withApproval(grant.body.token, "POST", `/orders/${order.body.order.id}/refund`, refund);
    expect(ok.statusCode).toBe(200);
    const again = await withApproval(grant.body.token, "POST", `/orders/${order.body.order.id}/refund`, refund);
    expect(again.json().error).toBe("APPROVAL_REQUIRED");

    const log = await w.as(w.manager, "GET", "/audit?action=REFUND");
    expect(log.body[0]).toMatchObject({ staffName: "CASHIER", approverName: "MANAGER", details: { amountCents: 1083 } });
  });

  it("the approver must be allowed to do it themselves", async () => {
    const res = await approve(PINS.CASHIER, ["REFUND"]);
    expect(res.body.error).toBe("APPROVER_NOT_ALLOWED");
    expect((await approve("0000", ["REFUND"])).body.error).toBe("BAD_PIN");
  });

  it("failed approvals are logged, without the PIN", async () => {
    expect((await approve("0000", ["REFUND"])).body.error).toBe("BAD_PIN");
    expect((await approve(PINS.CASHIER, ["REFUND"], { locationId: w.locationId })).body.error).toBe("APPROVER_NOT_ALLOWED");
    await w.as(w.owner, "PUT", "/roles/MANAGER", { permissions: {}, discountMaxBps: 2000 });
    expect((await approve(PINS.MANAGER, ["DISCOUNT_LINE"], { discountBps: 3000 })).body.error).toBe("APPROVER_LIMIT");
    const log = await w.as(w.manager, "GET", "/audit?action=APPROVAL_FAILED");
    expect(log.body.map((r: any) => r.details.reason)).toEqual(["APPROVER_LIMIT", "APPROVER_NOT_ALLOWED", "BAD_PIN"]);
    expect(log.body[0]).toMatchObject({ staffName: "CASHIER", approverName: "MANAGER", details: { permissions: ["DISCOUNT_LINE"], discountBps: 3000, approverMaxBps: 2000 } });
    expect(log.body[1]).toMatchObject({ staffName: "CASHIER", approverName: "CASHIER", locationId: w.locationId, details: { missing: ["REFUND"] } });
    expect(log.body[2]).toMatchObject({ staffName: "CASHIER", approverName: null, details: { permissions: ["REFUND"], discountBps: null } });
    expect(log.body.every((r: any) => r.ip)).toBe(true);
    const text = JSON.stringify(log.body.map((r: any) => r.details));
    for (const pin of ["0000", PINS.CASHIER, PINS.MANAGER, PINS.OWNER]) expect(text).not.toContain(pin);
  });

  it("a locked-out approver is logged too", async () => {
    for (let i = 0; i < 5; i++) await approve("0000", ["REFUND"]);
    expect((await approve(PINS.MANAGER, ["REFUND"])).status).toBe(429);
    const log = await w.as(w.manager, "GET", "/audit?action=APPROVAL_FAILED");
    expect(log.body[0].details).toMatchObject({ reason: "LOCKED_OUT", permissions: ["REFUND"] });
    expect(JSON.stringify(log.body)).not.toContain(PINS.MANAGER);
  });

  it("an approval only works for the employee who asked", async () => {
    const grant = await approve(PINS.OWNER, ["NO_SALE"], {}, w.cashier);
    const t = await prisma.terminal.create({ data: { locationId: w.locationId, name: "T", gatewayRef: "1", receiptPrinterHost: "127.0.0.1:1" } });
    const other = await prisma.staff.create({ data: { name: "Other", email: "o@shop.test", role: "CASHIER", pinHash: "x" } });
    const otherToken = w.app.jwt.sign({ sub: other.id, role: "CASHIER", kind: "EMPLOYEE" });
    const res = await withApproval(grant.body.token, "POST", `/terminals/${t.id}/drawer`, {}, otherToken);
    expect(res.json().error).toBe("APPROVAL_REQUIRED");
  });
});

describe("discount limits", () => {
  it("cashiers discount up to their limit; more needs an approver whose limit covers it", async () => {
    // 10% of $10 is fine for a cashier
    const within = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ variantId: v.nm, quantity: 1, discountCents: 100 }], [{ type: "CASH", amountCents: 974 }]));
    expect(within.status).toBe(201);

    const body = sale([{ variantId: v.nm, quantity: 1, discountCents: 300 }], [{ type: "CASH", amountCents: 758 }]);
    const over = await w.as(w.cashier, "POST", "/orders/checkout", body);
    expect(over.body).toMatchObject({ error: "APPROVAL_REQUIRED", details: { permission: "DISCOUNT_LINE", discountBps: 3000 } });

    const grant = await approve(PINS.MANAGER, ["DISCOUNT_LINE"], { discountBps: 3000 });
    const ok = await withApproval(grant.body.token, "POST", "/orders/checkout", body);
    expect(ok.statusCode).toBe(201);
    const events = await w.as(w.manager, "GET", "/audit?action=DISCOUNT");
    expect(events.body[0]).toMatchObject({ staffName: "CASHIER", approverName: "MANAGER", details: { amountCents: 300 } });
  });

  it("an approver can't approve past their own limit", async () => {
    await w.as(w.owner, "PUT", "/roles/MANAGER", { permissions: {}, discountMaxBps: 2000 });
    const res = await approve(PINS.MANAGER, ["DISCOUNT_LINE"], { discountBps: 3000 });
    expect(res.body.error).toBe("APPROVER_LIMIT");
  });

  it("a discount approval covers the amount it was asked for, not the approver's whole limit", async () => {
    const grant = await approve(PINS.MANAGER, ["DISCOUNT_LINE"], { discountBps: 1500 });
    expect(grant.status).toBe(200);
    const body = sale([{ variantId: v.nm, quantity: 1, discountCents: 300 }], [{ type: "CASH", amountCents: 758 }]);
    const res = await withApproval(grant.body.token, "POST", "/orders/checkout", body);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "APPROVAL_REQUIRED", details: { permission: "DISCOUNT_LINE", discountBps: 3000 } });
    // 15% is fine with it.
    const ok = await withApproval(grant.body.token, "POST", "/orders/checkout", sale([{ variantId: v.nm, quantity: 1, discountCents: 150 }], [{ type: "CASH", amountCents: 920 }]));
    expect(ok.statusCode).toBe(201);
  });

  it("a discount approval has to say how much", async () => {
    const res = await approve(PINS.MANAGER, ["DISCOUNT_LINE"]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("DISCOUNT_BPS_REQUIRED");
    expect((await approve(PINS.MANAGER, ["DISCOUNT_LINE"], { discountBps: 0 })).status).toBe(200);
  });

  it("price overrides need approval for cashiers and are logged", async () => {
    const body = sale([{ variantId: v.nm, quantity: 1, unitPriceCents: 800 }], [{ type: "CASH", amountCents: 866 }]);
    expect((await w.as(w.cashier, "POST", "/orders/checkout", body)).body.error).toBe("APPROVAL_REQUIRED");
    const grant = await approve(PINS.MANAGER, ["PRICE_OVERRIDE"]);
    expect((await withApproval(grant.body.token, "POST", "/orders/checkout", body)).statusCode).toBe(201);
    const log = await w.as(w.manager, "GET", "/audit?action=PRICE_OVERRIDE");
    expect(log.body[0].details).toMatchObject({ fromCents: 1000, toCents: 800 });
  });
});

describe("role and employee settings", () => {
  it("owners can change what a role may do", async () => {
    await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { CART_CLEAR: "PIN", REFUND: "DENY" }, discountMaxBps: 500 });
    const me = await w.as(w.cashier, "GET", "/auth/me");
    expect(me.body.permissions).toMatchObject({ levels: { CART_CLEAR: "PIN", REFUND: "DENY" }, discountMaxBps: 500 });
    expect((await w.as(w.manager, "PUT", "/roles/CASHIER", { permissions: {}, discountMaxBps: 500 })).status).toBe(403);
  });

  it("per-employee overrides beat the role", async () => {
    const cashier = await prisma.staff.findFirstOrThrow({ where: { role: "CASHIER" } });
    await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { REFUND: "ALLOW" }, discountMaxBps: 2500 });
    expect((await w.as(w.cashier, "GET", "/auth/me")).body.permissions).toMatchObject({ levels: { REFUND: "ALLOW" }, discountMaxBps: 2500 });
  });

  it("PINs are unique, and the last owner can't be removed", async () => {
    const dup = await w.as(w.owner, "POST", "/staff", { name: "New", email: "new@shop.test", pin: PINS.MANAGER });
    expect(dup.body.error).toBe("PIN_TAKEN");
    // An email is optional for an employee (PIN-only sign-in); two employees can't share one.
    expect((await w.as(w.owner, "POST", "/staff", { name: "No email", pin: "5556" })).status).toBe(201);
    expect((await w.as(w.owner, "POST", "/staff", { name: "No email 2", pin: "5557" })).status).toBe(201);
    expect((await w.as(w.owner, "POST", "/staff", { name: "Dup", email: "cashier@shop.test", pin: "5558" })).body.error).toBe("EMAIL_TAKEN");
    const owner = await prisma.staff.findFirstOrThrow({ where: { role: "OWNER" } });
    expect((await w.as(w.owner, "PATCH", `/staff/${owner.id}`, { role: "MANAGER" })).body.error).toBe("LAST_OWNER");
    const listed = await w.as(w.owner, "GET", "/staff");
    expect(JSON.stringify(listed.body)).not.toContain("pinHash");
  });

  it("page and sign-in permissions can't be set to PIN", async () => {
    const res = await w.as(w.owner, "PUT", "/roles/MANAGER", { permissions: { VIEW_REPORTS: "PIN" }, discountMaxBps: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("VALIDATION");
    expect(JSON.stringify(res.body.details)).toContain("VIEW_REPORTS");
    const cashier = await prisma.staff.findFirstOrThrow({ where: { role: "CASHIER" } });
    expect((await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { MANAGE_STAFF: "PIN" } })).status).toBe(400);
    expect((await w.as(w.owner, "POST", "/staff", { name: "New", email: "new@shop.test", pin: "5555", permissionOverrides: { MANAGE_DEALS: "PIN" } })).status).toBe(400);
    // Website-only permissions mean nothing to an employee.
    const webOnly = await w.as(w.owner, "POST", "/staff", { name: "New", email: "new@shop.test", pin: "5555", permissionOverrides: { MANAGE_USERS: "ALLOW" } });
    expect(webOnly.status).toBe(400);
    expect(JSON.stringify(webOnly.body.details)).toContain("MANAGE_USERS");
    expect((await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { REFUND: "PIN", VIEW_REPORTS: "ALLOW" } })).status).toBe(200);
  });

  it("role changes are logged with the policy before and after", async () => {
    await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { REFUND: "DENY" }, discountMaxBps: 500 });
    await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { REFUND: "PIN" }, discountMaxBps: 800 });
    const log = await w.as(w.manager, "GET", "/audit?action=ROLE_UPDATED");
    expect(log.body[1].details).toEqual({ role: "CASHIER", before: null, after: { permissions: { REFUND: "DENY" }, discountMaxBps: 500 } });
    expect(log.body[0].details).toEqual({ role: "CASHIER", before: { permissions: { REFUND: "DENY" }, discountMaxBps: 500 }, after: { permissions: { REFUND: "PIN" }, discountMaxBps: 800 } });
  });

  describe("a manager with staff rights", () => {
    let manager: { id: string };
    let cashier: { id: string };
    let other: { id: string };
    beforeEach(async () => {
      manager = await prisma.staff.findFirstOrThrow({ where: { role: "MANAGER" } });
      cashier = await prisma.staff.findFirstOrThrow({ where: { role: "CASHIER" } });
      // The owner lets the manager run staff, but they can't refund and are capped at 10%.
      await w.as(w.owner, "PATCH", `/staff/${manager.id}`, { permissionOverrides: { MANAGE_STAFF: "ALLOW", REFUND: "DENY" }, discountMaxBps: 1000 });
      other = (await w.as(w.owner, "POST", "/staff", { name: "Other manager", email: "other@shop.test", pin: "7777", role: "MANAGER" })).body;
    });

    it("can't grant permissions they don't have, however it's phrased", async () => {
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { MANAGE_SETTINGS: "ALLOW" } })).status).toBe(403);
      // Their own REFUND is DENY: no ALLOW, and no relaxing an owner's DENY to PIN either.
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { REFUND: "ALLOW" } })).status).toBe(403);
      await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { REFUND: "DENY" }, discountMaxBps: 1000 });
      const relax = await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { REFUND: "PIN" } });
      expect(relax.status).toBe(403);
      expect(relax.body.message).toContain("Refund sales");
      // Dropping an owner-set DENY override is a grant too.
      await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { PRICE_OVERRIDE: "DENY" } });
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: {} })).status).toBe(200); // PRICE_OVERRIDE back to PIN: the manager has ALLOW
      await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { CONSIGNOR_SETTLE: "DENY" } });
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: {} })).status).toBe(200); // DENY by default anyway
      await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { CONSIGNOR_SETTLE: "ALLOW" }, discountMaxBps: 1000 });
      await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { CONSIGNOR_SETTLE: "DENY" } });
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: {} })).status).toBe(403);
      // Promoting to manager would hand over REFUND and a bigger discount limit.
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { role: "MANAGER" })).status).toBe(403);
      expect((await w.as(w.manager, "POST", "/staff", { name: "M", email: "m@shop.test", pin: "8888", role: "MANAGER" })).status).toBe(403);
      // What they do have, they can give (once the owner undoes the CONSIGNOR_SETTLE experiment above).
      await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: {}, discountMaxBps: 1000 });
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { PRICE_OVERRIDE: "ALLOW", NO_SALE: "ALLOW" } })).status).toBe(200);
      // A new cashier would be able to refund with a PIN, which this manager can't do at all.
      const hire = await w.as(w.manager, "POST", "/staff", { name: "C", email: "c@shop.test", pin: "8888", permissionOverrides: { NO_SALE: "ALLOW" } });
      expect(hire.status).toBe(403);
      expect(hire.body.message).toContain("Refund sales");
      expect((await w.as(w.manager, "POST", "/staff", { name: "C", email: "c@shop.test", pin: "8888", permissionOverrides: { NO_SALE: "ALLOW", REFUND: "DENY" } })).status).toBe(201);
    });

    it("can't set a discount limit above their own", async () => {
      const res = await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { discountMaxBps: 5000 });
      expect(res.status).toBe(403);
      expect(res.body.message).toContain("10%");
      expect((await w.as(w.manager, "POST", "/staff", { name: "C", email: "c@shop.test", pin: "8888", discountMaxBps: 1500 })).status).toBe(403);
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { discountMaxBps: 800 })).status).toBe(200);
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { discountMaxBps: 1000 })).status).toBe(200);
      // Lowering a limit the owner set higher is fine.
      await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { discountMaxBps: 5000 });
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { discountMaxBps: 2000 })).status).toBe(200);
    });

    it("can't change their own role, permissions, or limit", async () => {
      expect((await w.as(w.manager, "PATCH", `/staff/${manager.id}`, { permissionOverrides: { MANAGE_STAFF: "ALLOW" } })).status).toBe(403);
      expect((await w.as(w.manager, "PATCH", `/staff/${manager.id}`, { discountMaxBps: 500 })).status).toBe(403);
      expect((await w.as(w.manager, "PATCH", `/staff/${manager.id}`, { role: "CASHIER" })).status).toBe(403);
      expect((await w.as(w.manager, "PATCH", `/staff/${manager.id}`, { active: true })).status).toBe(403);
      expect((await w.as(w.manager, "GET", "/auth/me")).body.permissions.levels.REFUND).toBe("DENY");
      // Their own name and PIN are theirs to change. There is no password: employees don't sign in to the website.
      expect((await w.as(w.manager, "PATCH", `/staff/${manager.id}`, { name: "Mo", pin: "9876" })).status).toBe(200);
      await w.as(w.manager, "PATCH", `/staff/${manager.id}`, { password: "a password for mo" });
      expect((await prisma.staff.findUniqueOrThrow({ where: { id: manager.id } })).passwordHash).toBeNull();
    });

    it("can reset a cashier's PIN but not another manager's", async () => {
      expect((await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { pin: "9876" })).status).toBe(200);
      const res = await w.as(w.manager, "PATCH", `/staff/${other.id}`, { pin: "9875" });
      expect(res.status).toBe(403);
      expect(res.body.message).toContain("Only an owner");
      expect((await w.as(w.manager, "PATCH", `/staff/${other.id}`, { email: "o2@shop.test" })).status).toBe(403);
      expect((await w.as(w.manager, "PATCH", `/staff/${other.id}`, { name: "Renamed" })).status).toBe(200);
    });

    it("owners can do all of it", async () => {
      expect((await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { discountMaxBps: 5000 })).status).toBe(200);
      expect((await w.as(w.owner, "PATCH", `/staff/${manager.id}`, { permissionOverrides: { MANAGE_STAFF: "ALLOW", REFUND: "PIN" } })).status).toBe(200);
      expect((await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { permissionOverrides: { REFUND: "PIN" } })).status).toBe(200);
      expect((await w.as(w.owner, "PATCH", `/staff/${other.id}`, { pin: "9876" })).status).toBe(200);
      expect((await w.as(w.owner, "PATCH", `/staff/${cashier.id}`, { role: "MANAGER" })).status).toBe(200);
    });

    it("logs what changed about whom, never the PIN", async () => {
      await w.as(w.manager, "PATCH", `/staff/${cashier.id}`, { discountMaxBps: 800, pin: "9876", name: "CASHIER" });
      const log = await w.as(w.manager, "GET", "/audit?action=STAFF_UPDATED");
      expect(log.body[0]).toMatchObject({
        staffName: "MANAGER",
        details: { target: cashier.id, targetName: "CASHIER", changes: { discountMaxBps: { from: null, to: 800 } }, pinChanged: true },
      });
      expect(log.body[0].details.changes).not.toHaveProperty("name");
      expect(JSON.stringify(log.body)).not.toContain("9876");
      // The owner's earlier change to the manager, with the overrides before and after.
      const mine = log.body.find((r: any) => r.details.target === manager.id);
      expect(mine.details.changes).toEqual({ permissionOverrides: { from: {}, to: { MANAGE_STAFF: "ALLOW", REFUND: "DENY" } }, discountMaxBps: { from: null, to: 1000 } });
    });
  });
});

describe("activity log", () => {
  it("records every write, with secrets redacted", async () => {
    await w.as(w.owner, "POST", "/staff", { name: "Sam", email: "sam@shop.test", pin: "4444" });
    const rows = await w.as(w.manager, "GET", "/audit?kind=requests");
    const create = rows.body.find((r: any) => r.details.route === "POST /staff");
    expect(create).toMatchObject({ staffName: "OWNER", status: 201, details: { body: { name: "Sam", pin: "[redacted]" } } });
    expect(JSON.stringify(rows.body)).not.toContain("4444");
  });

  it("records denied attempts too", async () => {
    await w.as(w.cashier, "POST", "/inventory/adjust", { variantId: v.nm, locationId: w.locationId, delta: 5, reason: "RECEIVE" });
    const rows = await w.as(w.manager, "GET", "/audit?kind=requests");
    expect(rows.body.find((r: any) => r.details.route === "POST /inventory/adjust" && r.staffName === "CASHIER")?.status).toBe(403);
  });

  it("logs cart clears and voids, which can require a PIN", async () => {
    const items = [{ variantId: v.nm, title: "Charizard ex", quantity: 2, priceCents: 1000 }];
    expect((await w.as(w.cashier, "POST", "/audit/cart", { action: "CART_CLEAR", locationId: w.locationId, items })).status).toBe(200);
    await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { LINE_VOID: "PIN" }, discountMaxBps: 1000 });
    expect((await w.as(w.cashier, "POST", "/audit/cart", { action: "LINE_VOID", items })).body.error).toBe("APPROVAL_REQUIRED");
    const grant = await approve(PINS.MANAGER, ["LINE_VOID"]);
    expect((await withApproval(grant.body.token, "POST", "/audit/cart", { action: "LINE_VOID", items })).statusCode).toBe(200);
    const log = await w.as(w.manager, "GET", "/audit");
    expect(log.body.map((r: any) => r.action)).toEqual(expect.arrayContaining(["CART_CLEAR", "LINE_VOID", "APPROVAL", "LOGIN"]));
    expect(log.body.find((r: any) => r.action === "CART_CLEAR").details.valueCents).toBe(2000);
  });

  it("logs price changes made in the back office", async () => {
    await w.as(w.manager, "PATCH", `/catalog/variants/${v.nm}`, { priceCents: 1299 });
    const log = await w.as(w.manager, "GET", "/audit?action=PRICE_CHANGE");
    expect(log.body[0]).toMatchObject({ staffName: "MANAGER", details: { fromCents: 1000, toCents: 1299 } });
  });

  it("filters by several events at once", async () => {
    await w.app.inject({ method: "POST", url: "/auth/login", payload: { pin: "9999" } });
    const log = await w.as(w.manager, "GET", "/audit?action=LOGIN,LOGIN_FAILED");
    const kinds = new Set(log.body.map((r: any) => r.action));
    expect(kinds).toEqual(new Set(["LOGIN", "LOGIN_FAILED"]));
    expect((await w.as(w.manager, "GET", "/audit?action=LOGIN_FAILED")).body.every((r: any) => r.action === "LOGIN_FAILED")).toBe(true);
  });

  it("cashiers can't read the log", async () => {
    expect((await w.as(w.cashier, "GET", "/audit")).status).toBe(403);
  });
});

describe("discount reasons and buttons", () => {
  it("once reasons exist, manual discounts need one (and a note when required)", async () => {
    const damaged = await w.as(w.manager, "POST", "/discount-reasons", { name: "Damaged" });
    const match = await w.as(w.manager, "POST", "/discount-reasons", { name: "Price match", requiresNote: true });
    const line = { variantId: v.nm, quantity: 1, discountCents: 100 };
    const tender = [{ type: "CASH", amountCents: 974 }];
    expect((await w.as(w.cashier, "POST", "/orders/checkout", sale([line], tender))).body.error).toBe("DISCOUNT_REASON");
    expect((await w.as(w.cashier, "POST", "/orders/checkout", sale([{ ...line, discountReasonId: match.body.id }], tender))).body.error).toBe("DISCOUNT_NOTE");
    const ok = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ ...line, discountReasonId: damaged.body.id }], tender));
    expect(ok.body.order.lines[0]).toMatchObject({ discountReason: "Damaged" });
    const log = await w.as(w.manager, "GET", "/audit?action=DISCOUNT");
    expect(log.body[0].details.reason).toBe("Damaged");
  });

  it("turned-off reasons can't be used", async () => {
    const r = await w.as(w.manager, "POST", "/discount-reasons", { name: "Old" });
    await w.as(w.manager, "POST", "/discount-reasons", { name: "Current" });
    await w.as(w.manager, "PATCH", `/discount-reasons/${r.body.id}`, { active: false });
    const res = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ variantId: v.nm, quantity: 1, discountCents: 100, discountReasonId: r.body.id }], [{ type: "CASH", amountCents: 974 }]));
    expect(res.body.error).toBe("DISCOUNT_REASON");
  });

  it("managers set up discount buttons; cashiers can list them", async () => {
    const reason = await w.as(w.manager, "POST", "/discount-reasons", { name: "Employee" });
    expect((await w.as(w.cashier, "POST", "/discount-presets", { label: "10%", kind: "PERCENT", value: 1000 })).status).toBe(403);
    await w.as(w.manager, "POST", "/discount-presets", { label: "Employee 20%", kind: "PERCENT", value: 2000, reasonId: reason.body.id, sortOrder: 1 });
    await w.as(w.manager, "POST", "/discount-presets", { label: "$5 off", kind: "AMOUNT", value: 500 });
    expect((await w.as(w.manager, "POST", "/discount-presets", { label: "Bad", kind: "PERCENT", value: 20_000 })).status).toBe(400);
    const list = await w.as(w.cashier, "GET", "/discount-presets");
    expect(list.body.map((p: any) => p.label)).toEqual(["$5 off", "Employee 20%"]);
  });
});

describe("custom discount amounts", () => {
  it("employees without custom discounts can only use discount buttons, up to what the button gives", async () => {
    await w.as(w.owner, "PUT", "/roles/CASHIER", { permissions: { DISCOUNT_CUSTOM: "DENY" }, discountMaxBps: 2000 });
    const tenOff = await w.as(w.manager, "POST", "/discount-presets", { label: "10%", kind: "PERCENT", value: 1000 });
    const line = { variantId: v.nm, quantity: 1 };
    // Typed-in amount: refused.
    const custom = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ ...line, discountCents: 100 }], [{ type: "CASH", amountCents: 974 }]));
    expect(custom.body).toMatchObject({ error: "PERMISSION_DENIED", details: { permission: "DISCOUNT_CUSTOM" } });
    // More than the button gives: still custom.
    const tooMuch = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ ...line, discountCents: 150, discountPresetId: tenOff.body.id }], [{ type: "CASH", amountCents: 920 }]));
    expect(tooMuch.body.error).toBe("PERMISSION_DENIED");
    // The button's discount: fine.
    const ok = await w.as(w.cashier, "POST", "/orders/checkout", sale([{ ...line, discountCents: 100, discountPresetId: tenOff.body.id }], [{ type: "CASH", amountCents: 974 }]));
    expect(ok.status).toBe(201);
  });
});
