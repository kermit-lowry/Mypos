import type { StaffKind, StaffRole } from "@prisma/client";
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

/** A session token: a register employee (via "register") or a website user (via "web"). */
export interface SessionPayload {
  sub: string;
  role: StaffRole;
  via?: SessionVia;
  kind: StaffKind;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: SessionPayload;
    user: SessionPayload;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in account's current permissions (loaded fresh each request). */
    perms?: EffectivePermissions;
    staffRole?: StaffRole;
    /** EMPLOYEE (register) or USER (website), from the row, not the token. */
    staffKind?: StaffKind;
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
 * preHandler: a signed-in, active account. Permissions, role and kind are
 * read from the database on every request, so deactivating someone or
 * changing their permissions takes effect immediately, not when their
 * session expires. A website session must belong to a website user and a
 * register session to an employee: the two never cross.
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
    const via: SessionVia = req.user.via ?? "register";
    if (via === "web" && staff.kind !== "USER") throw new AppError(401, "UNAUTHENTICATED", "Employees sign in at the register, not the website");
    if (via === "register" && staff.kind !== "EMPLOYEE") throw new AppError(401, "UNAUTHENTICATED", "Website users sign in on the website, not at the register");
    req.staffRole = staff.role;
    req.staffKind = staff.kind;
    req.perms = await permissionsFor(prisma, staff);
  };
}

export const notAnEmployee = () => new AppError(403, "NOT_AN_EMPLOYEE", "Only register employees can do that; website users can't");

/**
 * preHandler: a signed-in register employee (website users get 403
 * NOT_AN_EMPLOYEE), optionally also allowed (or approved) to do `permission`.
 * For clocking in, drawers, and other things only someone in the store does.
 */
export function requireEmployee(permission?: Permission) {
  const staff = requireStaff();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await staff(req, reply);
    if (req.staffKind !== "EMPLOYEE") throw notAnEmployee();
    if (permission) await authorize(req, permission);
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
  const u = req.user as SessionPayload | undefined;
  return u ? { id: u.sub, role: req.staffRole ?? u.role } : undefined;
}
