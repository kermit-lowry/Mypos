import { DEFAULT_DISCOUNT_LIMIT_BPS, DEFAULT_ROLE_PERMISSIONS, effectivePermissions, PermissionKeys, PERMISSIONS, type Permission } from "@mypos/shared";
import type { Prisma, Staff } from "@prisma/client";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, conflict, forbidden, notFound } from "../errors.js";
import { authorize, parse, requirePermission, requireStaff, type SessionVia } from "../http.js";
import type { Ctx } from "../services/context.js";
import {
  approve,
  audit,
  checkAttempts,
  clearFailures,
  employeeByPin,
  hashPin,
  permissionsFor,
  pinLookup,
  recordFailure,
  rolePolicy,
} from "../services/permissions.js";
import { NOTHING, Overrides, overridesFor, RANK, type OverrideMap } from "./overrides.js";

/** Employees as the API shows them: never the PIN hash or lookup. */
const publicStaff = (s: Staff) => ({
  id: s.id,
  kind: s.kind,
  name: s.name,
  email: s.email,
  role: s.role,
  active: s.active,
  permissionOverrides: s.permissionOverrides,
  discountMaxBps: s.discountMaxBps,
  hasPin: !!s.pinLookup,
  createdAt: s.createdAt,
});

/** For the activity log: a stored value as JSON (undefined → null). */
const json = (v: unknown) => (v === undefined ? null : (v as Prisma.InputJsonValue));

/**
 * Sign-in and employees. Register employees (kind EMPLOYEE) sign in here with
 * a PIN; back-office website users (kind USER) with email + password. The two
 * are separate rows, and a session only ever works for its own kind. Website
 * users are managed in routes/users.ts.
 */
export function staffRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const manageStaff = { preHandler: requirePermission("MANAGE_STAFF") };
  const ip = (req: FastifyRequest) => req.ip;
  const EmployeeOverrides = overridesFor("EMPLOYEE");

  async function session(staff: Staff, via: SessionVia) {
    const token = app.jwt.sign({ sub: staff.id, role: staff.role, via, kind: staff.kind }, { expiresIn: "12h" });
    return { token, staff: { id: staff.id, name: staff.name, role: staff.role, kind: staff.kind }, permissions: await permissionsFor(prisma, staff) };
  }

  /** Sign in at the register with PIN alone (the usual way), or email + PIN. Employees only: website users have no PIN. */
  app.post("/auth/login", async (req) => {
    const { email, pin } = parse(z.object({ email: z.string().email().optional(), pin: z.string().min(4).max(8) }), req.body);
    const key = `login:${ip(req)}`;
    const method = email ? "email+pin" : "pin";
    try {
      checkAttempts(key);
    } catch (e) {
      await audit(prisma, { action: "LOGIN_FAILED", ip: ip(req), details: { method, email: email ?? null, reason: "LOCKED_OUT" } });
      throw e;
    }
    let staff: Staff | null;
    if (email) {
      staff = await prisma.staff.findUnique({ where: { kind_email: { kind: "EMPLOYEE", email } } });
      if (staff && !(staff.pinHash && (await bcrypt.compare(pin, staff.pinHash)))) staff = null;
      // Accounts made before PIN-only sign-in get their lookup on first login, if the PIN is unique.
      if (staff && !staff.pinLookup) {
        const lookup = pinLookup(pin);
        if (!(await prisma.staff.findUnique({ where: { pinLookup: lookup } }))) staff = await prisma.staff.update({ where: { id: staff.id }, data: { pinLookup: lookup } });
      }
    } else {
      staff = await employeeByPin(prisma, pin);
    }
    if (!staff || !staff.active) {
      recordFailure(key);
      await audit(prisma, { action: "LOGIN_FAILED", ip: ip(req), details: { email: email ?? null, method } });
      throw new AppError(401, "BAD_LOGIN", email ? "Wrong email or PIN" : "That PIN isn't recognized");
    }
    clearFailures(key);
    await audit(prisma, { action: "LOGIN", staffId: staff.id, ip: ip(req), details: { method } });
    return session(staff, "register");
  });

  /**
   * Back-office website sign-in: email + password, website users only. An
   * employee's email gets a 401 that says so (EMPLOYEE_ACCOUNT), counted
   * toward the lockout like any other failure.
   */
  app.post("/auth/web-login", async (req) => {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
    const key = `web-login:${ip(req)}`;
    try {
      checkAttempts(key);
    } catch (e) {
      await audit(prisma, { action: "LOGIN_FAILED", ip: ip(req), details: { method: "web", email, reason: "LOCKED_OUT" } });
      throw e;
    }
    const user = await prisma.staff.findUnique({ where: { kind_email: { kind: "USER", email } } });
    const ok = user?.active && user.passwordHash && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) {
      recordFailure(key);
      const employee = !user && (await prisma.staff.findUnique({ where: { kind_email: { kind: "EMPLOYEE", email } } }));
      await audit(prisma, { action: "LOGIN_FAILED", ip: ip(req), details: { email, method: "web", ...(employee ? { reason: "EMPLOYEE_ACCOUNT" } : {}) } });
      if (employee) {
        throw new AppError(401, "BAD_LOGIN", "That's an employee account. Employees sign in at the register with their PIN; ask an owner for a website user account.", { code: "EMPLOYEE_ACCOUNT" });
      }
      throw new AppError(401, "BAD_LOGIN", "Wrong email or password");
    }
    clearFailures(key);
    const signedIn = await prisma.staff.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit(prisma, { action: "LOGIN", staffId: user.id, ip: ip(req), details: { method: "web" } });
    return session(signedIn, "web");
  });

  /** A website user changes their own password, confirming with the current one. Employees have no password (403 NOT_A_USER). */
  app.post("/auth/password", { preHandler: requireStaff() }, async (req) => {
    const { current, password } = parse(z.object({ current: z.string().min(1), password: z.string().min(10).max(200) }), req.body);
    const me = await prisma.staff.findUniqueOrThrow({ where: { id: req.user.sub } });
    if (me.kind !== "USER" || !me.passwordHash) throw new AppError(403, "NOT_A_USER", "Employees have no website password; they sign in at the register with a PIN");
    if (!(await bcrypt.compare(current, me.passwordHash))) throw new AppError(401, "BAD_LOGIN", "Current password is wrong");
    await prisma.staff.update({ where: { id: me.id }, data: { passwordHash: await bcrypt.hash(password, 10) } });
    await audit(prisma, { action: "PASSWORD_CHANGED", staffId: me.id, ip: ip(req) });
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: requireStaff() }, async (req) => {
    const staff = await prisma.staff.findUniqueOrThrow({ where: { id: req.user.sub } });
    return { staff: { id: staff.id, name: staff.name, role: staff.role, kind: staff.kind }, permissions: req.perms, via: req.user.via ?? "register" };
  });

  /** A manager approves an action for the signed-in employee by entering their PIN. */
  app.post("/auth/approve", { preHandler: requireStaff() }, async (req) => {
    const input = parse(
      z.object({
        pin: z.string().min(4).max(8),
        permissions: z.array(z.enum(PermissionKeys as [Permission, ...Permission[]])).min(1).max(5),
        discountBps: z.number().int().min(0).max(10_000).optional(),
        reason: z.string().max(200).optional(),
        locationId: z.string().optional(),
      }),
      req.body,
    );
    return approve(prisma, { ...input, requesterId: req.user.sub, ip: ip(req) }, `approve:${ip(req)}`);
  });

  // ── Employees ──────────────────────────────────────────────

  interface StaffInput {
    role?: Staff["role"];
    active?: boolean;
    discountMaxBps?: number | null;
    permissionOverrides?: OverrideMap;
    pin?: string;
    email?: string | null;
  }

  /**
   * Non-owners can't manage owners, change their own standing, reset another
   * manager's credentials, or leave anyone able to do more than they can.
   * Compared on what the employee could actually do before and after, so
   * dropping an owner's DENY override or relaxing DENY to PIN counts as a
   * grant too, and the way the change is phrased doesn't matter.
   */
  /** A website user's role as it would apply to a register employee, for the grant guard. */
  async function registerEquivalent(userId: string) {
    const me = await prisma.staff.findUniqueOrThrow({ where: { id: userId } });
    return effectivePermissions(me.role, await rolePolicy(prisma, me.role), { overrides: me.permissionOverrides as OverrideMap, kind: "EMPLOYEE" });
  }

  async function guardGrant(req: FastifyRequest, input: StaffInput, existing?: Staff) {
    if (req.staffRole === "OWNER") return;
    if (input.role === "OWNER" || existing?.role === "OWNER") throw forbidden("Only an owner can manage owners");
    const self = !!existing && existing.id === req.user.sub;
    if (self && (input.role !== undefined || input.active !== undefined || input.permissionOverrides !== undefined || input.discountMaxBps !== undefined)) {
      throw forbidden("Ask an owner to change your own role, permissions, or discount limit");
    }
    if (!self && existing?.role === "MANAGER" && (input.pin !== undefined || input.email !== undefined)) {
      throw forbidden("Only an owner can reset another manager's PIN or email");
    }
    // A website user with staff access is measured by what their role can do at the
    // register (their website permissions say nothing about discounts, voids or the
    // drawer), with their own overrides on the permissions both sides share.
    const mine = req.staffKind === "USER" ? await registerEquivalent(req.user.sub) : req.perms!;
    const before = existing ? await permissionsFor(prisma, existing) : NOTHING;
    const role = input.role ?? existing?.role ?? "CASHIER";
    const after = effectivePermissions(role, await rolePolicy(prisma, role), {
      overrides: input.permissionOverrides ?? (existing?.permissionOverrides as OverrideMap | undefined),
      discountMaxBps: input.discountMaxBps === undefined ? existing?.discountMaxBps : input.discountMaxBps,
    });
    for (const p of PermissionKeys) {
      if (RANK[after.levels[p]] > RANK[before.levels[p]] && RANK[mine.levels[p]] < RANK[after.levels[p]]) throw forbidden(`You can't grant "${PERMISSIONS[p].label}"`);
    }
    if (after.discountMaxBps > before.discountMaxBps && after.discountMaxBps > mine.discountMaxBps) {
      throw forbidden(`You can't set a discount limit above your own (${mine.discountMaxBps / 100}%)`);
    }
  }

  /** The store needs an active owner at the register; website owners are counted separately (routes/users.ts). */
  async function assertOwnerRemains(changing: Staff, next: { role?: Staff["role"]; active?: boolean }) {
    const losesOwner = changing.role === "OWNER" && ((next.role && next.role !== "OWNER") || next.active === false);
    if (!losesOwner) return;
    const owners = await prisma.staff.count({ where: { kind: "EMPLOYEE", role: "OWNER", active: true, id: { not: changing.id } } });
    if (owners === 0) throw conflict("LAST_OWNER", "The store needs at least one active owner");
  }

  /** An employee's email is for email + PIN sign-in; several employees can't share one. */
  async function assertEmailFree(email: string | null | undefined, exceptId?: string) {
    if (!email) return;
    const taken = await prisma.staff.findUnique({ where: { kind_email: { kind: "EMPLOYEE", email } } });
    if (taken && taken.id !== exceptId) throw conflict("EMAIL_TAKEN", "Another employee already uses that email");
  }

  /** Register employees only; website users are listed by GET /users. */
  app.get("/staff", manageStaff, async () => (await prisma.staff.findMany({ where: { kind: "EMPLOYEE" }, orderBy: [{ active: "desc" }, { name: "asc" }] })).map(publicStaff));

  app.post("/staff", manageStaff, async (req, reply) => {
    const input = parse(
      z.object({
        name: z.string().min(1).max(80),
        /** Optional: lets the employee sign in with email + PIN as well as PIN alone. */
        email: z.string().email().nullable().optional(),
        pin: z.string(),
        role: z.enum(["OWNER", "MANAGER", "CASHIER"]).default("CASHIER"),
        discountMaxBps: z.number().int().min(0).max(10_000).nullable().optional(),
        permissionOverrides: EmployeeOverrides.default({}),
      }),
      req.body,
    );
    await guardGrant(req, input);
    await assertEmailFree(input.email);
    const { pin, ...rest } = input;
    const staff = await prisma.staff.create({ data: { ...rest, kind: "EMPLOYEE", ...(await hashPin(prisma, pin)) } });
    await audit(prisma, {
      action: "STAFF_CREATED",
      staffId: req.user.sub,
      details: { target: staff.id, targetName: staff.name, role: staff.role, discountMaxBps: staff.discountMaxBps, permissionOverrides: rest.permissionOverrides },
    });
    return reply.code(201).send(publicStaff(staff));
  });

  app.patch("/staff/:id", manageStaff, async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        name: z.string().min(1).max(80).optional(),
        email: z.string().email().nullable().optional(),
        pin: z.string().optional(),
        role: z.enum(["OWNER", "MANAGER", "CASHIER"]).optional(),
        active: z.boolean().optional(),
        discountMaxBps: z.number().int().min(0).max(10_000).nullable().optional(),
        permissionOverrides: EmployeeOverrides.optional(),
      }),
      req.body,
    );
    const existing = await prisma.staff.findUnique({ where: { id, kind: "EMPLOYEE" } });
    if (!existing) throw notFound("Employee");
    await guardGrant(req, input, existing);
    await assertOwnerRemains(existing, input);
    await assertEmailFree(input.email, id);
    const { pin, ...rest } = input;
    const staff = await prisma.staff.update({ where: { id }, data: { ...rest, ...(pin ? await hashPin(prisma, pin, id) : {}) } });
    const changes: Record<string, Prisma.InputJsonValue> = {};
    for (const k of ["name", "email", "role", "active", "discountMaxBps", "permissionOverrides"] as const) {
      if (rest[k] !== undefined && JSON.stringify(existing[k]) !== JSON.stringify(staff[k])) changes[k] = { from: json(existing[k]), to: json(staff[k]) };
    }
    await audit(prisma, {
      action: "STAFF_UPDATED",
      staffId: req.user.sub,
      details: { target: id, targetName: existing.name, changes, pinChanged: !!pin },
    });
    return publicStaff(staff);
  });

  // ── Role permissions ───────────────────────────────────────

  app.get("/roles", manageStaff, async () =>
    Promise.all(
      (["CASHIER", "MANAGER"] as const).map(async (role) => {
        const policy = await rolePolicy(prisma, role);
        return {
          role,
          // Only permissions that still exist (a saved policy can hold retired keys).
          permissions: { ...DEFAULT_ROLE_PERMISSIONS[role], ...Object.fromEntries(Object.entries(policy?.permissions ?? {}).filter(([k]) => k in PERMISSIONS)) },
          discountMaxBps: policy?.discountMaxBps ?? DEFAULT_DISCOUNT_LIMIT_BPS[role],
          defaults: { permissions: DEFAULT_ROLE_PERMISSIONS[role], discountMaxBps: DEFAULT_DISCOUNT_LIMIT_BPS[role] },
        };
      }),
    ),
  );

  /** Owners change what managers and cashiers can do. */
  app.put("/roles/:role", manageStaff, async (req) => {
    const role = parse(z.enum(["CASHIER", "MANAGER"]), (req.params as { role: string }).role);
    const input = parse(z.object({ permissions: Overrides, discountMaxBps: z.number().int().min(0).max(10_000) }), req.body);
    if (req.staffRole !== "OWNER") throw forbidden("Only an owner can change role permissions");
    const before = await rolePolicy(prisma, role);
    const saved = await prisma.rolePolicy.upsert({
      where: { role },
      create: { role, permissions: input.permissions, discountMaxBps: input.discountMaxBps },
      update: { permissions: input.permissions, discountMaxBps: input.discountMaxBps },
    });
    await audit(prisma, { action: "ROLE_UPDATED", staffId: req.user.sub, details: { role, before: before ? { ...before } : null, after: input } });
    return saved;
  });

  // ── Register audit trail ───────────────────────────────────

  /**
   * The register asks before deleting a cart or removing items, so the action
   * is checked against the employee's permissions (and approval) and logged.
   */
  app.post("/audit/cart", { preHandler: requireStaff() }, async (req) => {
    const input = parse(
      z.object({
        action: z.enum(["CART_CLEAR", "LINE_VOID"]),
        locationId: z.string().optional(),
        items: z.array(z.object({ variantId: z.string(), title: z.string().max(200), quantity: z.number().int(), priceCents: z.number().int() })).max(500),
      }),
      req.body,
    );
    await authorize(req, input.action, `register ${input.action}`);
    await audit(prisma, {
      action: input.action,
      staffId: req.user.sub,
      approverId: req.approverId,
      locationId: input.locationId,
      details: { items: input.items, valueCents: input.items.reduce((a, i) => a + i.priceCents * i.quantity, 0) },
    });
    return { ok: true };
  });

  /**
   * Activity log: filter by event (one, or several comma-separated), employee
   * or user, location, and date range; newest first. Each row names who did
   * it (`staffName`, `staffKind` EMPLOYEE | USER so the log can label website
   * users) and who approved it.
   */
  app.get("/audit", { preHandler: requirePermission("VIEW_REPORTS") }, async (req) => {
    const q = parse(
      z.object({
        action: z.string().optional(),
        /** "events" hides the raw request entries and shows named events only. */
        kind: z.enum(["all", "events", "requests"]).default("events"),
        staffId: z.string().optional(),
        locationId: z.string().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        /** Paging: events older than this timestamp. */
        before: z.coerce.date().optional(),
        take: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const actions = q.action?.split(",").map((a) => a.trim()).filter(Boolean) ?? [];
    const rows = await prisma.auditEvent.findMany({
      where: {
        ...(actions.length ? { action: { in: actions } } : q.kind === "events" ? { action: { not: "REQUEST" } } : q.kind === "requests" ? { action: "REQUEST" } : {}),
        staffId: q.staffId,
        locationId: q.locationId,
        createdAt: { gte: q.from, lte: q.to, ...(q.before ? { lt: q.before } : {}) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.take,
    });
    const ids = [...new Set(rows.flatMap((r) => [r.staffId, r.approverId]).filter((x): x is string => !!x))];
    const who = new Map((await prisma.staff.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, kind: true } })).map((s) => [s.id, s]));
    return rows.map((r) => ({
      ...r,
      staffName: r.staffId ? (who.get(r.staffId)?.name ?? null) : null,
      staffKind: r.staffId ? (who.get(r.staffId)?.kind ?? null) : null,
      approverName: r.approverId ? (who.get(r.approverId)?.name ?? null) : null,
    }));
  });
}
