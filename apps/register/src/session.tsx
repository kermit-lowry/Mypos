import type { EffectivePermissions, Permission, PermissionLevel } from "@mypos/shared";
import { createContext, useContext } from "react";
import type { Location } from "./api";

export interface Staff {
  id: string;
  name: string;
  role: "OWNER" | "MANAGER" | "CASHIER";
}

export interface Session {
  staff: Staff;
  location: Location;
  /** What this employee may do: ALLOW, PIN (needs a manager), or DENY. */
  permissions: EffectivePermissions;
  signOut: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside of a signed-in screen");
  return s;
}

export const isManager = (s: Staff) => s.role === "MANAGER" || s.role === "OWNER";

/** This employee's level for a permission. */
export function useCan(): (p: Permission) => PermissionLevel {
  const { permissions } = useSession();
  return (p) => permissions.levels[p] ?? "DENY";
}
