import { PermissionKeys, PermissionLevels, PERMISSIONS, DEFAULT_DISCOUNT_LIMIT_BPS, DEFAULT_ROLE_PERMISSIONS, type Permission } from "@mypos/shared";
import type { Staff } from "@prisma/client";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, conflict, forbidden, notFound } from "../errors.js";
import { authorize, parse, requirePermission, requireStaff } from "../http.js";
import type { Ctx } from "../services/context.js";
import {
  approve,
  audit,
  checkAttempts,
  clearFailures,
  hashPin,
  permissionsFor,
  pinLookup,
  recordFailure,
  rolePolicy,
} from "../services/permissions.js";

const Level = z.enum(PermissionLevels);
const Overrides = z.record(z.enum(PermissionKeys as [Permission, ...Permission[]]), Level);

/** Staff as the API shows them: never the PIN hash or lookup. */
const publicStaff = (s: Staff) => ({
  id: s.id,
  name: s.name,
  email: s.email,
  role: s.role,
  active: s.active,
  permissionOverrides: s.permissionOverrides,
  discountMaxBps: s.discountMaxBps,
  hasPin: !!s.pinLookup,
  hasPassword: !!s.passwordHash,
  createdAt: s.createdAt,
});

export function staffRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const manageStaff = { preHandler: requirePermission("MANAGE_STAFF") };
  const ip = (req: FastifyRequest) => req.ip;

  async function session(staff: Staff) {
    const token = app.jwt.sign({ sub: staff.id, role: staff.role }, { expiresIn: "12h" });
    return { token, staff: { id: staff.id, name: staff.name, role: staff.role }, permissions: await permissionsFor(prisma, staff) };
  }

  /** Sign in with PIN alone (the usual way at a register), or email + PIN. */
  app.post("/auth/login", async (req) => {
    const { email, pin } = parse(z.object({ email: z.string().email().optional(), pin: z.string().min(4).max(8) }), req.body);
    const key = `login:${ip(req)}`;
    checkAttempts(key);
    let staff: Staff | null;
    if (email) {
      staff = await prisma.staff.findUnique({ where: { email } });
      if (staff && !(await bcrypt.compare(pin, staff.pinHash))) staff = null;
      // Accounts made before PIN-only sign-in get their lookup on first login, if the PIN is unique.
      if (staff && !staff.pinLookup) {
        const lookup = pinLookup(pin);
        if (!(await prisma.staff.findUnique({ where: { pinLookup: lookup } }))) staff = await prisma.staff.update({ where: { id: staff.id }, data: { pinLookup: lookup } });
      }
    } else {
      staff = await prisma.staff.findUnique({ where: { pinLookup: pinLookup(pin) } });
    }
    if (!staff || !staff.active) {
      recordFailure(key);
      await audit(prisma, { action: "LOGIN_FAILED", ip: ip(req), details: { email: email ?? null, method: email ? "email+pin" : "pin" } });
      throw new AppError(401, "BAD_LOGIN", email ? "Wrong email or PIN" : "That PIN isn't recognized");
    }
    clearFailures(key);
    await audit(prisma, { action: "LOGIN", staffId: staff.id, ip: ip(req), details: { method: email ? "email+pin" : "pin" } });
    return session(staff);
  });

  /**
   * Back-office website sign-in: email + password (PINs are for the register).
   * Needs the BACK_OFFICE_LOGIN permission.
   */
  app.post("/auth/web-login", async (req) => {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
    const key = `web-login:${ip(req)}`;
    checkAttempts(key);
    const staff = await prisma.staff.findUnique({ where: { email } });
    const ok = staff?.active && staff.passwordHash && (await bcrypt.compare(password, staff.passwordHash));
    if (!ok) {
      recordFailure(key);
      await audit(prisma, { action: "LOGIN_FAILED", ip: ip(req), details: { email, method: "web" } });
      throw new AppError(401, "BAD_LOGIN", staff && !staff.passwordHash ? "No website password set for this account yet; an owner can set one" : "Wrong email or password");
    }
    const perms = await permissionsFor(prisma, staff!);
    if (perms.levels.BACK_OFFICE_LOGIN === "DENY") {
      await audit(prisma, { action: "LOGIN_FAILED", staffId: staff!.id, ip: ip(req), details: { method: "web", reason: "no back-office access" } });
      throw forbidden("This account can't use the back office");
    }
    clearFailures(key);
    await audit(prisma, { action: "LOGIN", staffId: staff!.id, ip: ip(req), details: { method: "web" } });
    return session(staff!);
  });

  /** Change your own website password (confirm with the current password, or your PIN if none is set). */
  app.post("/auth/password", { preHandler: requireStaff() }, async (req) => {
    const { current, password } = parse(z.object({ current: z.string().min(1), password: z.string().min(10).max(200) }), req.body);
    const me = await prisma.staff.findUniqueOrThrow({ where: { id: req.user.sub } });
    const ok = me.passwordHash ? await bcrypt.compare(current, me.passwordHash) : await bcrypt.compare(current, me.pinHash);
    if (!ok) throw new AppError(401, "BAD_LOGIN", me.passwordHash ? "Current password is wrong" : "PIN is wrong");
    await prisma.staff.update({ where: { id: me.id }, data: { passwordHash: await bcrypt.hash(password, 10) } });
    await audit(prisma, { action: "PASSWORD_CHANGED", staffId: me.id, ip: ip(req) });
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: requireStaff() }, async (req) => {
    const staff = await prisma.staff.findUniqueOrThrow({ where: { id: req.user.sub } });
    return { staff: { id: staff.id, name: staff.name, role: staff.role }, permissions: req.perms };
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
    return approve(prisma, { ...input, requesterId: req.user.sub }, `approve:${ip(req)}`);
  });

  // ── Employees ──────────────────────────────────────────────

  /** Non-owners can't create or edit owners, or hand out permissions they don't have. */
  function guardGrant(req: FastifyRequest, target: { role?: Staff["role"]; overrides?: Partial<Record<Permission, string>> }, existing?: Staff) {
    if (req.staffRole === "OWNER") return;
    if (target.role === "OWNER" || existing?.role === "OWNER") throw forbidden("Only an owner can manage owners");
    const mine = req.perms!.levels;
    for (const [perm, level] of Object.entries(target.overrides ?? {})) {
      if (level === "ALLOW" && mine[perm as Permission] !== "ALLOW") throw forbidden(`You can't grant "${PERMISSIONS[perm as Permission].label}"`);
    }
  }

  async function assertOwnerRemains(changing: Staff, next: { role?: Staff["role"]; active?: boolean }) {
    const losesOwner = changing.role === "OWNER" && ((next.role && next.role !== "OWNER") || next.active === false);
    if (!losesOwner) return;
    const owners = await prisma.staff.count({ where: { role: "OWNER", active: true, id: { not: changing.id } } });
    if (owners === 0) throw conflict("LAST_OWNER", "The store needs at least one active owner");
  }

  app.get("/staff", manageStaff, async () => (await prisma.staff.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] })).map(publicStaff));

  app.post("/staff", manageStaff, async (req, reply) => {
    const input = parse(
      z.object({
        name: z.string().min(1).max(80),
        email: z.string().email(),
        pin: z.string(),
        role: z.enum(["OWNER", "MANAGER", "CASHIER"]).default("CASHIER"),
        discountMaxBps: z.number().int().min(0).max(10_000).nullable().optional(),
        permissionOverrides: Overrides.default({}),
      }),
      req.body,
    );
    guardGrant(req, { role: input.role, overrides: input.permissionOverrides });
    const { pin, ...rest } = input;
    const staff = await prisma.staff.create({ data: { ...rest, ...(await hashPin(prisma, pin)) } });
    await audit(prisma, { action: "STAFF_CREATED", staffId: req.user.sub, details: { target: staff.id, role: staff.role } });
    return reply.code(201).send(publicStaff(staff));
  });

  app.patch("/staff/:id", manageStaff, async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        name: z.string().min(1).max(80).optional(),
        email: z.string().email().optional(),
        pin: z.string().optional(),
        /** Website password (owners set it for staff; staff can change their own). */
        password: z.string().min(10).max(200).optional(),
        role: z.enum(["OWNER", "MANAGER", "CASHIER"]).optional(),
        active: z.boolean().optional(),
        discountMaxBps: z.number().int().min(0).max(10_000).nullable().optional(),
        permissionOverrides: Overrides.optional(),
      }),
      req.body,
    );
    const existing = await prisma.staff.findUnique({ where: { id } });
    if (!existing) throw notFound("Employee");
    guardGrant(req, { role: input.role, overrides: input.permissionOverrides }, existing);
    await assertOwnerRemains(existing, input);
    const { pin, password, ...rest } = input;
    const staff = await prisma.staff.update({
      where: { id },
      data: { ...rest, ...(pin ? await hashPin(prisma, pin, id) : {}), ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) },
    });
    await audit(prisma, { action: "STAFF_UPDATED", staffId: req.user.sub, details: { target: id, fields: Object.keys(input).filter((k) => k !== "pin" && k !== "password").concat(pin ? ["pin"] : [], password ? ["password"] : []) } });
    return publicStaff(staff);
  });

  // ── Role permissions ───────────────────────────────────────

  app.get("/roles", manageStaff, async () =>
    Promise.all(
      (["CASHIER", "MANAGER"] as const).map(async (role) => {
        const policy = await rolePolicy(prisma, role);
        return {
          role,
          permissions: { ...DEFAULT_ROLE_PERMISSIONS[role], ...(policy?.permissions ?? {}) },
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
    const saved = await prisma.rolePolicy.upsert({
      where: { role },
      create: { role, permissions: input.permissions, discountMaxBps: input.discountMaxBps },
      update: { permissions: input.permissions, discountMaxBps: input.discountMaxBps },
    });
    await audit(prisma, { action: "ROLE_UPDATED", staffId: req.user.sub, details: { role, ...input } });
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

  /** Activity log: filter by event, employee, location, and date range; newest first. */
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
    const rows = await prisma.auditEvent.findMany({
      where: {
        ...(q.action ? { action: q.action } : q.kind === "events" ? { action: { not: "REQUEST" } } : q.kind === "requests" ? { action: "REQUEST" } : {}),
        staffId: q.staffId,
        locationId: q.locationId,
        createdAt: { gte: q.from, lte: q.to, ...(q.before ? { lt: q.before } : {}) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.take,
    });
    const ids = [...new Set(rows.flatMap((r) => [r.staffId, r.approverId]).filter((x): x is string => !!x))];
    const names = new Map((await prisma.staff.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    return rows.map((r) => ({ ...r, staffName: r.staffId ? (names.get(r.staffId) ?? null) : null, approverName: r.approverId ? (names.get(r.approverId) ?? null) : null }));
  });
}
