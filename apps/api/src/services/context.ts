import type { PrismaClient, StaffRole } from "@prisma/client";
import type { EffectivePermissions } from "@mypos/shared";
import type { PaymentGateway } from "../payments/gateway.js";

export interface Actor {
  id: string;
  role: StaffRole;
}

export interface Ctx {
  prisma: PrismaClient;
  gateway: PaymentGateway;
  /** Staff member performing the action; absent for storefront/customer actions. */
  actor?: Actor;
  /** The actor's current permissions. */
  perms?: EffectivePermissions;
  /** A manager's PIN approval sent with the request. */
  approvalToken?: string;
}

const RANK: Record<StaffRole, number> = { CASHIER: 0, MANAGER: 1, OWNER: 2 };

export function hasRole(actor: Actor | undefined, min: StaffRole): boolean {
  return !!actor && RANK[actor.role] >= RANK[min];
}
