import type { StaffRole } from "@prisma/client";
import type { EffectivePermissions, Permission } from "@mypos/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType, ZodTypeDef } from "zod";
import { prisma } from "./db.js";
import { AppError, badRequest } from "./errors.js";
import type { Actor } from "./services/context.js";
import { approvalRequired, audit, consumeApproval, findApproval, permissionDenied, permissionsFor } from "./services/permissions.js";

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest("VALIDATION", "Invalid request", r.error.flatten());
  return r.data;
}

/** Where a session was opened: the back-office website, or a register (PIN). */
export type SessionVia = "web" | "register";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: StaffRole; via?: SessionVia };
    user: { sub: string; role: StaffRole; via?: SessionVia };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in employee's current permissions (loaded fresh each request). */
    perms?: EffectivePermissions;
    staffRole?: StaffRole;
    /** Manager who approved this request with their PIN, if any. */
    approverId?: string;
  }
}

/** Header carrying a manager's PIN approval. */
export const APPROVAL_HEADER = "x-approval-token";
export const approvalTokenOf = (req: FastifyRequest) => {
  const v = req.headers[APPROVAL_HEADER];
  return typeof v === "string" && v ? v : undefined;
};

/**
 * preHandler: a signed-in, active employee. Permissions and role are read
 * from the database on every request, so deactivating someone or changing
 * their permissions takes effect immediately, not when their session expires.
 */
export function requireStaff() {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new AppError(401, "UNAUTHENTICATED", "Sign in at the register first");
    }
    const staff = await prisma.staff.findUnique({ where: { id: req.user.sub } });
    if (!staff || !staff.active) throw new AppError(401, "UNAUTHENTICATED", "This account is no longer active");
    req.staffRole = staff.role;
    req.perms = await permissionsFor(prisma, staff);
    // A website session keeps needing back-office access, not only at sign-in.
    // 401 so the site drops the token; register sessions aren't gated this way.
    if (req.user.via === "web" && req.perms.levels.BACK_OFFICE_LOGIN === "DENY") throw new AppError(401, "UNAUTHENTICATED", "Back-office access was removed");
  };
}

/**
 * Check one permission for the current request. ALLOW passes; PIN passes with
 * a manager approval (consumed here); DENY fails.
 */
export async function authorize(req: FastifyRequest, permission: Permission, usedFor = `${req.method} ${req.routeOptions.url}`): Promise<void> {
  const level = req.perms?.levels[permission] ?? "DENY";
  if (level === "ALLOW") return;
  if (level === "DENY") throw permissionDenied(permission);
  const token = approvalTokenOf(req);
  const grant = await findApproval(prisma, token, permission, req.user.sub);
  if (!grant || !(await consumeApproval(prisma, grant.id, usedFor))) throw approvalRequired(permission);
  req.approverId = grant.approverId;
  await audit(prisma, { action: `APPROVED:${permission}`, staffId: req.user.sub, approverId: grant.approverId, details: { usedFor } });
}

/** preHandler: signed in, and allowed (or approved) to do `permission`. */
export function requirePermission(permission: Permission) {
  const staff = requireStaff();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await staff(req, reply);
    await authorize(req, permission);
  };
}

/** Kept for routes any employee may use. */
export const requireRole = (_min: "CASHIER") => requireStaff();

export function actorOf(req: FastifyRequest): Actor | undefined {
  const u = req.user as { sub: string; role: StaffRole } | undefined;
  return u ? { id: u.sub, role: req.staffRole ?? u.role } : undefined;
}
