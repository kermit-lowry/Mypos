import type { Permission } from "@mypos/shared";
import { PERMISSIONS } from "@mypos/shared";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Modal, Text, View } from "react-native";
import { api, ApiError } from "./api";
import { Button } from "./components/Button";
import { PinPad } from "./components/PinPad";
import { useLayout } from "./layout";
import { useSession } from "./session";
import { colors, ui } from "./theme";

interface Request {
  permissions: Permission[];
  discountBps?: number;
  reason?: string;
}

type Ask = (r: Request) => Promise<string | null>;
const ApprovalContext = createContext<Ask | null>(null);

/**
 * Shows the manager-PIN prompt. `ask` resolves to an approval token, or null
 * if the cashier cancels.
 */
export function ApprovalProvider({ children }: { children: ReactNode }) {
  const { location } = useSession();
  const { dialog } = useLayout();
  const [req, setReq] = useState<Request | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((t: string | null) => void) | null>(null);

  const ask = useCallback<Ask>(
    (r) =>
      new Promise((resolve) => {
        resolver.current = resolve;
        setError(null);
        setReq(r);
      }),
    [],
  );
  const finish = (t: string | null) => {
    resolver.current?.(t);
    resolver.current = null;
    setReq(null);
  };

  async function submit(pin: string) {
    if (!req) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>("POST", "/auth/approve", { pin, permissions: req.permissions, discountBps: req.discountBps, reason: req.reason, locationId: location.id });
      finish(r.token);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ApprovalContext.Provider value={ask}>
      {children}
      {req && (
        <Modal transparent animationType="fade" onRequestClose={() => finish(null)}>
          <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
            <View style={[ui.panel, { width: dialog(380), gap: 12, alignItems: "center" }]}>
              <Text style={ui.h1}>Manager approval</Text>
              <Text style={[ui.muted, { textAlign: "center" }]}>
                {req.permissions.map((p) => PERMISSIONS[p].label).join(", ")}
                {req.discountBps ? ` (${(req.discountBps / 100).toFixed(1)}%)` : ""}
              </Text>
              <PinPad onSubmit={submit} busy={busy} submitLabel="Approve" />
              {error && <Text style={[ui.error, { textAlign: "center" }]}>{error}</Text>}
              <Button title="Cancel" kind="secondary" onPress={() => finish(null)} style={{ alignSelf: "stretch" }} />
            </View>
          </View>
        </Modal>
      )}
    </ApprovalContext.Provider>
  );
}

export class NotPermitted extends Error {}

/**
 * Run an action the employee may need approval for. ALLOW runs it; PIN asks a
 * manager first; DENY refuses. If the server still says approval is needed
 * (settings changed, or a discount over the limit), it asks and retries once.
 * Returns undefined if the cashier cancels the PIN prompt.
 */
export function useGuard() {
  const ask = useContext(ApprovalContext);
  const { permissions } = useSession();
  if (!ask) throw new Error("useGuard needs an ApprovalProvider");

  return useCallback(
    async <T,>(permission: Permission, run: (approvalToken?: string) => Promise<T>, opts: { discountBps?: number; needsApproval?: boolean } = {}): Promise<T | undefined> => {
      const level = permissions.levels[permission] ?? "DENY";
      if (level === "DENY") throw new NotPermitted(`You don't have permission to ${PERMISSIONS[permission].label.toLowerCase()}`);
      let token: string | undefined;
      if (level === "PIN" || opts.needsApproval) {
        token = (await ask({ permissions: [permission], discountBps: opts.discountBps })) ?? undefined;
        if (!token) return undefined;
      }
      try {
        return await run(token);
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== "APPROVAL_REQUIRED") throw e;
        const d = (e.details ?? {}) as { permission?: Permission; permissions?: Permission[]; discountBps?: number };
        const retry = await ask({ permissions: d.permissions ?? [d.permission ?? permission], discountBps: d.discountBps });
        return retry ? run(retry) : undefined;
      }
    },
    [ask, permissions],
  );
}

/** Ask for a manager's PIN directly (e.g. to pre-approve a discount). */
export function useAskApproval(): Ask {
  const ask = useContext(ApprovalContext);
  if (!ask) throw new Error("useAskApproval needs an ApprovalProvider");
  return ask;
}

export const permissionColor = (level: string) => (level === "ALLOW" ? colors.good : level === "PIN" ? colors.warn : colors.bad);
