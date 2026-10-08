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
  signOut: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside of a signed-in screen");
  return s;
}

export const isManager = (s: Staff) => s.role === "MANAGER" || s.role === "OWNER";
