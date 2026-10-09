import { effectivePermissions, PermissionKeys, PERMISSIONS, WEB_PERMISSIONS } from "@mypos/shared";
import type { Staff } from "@prisma/client";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, conflict, forbidden, notFound } from "../errors.js";
import { parse, requirePermission } from "../http.js";
import type { Ctx } from "../services/context.js";
import { audit, changes, permissionsFor, rolePolicy } from "../services/permissions.js";
import { NOTHING, overridesFor, RANK, type OverrideMap } from "./overrides.js";

/**
 * A website user as the API shows them: never the password hash. `permissions`
 * is what they can do on the website (their role's defaults with their own
 * overrides), so the users page can show it without reading role policies.
 */
const presentUser = (u: Staff, levels: Record<string, string>) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  active: u.active,
  permissionOverrides: u.permissionOverrides,
  permissions: Object.fromEntries(WEB_PERMISSIONS.map((p) => [p, levels[p]])),
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

const Role = z.enum(["OWNER", "MANAGER"]);
const Password = z.string().min(10).max(200);
const UserOverrides = overridesFor("USER");

/**
 * Back-office website users (Staff rows of kind USER): email + password,
 * OWNER or MANAGER, website permissions that are only Allowed / Not allowed.
 * Separate from register employees (routes/staff.ts); the same person may be
 * both. Needs MANAGE_USERS, which only website users can hold.
 */
export function userRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const manageUsers = { preHandler: requirePermission("MANAGE_USERS") };
  const publicUser = async (u: Staff) => presentUser(u, (await permissionsFor(prisma, u)).levels);

  interface UserInput {
    role?: "OWNER" | "MANAGER";
    active?: boolean;
    permissionOverrides?: OverrideMap;
    email?: string;
    password?: string;
  }

  /**
   * Nobody changes their own standing (403 SELF). Non-owners can't manage
   * owners, reset another manager's sign-in, or leave anyone able to do more
   * than they can, compared on what the user could actually do before and after.
   */
  async function guardGrant(req: FastifyRequest, input: UserInput, existing?: Staff) {
    const self = !!existing && existing.id === req.user.sub;
    if (self && (input.role !== undefined || input.active !== undefined || input.permissionOverrides !== undefined)) {
      throw new AppError(403, "SELF", "Ask another owner to change your own role, permissions, or access");
    }
    if (req.staffRole === "OWNER") return;
    if (input.role === "OWNER" || existing?.role === "OWNER") throw forbidden("Only an owner can manage owners");
    if (!self && existing?.role === "MANAGER" && (input.password !== undefined || input.email !== undefined)) {
      throw forbidden("Only an owner can reset another manager's password or email");
    }
    const mine = req.perms!;
    const before = existing ? await permissionsFor(prisma, existing) : NOTHING;
    const role = input.role ?? existing?.role ?? "MANAGER";
    const after = effectivePermissions(role, await rolePolicy(prisma, role), { kind: "USER", overrides: input.permissionOverrides ?? (existing?.permissionOverrides as OverrideMap | undefined) });
    for (const p of PermissionKeys) {
      if (RANK[after.levels[p]] > RANK[before.levels[p]] && RANK[mine.levels[p]] < RANK[after.levels[p]]) throw forbidden(`You can't grant "${PERMISSIONS[p].label}"`);
    }
  }

  /** The website needs an active owner too; register owners are counted separately (routes/staff.ts). */
  async function assertOwnerRemains(changing: Staff, next: { role?: Staff["role"]; active?: boolean }) {
    const losesOwner = changing.role === "OWNER" && ((next.role && next.role !== "OWNER") || next.active === false);
    if (!losesOwner) return;
    const owners = await prisma.staff.count({ where: { kind: "USER", role: "OWNER", active: true, id: { not: changing.id } } });
    if (owners === 0) throw conflict("LAST_OWNER", "The website needs at least one active owner");
  }

  /** Emails are unique among website users (an employee may share one: same person, two accounts). */
  async function assertEmailFree(email: string | undefined, exceptId?: string) {
    if (!email) return;
    const taken = await prisma.staff.findUnique({ where: { kind_email: { kind: "USER", email } } });
    if (taken && taken.id !== exceptId) throw conflict("EMAIL_TAKEN", "Another website user already uses that email");
  }

  app.get("/users", manageUsers, async () => Promise.all((await prisma.staff.findMany({ where: { kind: "USER" }, orderBy: [{ active: "desc" }, { name: "asc" }] })).map(publicUser)));

  app.post("/users", manageUsers, async (req, reply) => {
    const input = parse(
      z.object({
        name: z.string().min(1).max(80),
        email: z.string().email(),
        password: Password,
        role: Role.default("MANAGER"),
        permissionOverrides: UserOverrides.default({}),
      }),
      req.body,
    );
    await guardGrant(req, input);
    await assertEmailFree(input.email);
    const { password, ...rest } = input;
    const user = await prisma.staff.create({ data: { ...rest, kind: "USER", passwordHash: await bcrypt.hash(password, 10) } });
    await audit(prisma, {
      action: "USER_CREATED",
      staffId: req.user.sub,
      details: { target: user.id, targetName: user.name, role: user.role, permissionOverrides: rest.permissionOverrides },
    });
    return reply.code(201).send(await publicUser(user));
  });

  app.patch("/users/:id", manageUsers, async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        name: z.string().min(1).max(80).optional(),
        email: z.string().email().optional(),
        role: Role.optional(),
        active: z.boolean().optional(),
        permissionOverrides: UserOverrides.optional(),
        password: Password.optional(),
      }),
      req.body,
    );
    const existing = await prisma.staff.findUnique({ where: { id, kind: "USER" } });
    if (!existing) throw notFound("User");
    // The lone owner stepping down gets the owner message, not the self one.
    await assertOwnerRemains(existing, input);
    await guardGrant(req, input, existing);
    await assertEmailFree(input.email, id);
    const { password, ...rest } = input;
    const user = await prisma.staff.update({ where: { id }, data: { ...rest, ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) } });
    await audit(prisma, {
      action: "USER_UPDATED",
      staffId: req.user.sub,
      details: { target: id, targetName: existing.name, changes: changes(existing as unknown as Record<string, unknown>, rest), passwordChanged: !!password },
    });
    return await publicUser(user);
  });
}
