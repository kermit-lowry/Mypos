import type { Prisma, Staff } from "@prisma/client";
import { effectivePermissions, type EffectivePermissions, type Permission, type PermissionLevel, type RolePolicy } from "@mypos/shared";
import bcrypt from "bcryptjs";
import { createHmac, randomBytes } from "node:crypto";
import { config } from "../config.js";
import type { Db } from "../db.js";
import { AppError, conflict } from "../errors.js";

/** PINs are looked up by HMAC so a PIN alone identifies an employee, without storing it. */
export const pinLookup = (pin: string) => createHmac("sha256", config.pinPepper).update(`pin:${pin}`).digest("hex");

export async function hashPin(db: Db, pin: string, exceptStaffId?: string): Promise<{ pinHash: string; pinLookup: string }> {
  if (!/^\d{4,8}$/.test(pin)) throw new AppError(400, "PIN_FORMAT", "PINs are 4 to 8 digits");
  const lookup = pinLookup(pin);
  const taken = await db.staff.findUnique({ where: { pinLookup: lookup } });
  if (taken && taken.id !== exceptStaffId) throw conflict("PIN_TAKEN", "Someone already uses that PIN; pick another");
  return { pinHash: await bcrypt.hash(pin, 10), pinLookup: lookup };
}

export async function rolePolicy(db: Db, role: Staff["role"]): Promise<RolePolicy | null> {
  const row = await db.rolePolicy.findUnique({ where: { role } });
  return row ? { permissions: row.permissions as RolePolicy["permissions"], discountMaxBps: row.discountMaxBps } : null;
}

export async function permissionsFor(db: Db, staff: Staff): Promise<EffectivePermissions> {
  return effectivePermissions(staff.role, await rolePolicy(db, staff.role), {
    overrides: staff.permissionOverrides as Partial<Record<Permission, PermissionLevel>>,
    discountMaxBps: staff.discountMaxBps,
  });
}

// ── Brute-force protection for PINs ──────────────────────────────

const WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 5;
const failures = new Map<string, number[]>();

export function checkAttempts(key: string) {
  const recent = (failures.get(key) ?? []).filter((t) => Date.now() - t < WINDOW_MS);
  failures.set(key, recent);
  if (recent.length >= MAX_FAILURES) throw new AppError(429, "TOO_MANY_ATTEMPTS", "Too many wrong PINs. Wait a few minutes and try again.");
}
export const recordFailure = (key: string) => failures.set(key, [...(failures.get(key) ?? []), Date.now()]);
export const clearFailures = (key: string) => failures.delete(key);
export const resetAttemptsForTests = () => failures.clear();

// ── Manager approvals ────────────────────────────────────────────

/** Discounts and price changes are approved while building a cart, so they last longer. */
const TTL_MS = (perms: string[]) => (perms.every((p) => p === "DISCOUNT_LINE" || p === "PRICE_OVERRIDE") ? 15 * 60_000 : 2 * 60_000);

export interface Approval {
  token: string;
  approver: { id: string; name: string };
  expiresAt: Date;
}

/**
 * A manager enters their PIN to approve something for the signed-in employee.
 * The approver needs ALLOW for every permission (and a high enough discount
 * limit). The token only works for the employee who asked, once. Every way
 * this can fail is logged (never the PIN), so a wrong-PIN streak is visible.
 */
export async function approve(
  db: Db,
  input: { pin: string; permissions: Permission[]; requesterId: string; discountBps?: number; reason?: string; locationId?: string; ip?: string },
  attemptKey: string,
): Promise<Approval> {
  // A discount approval is for a stated amount, so one PIN for 15% can't clear 100%.
  if (input.permissions.includes("DISCOUNT_LINE") && input.discountBps === undefined) {
    throw new AppError(400, "DISCOUNT_BPS_REQUIRED", "Say how much is being discounted");
  }
  const failed = (reason: string, extra: Prisma.InputJsonObject = {}, approverId?: string) =>
    audit(db, {
      action: "APPROVAL_FAILED",
      staffId: input.requesterId,
      approverId,
      locationId: input.locationId,
      ip: input.ip,
      details: { reason, permissions: input.permissions, discountBps: input.discountBps ?? null, ...extra },
    });
  try {
    checkAttempts(attemptKey);
  } catch (e) {
    await failed("LOCKED_OUT");
    throw e;
  }
  const approver = await db.staff.findUnique({ where: { pinLookup: pinLookup(input.pin) } });
  if (!approver || !approver.active) {
    recordFailure(attemptKey);
    await failed("BAD_PIN");
    throw new AppError(401, "BAD_PIN", "That PIN isn't recognized");
  }
  clearFailures(attemptKey);
  const perms = await permissionsFor(db, approver);
  const missing = input.permissions.filter((p) => perms.levels[p] !== "ALLOW");
  if (missing.length) {
    await failed("APPROVER_NOT_ALLOWED", { missing }, approver.id);
    throw new AppError(403, "APPROVER_NOT_ALLOWED", `${approver.name} can't approve that`, { missing });
  }
  if (input.discountBps !== undefined && input.discountBps > perms.discountMaxBps) {
    await failed("APPROVER_LIMIT", { approverMaxBps: perms.discountMaxBps }, approver.id);
    throw new AppError(403, "APPROVER_LIMIT", `${approver.name} can approve discounts up to ${perms.discountMaxBps / 100}%`);
  }
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_MS(input.permissions));
  await db.approvalGrant.create({
    data: {
      id: token,
      approverId: approver.id,
      requesterId: input.requesterId,
      permissions: input.permissions,
      discountMaxBps: input.discountBps === undefined ? perms.discountMaxBps : Math.min(perms.discountMaxBps, input.discountBps),
      reason: input.reason,
      expiresAt,
    },
  });
  await audit(db, { action: "APPROVAL", staffId: input.requesterId, approverId: approver.id, locationId: input.locationId, details: { permissions: input.permissions, discountBps: input.discountBps ?? null, reason: input.reason ?? null } });
  return { token, approver: { id: approver.id, name: approver.name }, expiresAt };
}

/** A usable approval for `permission`, or null. Doesn't consume it. */
export async function findApproval(db: Db, token: string | undefined, permission: Permission, requesterId: string) {
  if (!token) return null;
  const g = await db.approvalGrant.findUnique({ where: { id: token } });
  if (!g || g.usedAt || g.expiresAt <= new Date() || g.requesterId !== requesterId || !g.permissions.includes(permission)) return null;
  return g;
}

/** Use an approval up. Returns false if someone else already used it. */
export async function consumeApproval(db: Db, token: string, usedFor: string): Promise<boolean> {
  const r = await db.approvalGrant.updateMany({ where: { id: token, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date(), usedFor } });
  return r.count === 1;
}

export const approvalRequired = (permission: Permission, extra: object = {}) =>
  new AppError(403, "APPROVAL_REQUIRED", "This needs a manager's PIN", { permission, ...extra });

export const permissionDenied = (permission: Permission) => new AppError(403, "PERMISSION_DENIED", "You don't have permission to do that", { permission });

/** Record a named event in the activity log (drawer opens, voids, discounts, price changes...). */
export async function audit(
  db: Db,
  e: { action: string; staffId?: string | null; approverId?: string | null; locationId?: string | null; details?: Prisma.InputJsonValue; ip?: string },
) {
  await db.auditEvent.create({
    data: { action: e.action, staffId: e.staffId ?? null, approverId: e.approverId ?? null, locationId: e.locationId ?? null, details: e.details ?? {}, ip: e.ip },
  });
}
