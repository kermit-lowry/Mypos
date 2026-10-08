import {
  canUsePin,
  DEFAULT_DISCOUNT_LIMIT_BPS,
  DEFAULT_ROLE_PERMISSIONS,
  effectivePermissions,
  PermissionKeys,
  PermissionLevels,
  PERMISSIONS,
  type EffectivePermissions,
  type Permission,
  type PermissionLevel,
} from "@mypos/shared";
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
  hashPin,
  permissionsFor,
  pinLookup,
  recordFailure,
  rolePolicy,
} from "../services/permissions.js";

const Level = z.enum(PermissionLevels);
/** Page and sign-in permissions have no PIN prompt, so PIN isn't a level they can take. */
const Overrides = z.record(z.enum(PermissionKeys as [Permission, ...Permission[]]), Level).superRefine((o, ctx) => {
  for (const [p, level] of Object.entries(o)) {
    if (level === "PIN" && !canUsePin(p as Permission)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [p], message: `${p} ("${PERMISSIONS[p as Permission].label}") is allowed or not allowed; there's no PIN prompt for it` });
    }
  }
});
type OverrideMap = Partial<Record<Permission, PermissionLevel>>;

const RANK: Record<PermissionLevel, number> = { DENY: 0, PIN: 1, ALLOW: 2 };
/** What someone who doesn't exist yet can do. */
const NOTHING: EffectivePermissions = { levels: Object.fromEntries(PermissionKeys.map((p) => [p, "DENY"])) as Record<Permission, PermissionLevel>, discountMaxBps: 0 };

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

/** For the activity log: a stored value as JSON (undefined → null). */
const json = (v: unknown) => (v === undefined ? null : (v as Prisma.InputJsonValue));

export function staffRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const manageStaff = { preHandler: requirePermission("MANAGE_STAFF") };
  const ip = (req: FastifyRequest) => req.ip;

  async function session(staff: Staff, via: SessionVia) {
    const token = app.jwt.sign({ sub: staff.id, role: staff.role, via }, { expiresIn: "12h" });
    return { token, staff: { id: staff.id, name: staff.name, role: staff.role }, permissions: await permissionsFor(prisma, staff) };
  }

  /** Sign in with PIN alone (the usual way at a register), or email + PIN. */
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
      await audit(prisma, { action: "LOGIN_FAILED", ip: ip(req), details: { email: email ?? null, method } });
      throw new AppError(401, "BAD_LOGIN", email ? "Wrong email or PIN" : "That PIN isn't recognized");
    }
    clearFailures(key);
    await audit(prisma, { action: "LOGIN", staffId: staff.id, ip: ip(req), details: { method } });
    return session(staff, "register");
  });

  /**
   * Back-office website sign-in: email + password (PINs are for the register).
   * Needs the BACK_OFFICE_LOGIN permission.
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
    return session(staff!, "web");
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
    return { staff: { id: staff.id, name: staff.name, role: staff.role }, permissions: req.perms, via: req.user.via ?? "register" };
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
    password?: string;
    email?: string;
  }

  /**
   * Non-owners can't manage owners, change their own standing, reset another
   * manager's credentials, or leave anyone able to do more than they can.
   * Compared on what the employee could actually do before and after, so
   * dropping an owner's DENY override or relaxing DENY to PIN counts as a
   * grant too, and the way the change is phrased doesn't matter.
   */
  async function guardGrant(req: FastifyRequest, input: StaffInput, existing?: Staff) {
    if (req.staffRole === "OWNER") return;
    if (input.role === "OWNER" || existing?.role === "OWNER") throw forbidden("Only an owner can manage owners");
    const self = !!existing && existing.id === req.user.sub;
    if (self && (input.role !== undefined || input.active !== undefined || input.permissionOverrides !== undefined || input.discountMaxBps !== undefined)) {
      throw forbidden("Ask an owner to change your own role, permissions, or discount limit");
    }
    if (!self && existing?.role === "MANAGER" && (input.pin !== undefined || input.password !== undefined || input.email !== undefined)) {
      throw forbidden("Only an owner can reset another manager's PIN or password");
    }
    const mine = req.perms!;
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
        /** Website password, so a new hire can sign in to the back office right away. */
        password: z.string().min(10).max(200).optional(),
        role: z.enum(["OWNER", "MANAGER", "CASHIER"]).default("CASHIER"),
        discountMaxBps: z.number().int().min(0).max(10_000).nullable().optional(),
        permissionOverrides: Overrides.default({}),
      }),
      req.body,
    );
    await guardGrant(req, input);
    const { pin, password, ...rest } = input;
    const staff = await prisma.staff.create({
      data: { ...rest, ...(await hashPin(prisma, pin)), ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) },
    });
    await audit(prisma, {
      action: "STAFF_CREATED",
      staffId: req.user.sub,
      details: { target: staff.id, targetName: staff.name, role: staff.role, discountMaxBps: staff.discountMaxBps, permissionOverrides: rest.permissionOverrides, passwordSet: !!password },
    });
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
    await guardGrant(req, input, existing);
    await assertOwnerRemains(existing, input);
    const { pin, password, ...rest } = input;
    const staff = await prisma.staff.update({
      where: { id },
      data: { ...rest, ...(pin ? await hashPin(prisma, pin, id) : {}), ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) },
    });
    const changes: Record<string, Prisma.InputJsonValue> = {};
    for (const k of ["name", "email", "role", "active", "discountMaxBps", "permissionOverrides"] as const) {
      if (rest[k] !== undefined && JSON.stringify(existing[k]) !== JSON.stringify(staff[k])) changes[k] = { from: json(existing[k]), to: json(staff[k]) };
    }
    await audit(prisma, {
      action: "STAFF_UPDATED",
      staffId: req.user.sub,
      details: { target: id, targetName: existing.name, changes, pinChanged: !!pin, passwordChanged: !!password },
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

  /** Activity log: filter by event (one, or several comma-separated), employee, location, and date range; newest first. */
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
    const names = new Map((await prisma.staff.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    return rows.map((r) => ({ ...r, staffName: r.staffId ? (names.get(r.staffId) ?? null) : null, approverName: r.approverId ? (names.get(r.approverId) ?? null) : null }));
  });
}
