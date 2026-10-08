import { formatCents, type Permission, type PermissionLevel } from "@mypos/shared";
import * as Print from "expo-print";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { openDocument } from "../admin/ui";
import {
  api,
  ApiError,
  apiText,
  type CashCounts,
  type CashMovement,
  type CashMovementKind,
  type DrawerExpected,
  type DrawerReport,
  type DrawerSession,
  type DrawerSettings,
  type TimeEntry,
} from "../api";
import { useGuard } from "../approval";
import { Button } from "../components/Button";
import { CashCount, countTotal, nonZeroCounts } from "../components/CashCount";
import { SplitPane } from "../components/SplitPane";
import { TerminalPicker, useTerminal, type Terminal } from "../components/TerminalPicker";
import { useLayout } from "../layout";
import { useCan, useSession } from "../session";
import { colors, ui } from "../theme";

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** "7 h 58 m", or "12 m" under an hour. */
export const hoursMinutes = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`;
};
const minutesSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 60_000;
const cents = (t: string) => {
  const n = Math.round(Number(t) * 100);
  return t.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
};
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const KIND_LABEL: Record<CashMovementKind, string> = { PAID_IN: "Paid in", PAID_OUT: "Paid out", DROP: "Safe drop" };
const REASONS: Record<CashMovementKind, string[]> = {
  PAID_IN: ["Change from the bank", "Float top-up", "Cash returned"],
  PAID_OUT: ["Petty cash", "Supplies", "Vendor payment", "Tip out"],
  DROP: ["Safe drop", "Bank deposit"],
};

// ─── Time clock status, shared with the header badge ─────────────

export interface ClockStatus {
  entry: TimeEntry | null;
  today?: { minutes: number };
}

const clockListeners = new Set<() => void>();
/** After a clock in/out: every status badge refetches. */
export const refreshClockStatus = () => clockListeners.forEach((l) => l());

/** The signed-in employee's time clock status, refreshed once a minute (one small GET). */
export function useClockStatus(): ClockStatus | null {
  const [status, setStatus] = useState<ClockStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api<ClockStatus>("GET", "/time/status")
        .then((s) => live && setStatus(s))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    clockListeners.add(load);
    return () => {
      live = false;
      clearInterval(t);
      clockListeners.delete(load);
    };
  }, []);
  return status;
}

/** "Clocked in 3 h 12 m" / "Not clocked in" for the header. */
export const clockLabel = (s: ClockStatus | null) => (!s ? "" : s.entry ? `Clocked in ${hoursMinutes(minutesSince(s.entry.clockIn))}` : "Not clocked in");

// ─── Shift screen ────────────────────────────────────────────────

interface Current {
  session: DrawerSession | null;
  expected: DrawerExpected | null;
  settings: DrawerSettings;
}

/**
 * The cash drawer for this register: start a shift (count the float in),
 * paid in / out and safe drops, the X report, and close with a count. The
 * time clock for the signed-in employee lives on the right.
 */
export function ShiftScreen() {
  const { location, staff } = useSession();
  const can = useCan();
  const guard = useGuard();
  const { terminals, terminal, select } = useTerminal();
  const [current, setCurrent] = useState<Current | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickingTerminal, setPickingTerminal] = useState(false);
  const [movement, setMovement] = useState<CashMovementKind | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<DrawerSession | null>(null);

  // Drawers belong to a register (its terminal); with no terminals the location has one drawer.
  const ready = terminals !== null;
  const terminalId = terminal?.id;
  const needsTerminal = !!terminals?.length && !terminal;

  const load = useCallback(async () => {
    if (!ready) return;
    try {
      setCurrent(await api<Current>("GET", `/drawer/current?locationId=${location.id}${terminalId ? `&terminalId=${terminalId}` : ""}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [ready, location.id, terminalId]);
  useEffect(() => {
    load();
  }, [load]);

  const session = current?.session ?? null;
  const settings = current?.settings;
  const openLevel = can("DRAWER_OPEN_CLOSE");
  const cashLevel = can("CASH_IN_OUT");

  async function start(openingFloatCents: number, openingCount: CashCounts | undefined, notes: string) {
    try {
      const r = await guard("DRAWER_OPEN_CLOSE", (t) =>
        api<DrawerSession>("POST", "/drawer/open", { locationId: location.id, terminalId, openingFloatCents, openingCount, notes: notes || undefined }, { approvalToken: t }),
      );
      if (r) await load();
    } catch (e) {
      // Opened from another register in the meantime: just show it.
      if (e instanceof ApiError && e.code === "DRAWER_ALREADY_OPEN") return load();
      throw e;
    }
  }

  async function addMovement(kind: CashMovementKind, amountCents: number, reason: string, note: string): Promise<boolean> {
    if (!session) return false;
    const r = await guard("CASH_IN_OUT", (t) => api<CashMovement>("POST", `/drawer/${session.id}/movements`, { kind, amountCents, reason, note: note || undefined }, { approvalToken: t }));
    if (r) await load();
    return !!r;
  }

  async function closeDrawer(countedCashCents: number, closingCount: CashCounts | undefined, notes: string): Promise<boolean> {
    if (!session) return false;
    const run = (t?: string) => api<DrawerSession>("POST", `/drawer/${session.id}/close`, { countedCashCents, closingCount, notes: notes || undefined }, { approvalToken: t });
    let r: DrawerSession | undefined;
    try {
      r = await guard("DRAWER_OPEN_CLOSE", run);
    } catch (e) {
      // The count is off by more than the alert amount: a manager accepts the
      // variance, then the same count is sent again with their approval.
      if (!(e instanceof ApiError) || e.code !== "APPROVAL_REQUIRED" || !asksFor(e, "CASH_VARIANCE_OVERRIDE")) throw e;
      r = await guard("CASH_VARIANCE_OVERRIDE", run);
    }
    if (!r) return false;
    setClosing(false);
    setClosed(r);
    await load();
    return true;
  }

  const openedBy = session?.openedBy?.name ?? (session && session.openedById === staff.id ? staff.name : null);
  const expected = current?.expected ?? null;

  const drawer = (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
      <View style={[ui.row, { justifyContent: "space-between", flexWrap: "wrap", gap: 8 }]}>
        <Text style={ui.h1}>{session ? `Drawer #${session.number}` : "Cash drawer"}</Text>
        {!!terminals?.length && (
          <Pressable onPress={() => setPickingTerminal(true)}>
            <Text style={ui.muted}>{terminal ? `${terminal.name} · change` : "Pick this register's terminal"}</Text>
          </Pressable>
        )}
      </View>
      {error && <Text style={ui.error}>{error}</Text>}
      {!current ? (
        <Text style={ui.muted}>{needsTerminal ? "Pick this register's terminal to see its drawer." : "Loading…"}</Text>
      ) : !session ? (
        <StartShift
          settings={current.settings}
          level={openLevel}
          blocked={needsTerminal ? "Pick this register's terminal first." : null}
          onStart={start}
        />
      ) : (
        <View style={{ gap: 12 }}>
          <Text style={ui.muted}>
            Open since {timeOf(session.openedAt)}
            {openedBy ? ` by ${openedBy}` : ""}
            {terminal ? ` · ${terminal.name}` : ""}
          </Text>
          {expected ? (
            <CashRows cash={expected} />
          ) : (
            <Text style={ui.muted}>Blind count: the expected amount is shown once the drawer is closed.</Text>
          )}
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            {cashLevel !== "DENY" && (
              <>
                <Button title="Paid in" kind="secondary" onPress={() => setMovement("PAID_IN")} style={{ flexGrow: 1 }} />
                <Button title="Paid out" kind="secondary" onPress={() => setMovement("PAID_OUT")} style={{ flexGrow: 1 }} />
                <Button title="Safe drop" kind="secondary" onPress={() => setMovement("DROP")} style={{ flexGrow: 1 }} />
              </>
            )}
            <Button title="X report" kind="secondary" onPress={() => setShowReport(true)} style={{ flexGrow: 1 }} />
            {openLevel !== "DENY" && (
              <Button title={`Close drawer${openLevel === "PIN" ? " · PIN" : ""}`} kind="danger" onPress={() => setClosing(true)} style={{ flexGrow: 1 }} />
            )}
          </View>
          {cashLevel === "PIN" && <Text style={ui.muted}>Paid in / out and safe drops need a manager's PIN.</Text>}
          <Movements movements={session.movements ?? []} />
        </View>
      )}
    </ScrollView>
  );

  return (
    <>
      <SplitPane leftLabel="Drawer" rightLabel="Time clock" left={drawer} right={<TimeClock />} />

      {pickingTerminal && terminals && (
        <TerminalPicker terminals={terminals} selectedId={terminal?.id} onSelect={select} onClose={() => setPickingTerminal(false)} />
      )}
      {movement && session && <MovementSheet kind={movement} level={cashLevel} onSubmit={(a, r, n) => addMovement(movement, a, r, n)} onClose={() => setMovement(null)} />}
      {showReport && session && <ReportModal session={session} terminal={terminal} onClose={() => setShowReport(false)} />}
      {closing && session && settings && (
        <CloseSheet session={session} expected={settings.blindCashCount ? null : expected} level={openLevel} onSubmit={closeDrawer} onClose={() => setClosing(false)} />
      )}
      {closed && <ClosedResult session={closed} terminal={terminal} onDone={() => setClosed(null)} />}
    </>
  );
}

/** Whether an APPROVAL_REQUIRED error names this permission. */
function asksFor(e: ApiError, permission: Permission): boolean {
  const d = (e.details ?? {}) as { permission?: Permission; permissions?: Permission[] };
  return d.permission === permission || !!d.permissions?.includes(permission);
}

// ─── Start shift ─────────────────────────────────────────────────

/** Count by denomination, or type the total. */
function CountInput({ placeholder, onChange }: { placeholder: string; onChange: (totalCents: number | undefined, counts: CashCounts | undefined) => void }) {
  const [byCount, setByCount] = useState(true);
  const [counts, setCounts] = useState<CashCounts>({});
  const [amount, setAmount] = useState("");
  const emit = (b: boolean, c: CashCounts, a: string) => onChange(b ? countTotal(c) : cents(a), b ? nonZeroCounts(c) : undefined);
  return (
    <View style={{ gap: 10 }}>
      <View style={[ui.row, { gap: 8 }]}>
        <Button
          title="Count cash"
          kind={byCount ? "primary" : "secondary"}
          onPress={() => {
            setByCount(true);
            emit(true, counts, amount);
          }}
          style={{ flex: 1 }}
        />
        <Button
          title="Type amount"
          kind={byCount ? "secondary" : "primary"}
          onPress={() => {
            setByCount(false);
            emit(false, counts, amount);
          }}
          style={{ flex: 1 }}
        />
      </View>
      {byCount ? (
        <CashCount
          counts={counts}
          onChange={(c) => {
            setCounts(c);
            emit(true, c, amount);
          }}
        />
      ) : (
        <TextInput
          style={ui.input}
          value={amount}
          onChangeText={(a) => {
            setAmount(a);
            emit(false, counts, a);
          }}
          keyboardType="decimal-pad"
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
        />
      )}
    </View>
  );
}

function StartShift(props: {
  settings: DrawerSettings;
  level: PermissionLevel;
  blocked: string | null;
  onStart: (openingFloatCents: number, openingCount: CashCounts | undefined, notes: string) => Promise<void>;
}) {
  const [count, setCount] = useState<{ total: number | undefined; counts: CashCounts | undefined }>({ total: 0, counts: {} });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (count.total === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await props.onStart(count.total, count.counts, notes);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Text style={ui.h2}>Start shift</Text>
      <Text style={ui.muted}>
        Count the starting cash (float) into the drawer.
        {props.settings.requireDrawerSession ? " Cash sales need an open drawer." : ""}
      </Text>
      <CountInput placeholder="Opening float, e.g. 200.00" onChange={(total, counts) => setCount({ total, counts })} />
      <TextInput style={ui.input} value={notes} onChangeText={setNotes} placeholder="Notes (optional)" placeholderTextColor={colors.muted} />
      {props.level === "DENY" && <Text style={ui.muted}>Starting a shift needs a manager.</Text>}
      {props.blocked && <Text style={ui.muted}>{props.blocked}</Text>}
      {error && <Text style={ui.error}>{error}</Text>}
      <Button
        title={`Start shift${count.total !== undefined ? ` with ${formatCents(count.total)}` : ""}${props.level === "PIN" ? " · PIN" : ""}`}
        kind="good"
        onPress={start}
        busy={busy}
        disabled={count.total === undefined || props.level === "DENY" || !!props.blocked}
      />
    </View>
  );
}

// ─── Open drawer: breakdown, movements ───────────────────────────

function Row({ label, value, big, color }: { label: string; value: number | string; big?: boolean; color?: string }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
      <Text style={[big ? ui.h2 : ui.muted, { flex: 1 }]}>{label}</Text>
      <Text style={[big ? ui.h2 : ui.text, color ? { color } : null]}>{typeof value === "number" ? formatCents(value) : value}</Text>
    </View>
  );
}

/** Where the cash in the drawer came from (the expected amount, or a report's cash section). */
function CashRows({ cash }: { cash: Partial<DrawerExpected> }) {
  return (
    <View style={{ gap: 4 }}>
      <Row label="Opening float" value={cash.openingFloatCents ?? 0} />
      <Row label="Cash sales" value={cash.cashSalesCents ?? 0} />
      {!!cash.cashRefundsCents && <Row label="Cash refunds" value={-cash.cashRefundsCents} />}
      {!!cash.tradeInCashCents && <Row label="Trade-in payouts" value={-cash.tradeInCashCents} />}
      {!!cash.paidInCents && <Row label="Paid in" value={cash.paidInCents} />}
      {!!cash.paidOutCents && <Row label="Paid out" value={-cash.paidOutCents} />}
      {!!cash.dropCents && <Row label="Safe drops" value={-cash.dropCents} />}
      <Row label="Expected in drawer" value={cash.expectedCents ?? 0} big />
    </View>
  );
}

function Movements({ movements }: { movements: CashMovement[] }) {
  if (movements.length === 0) return <Text style={ui.muted}>No cash in or out yet this shift.</Text>;
  const rows = [...movements].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <View>
      <Text style={ui.h2}>Cash in / out</Text>
      {rows.map((m) => (
        <View key={m.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
            <Text style={[ui.text, { flex: 1 }]} numberOfLines={1}>
              {KIND_LABEL[m.kind]} · {m.reason}
            </Text>
            <Text style={[ui.text, { color: m.kind === "PAID_IN" ? colors.good : colors.text }]}>
              {m.kind === "PAID_IN" ? "+" : "−"}
              {formatCents(m.amountCents)}
            </Text>
          </View>
          <Text style={ui.muted}>{[m.staff?.name, timeOf(m.createdAt), m.note].filter(Boolean).join(" · ")}</Text>
        </View>
      ))}
    </View>
  );
}

// ─── Paid in / paid out / safe drop ──────────────────────────────

function MovementSheet(props: {
  kind: CashMovementKind;
  level: PermissionLevel;
  onSubmit: (amountCents: number, reason: string, note: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { dialog } = useLayout();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState(props.kind === "DROP" ? "Safe drop" : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountCents = cents(amount);
  const valid = amountCents !== undefined && amountCents > 0 && reason.trim() !== "";

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      if (await props.onSubmit(amountCents, reason.trim(), note.trim())) props.onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: dialog(460), maxHeight: "90%", flexGrow: 0 }]} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
          <Text style={ui.h1}>{KIND_LABEL[props.kind]}</Text>
          <Text style={ui.muted}>
            {props.kind === "PAID_IN" ? "Cash added to the drawer besides sales." : props.kind === "PAID_OUT" ? "Cash taken from the drawer to pay for something." : "Cash moved from the drawer to the safe."}
            {props.level === "PIN" ? " Needs a manager's PIN." : ""}
          </Text>
          <TextInput
            style={[ui.input, { fontSize: 22 }]}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="Amount"
            placeholderTextColor={colors.muted}
            autoFocus
          />
          <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
            {REASONS[props.kind].map((r) => (
              <Pressable key={r} onPress={() => setReason(r)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: reason === r ? colors.accent : colors.panelAlt }}>
                <Text style={ui.text}>{r}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput style={ui.input} value={reason} onChangeText={setReason} placeholder="Reason" placeholderTextColor={colors.muted} />
          <TextInput style={ui.input} value={note} onChangeText={setNote} placeholder="Note (optional)" placeholderTextColor={colors.muted} />
          {error && <Text style={ui.error}>{error}</Text>}
          <View style={[ui.row, { gap: 8 }]}>
            <Button title="Cancel" kind="secondary" onPress={props.onClose} disabled={busy} />
            <Button title={amountCents ? `${KIND_LABEL[props.kind]} ${formatCents(amountCents)}` : KIND_LABEL[props.kind]} onPress={submit} disabled={!valid} busy={busy} style={{ flex: 1 }} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Reports ─────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={ui.h2}>{title}</Text>
      {children}
    </View>
  );
}

const tenderName = (t: string) => (t === "LOYALTY" ? "Rewards" : t.charAt(0) + t.slice(1).toLowerCase().replace("_", " "));

/** Sales, tenders, cash (when the store shows it), trade-ins and by employee. */
function ReportView({ report, expected }: { report: DrawerReport | null | undefined; expected?: DrawerExpected | null }) {
  if (!report) return <Text style={ui.muted}>No report yet.</Text>;
  const s = report.sales;
  const cash = expected ?? report;
  const t = report.tradeIns;
  return (
    <View style={{ gap: 14 }}>
      {s && (
        <Section title="Sales">
          <Row label="Orders" value={`${s.orders.toLocaleString()} · ${s.units.toLocaleString()} items`} />
          <Row label="Gross" value={s.grossCents} />
          {!!s.discountCents && <Row label="Discounts" value={-s.discountCents} />}
          <Row label="Net sales" value={s.netSalesCents} />
          <Row label="Tax" value={s.taxCents} />
          {!!s.refundedCents && <Row label="Refunded" value={-s.refundedCents} />}
          <Row label="Collected" value={s.collectedCents} big />
        </Section>
      )}
      {!!report.tenders?.length && (
        <Section title="Tenders">
          {report.tenders.map((x) => (
            <Row key={x.tender} label={`${tenderName(x.tender)} (${x.count})`} value={x.netCents} />
          ))}
        </Section>
      )}
      {typeof cash?.expectedCents === "number" && (
        <Section title="Cash">
          <CashRows cash={cash} />
        </Section>
      )}
      {t && (typeof t.tickets === "number" || typeof t.cashCents === "number" || typeof t.creditCents === "number") && (
        <Section title="Trade-ins">
          {typeof t.tickets === "number" && <Row label="Tickets" value={t.tickets.toLocaleString()} />}
          {typeof t.cashCents === "number" && <Row label="Paid in cash" value={t.cashCents} />}
          {typeof t.creditCents === "number" && <Row label="Paid in store credit" value={t.creditCents} />}
        </Section>
      )}
      {!!report.byEmployee?.length && (
        <Section title="By employee">
          {report.byEmployee.map((e) => (
            <Row key={e.staff} label={`${e.staff} · ${e.orders.toLocaleString()} orders`} value={e.netCents} />
          ))}
        </Section>
      )}
    </View>
  );
}

/** Web: the HTML report in a new tab. Device: the register's receipt printer, or the system print dialog. */
function PrintReport({ sessionId, terminal }: { sessionId: string; terminal: Terminal | null }) {
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<string>) =>
    fn()
      .then(setMsg)
      .catch((e) => setMsg(errorMessage(e)));
  const htmlPath = `/drawer/${sessionId}/report?format=html`;
  return (
    <View style={{ gap: 6 }}>
      <View style={[ui.row, { gap: 8 }]}>
        {Platform.OS === "web" ? (
          <Button title="Print" kind="secondary" style={{ flex: 1 }} onPress={() => run(async () => (await openDocument(htmlPath), "Opened in a new tab"))} />
        ) : (
          <>
            {terminal && (
              <Button
                title="Print"
                kind="secondary"
                style={{ flex: 1 }}
                onPress={() => run(async () => (await api("POST", `/drawer/${sessionId}/report/print`, { terminalId: terminal.id }), "Printing on the receipt printer"))}
              />
            )}
            <Button
              title={terminal ? "Other printer…" : "Print"}
              kind="secondary"
              style={{ flex: 1 }}
              onPress={() => run(async () => (await Print.printAsync({ html: await apiText("GET", htmlPath) }), "Sent to the printer"))}
            />
          </>
        )}
      </View>
      {msg && <Text style={ui.muted}>{msg}</Text>}
    </View>
  );
}

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/** The X report for an open drawer: what the Z report would say if it closed now. */
function ReportModal(props: { session: DrawerSession; terminal: Terminal | null; onClose: () => void }) {
  const { dialog } = useLayout();
  const [full, setFull] = useState<DrawerSession | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [asText, setAsText] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DrawerSession>("GET", `/drawer/${props.session.id}`)
      .then(setFull)
      .catch((e) => setError(errorMessage(e)));
  }, [props.session.id]);
  useEffect(() => {
    if (!asText || text !== null) return;
    apiText("GET", `/drawer/${props.session.id}/report?format=text`)
      .then(setText)
      .catch((e) => setError(errorMessage(e)));
  }, [asText, text, props.session.id]);

  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: dialog(520), maxHeight: "90%", flexGrow: 0 }]} contentContainerStyle={{ gap: 12 }}>
          <View style={[ui.row, { justifyContent: "space-between" }]}>
            <Text style={ui.h1}>X report · Drawer #{props.session.number}</Text>
            {Platform.OS !== "web" && (
              <Pressable onPress={() => setAsText((x) => !x)}>
                <Text style={{ color: colors.link }}>{asText ? "Summary" : "Receipt view"}</Text>
              </Pressable>
            )}
          </View>
          <Text style={ui.muted}>Open since {timeOf(props.session.openedAt)} · as of now</Text>
          {error && <Text style={ui.error}>{error}</Text>}
          {asText ? (
            text === null ? (
              <Text style={ui.muted}>Loading…</Text>
            ) : (
              <Text style={{ color: colors.text, fontFamily: mono, fontSize: 12 }}>{text}</Text>
            )
          ) : !full ? (
            <Text style={ui.muted}>Loading…</Text>
          ) : (
            <ReportView report={full.report ?? full.closingReport} expected={full.expected} />
          )}
          <PrintReport sessionId={props.session.id} terminal={props.terminal} />
          <Button title="Close" kind="secondary" onPress={props.onClose} />
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Close drawer ────────────────────────────────────────────────

function CloseSheet(props: {
  session: DrawerSession;
  /** Null for a blind count: the expected amount is only shown after the count is in. */
  expected: DrawerExpected | null;
  level: PermissionLevel;
  onSubmit: (countedCashCents: number, closingCount: CashCounts | undefined, notes: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { dialog } = useLayout();
  const [count, setCount] = useState<{ total: number | undefined; counts: CashCounts | undefined }>({ total: 0, counts: {} });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const variance = props.expected && count.total !== undefined ? count.total - props.expected.expectedCents : null;

  async function submit() {
    if (count.total === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(count.total, count.counts, notes.trim());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: dialog(520), maxHeight: "90%", flexGrow: 0 }]} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
          <Text style={ui.h1}>Close drawer #{props.session.number}</Text>
          <Text style={ui.muted}>
            {props.expected ? "Count all the cash in the drawer, including the float." : "Blind count: count all the cash in the drawer, including the float. The expected amount is shown after."}
            {props.level === "PIN" ? " Closing needs a manager's PIN." : ""}
          </Text>
          <CountInput placeholder="Cash in drawer, e.g. 843.50" onChange={(total, counts) => setCount({ total, counts })} />
          {props.expected && (
            <View style={{ gap: 4 }}>
              <Row label="Expected" value={props.expected.expectedCents} />
              {variance !== null && <VarianceRow variance={variance} />}
            </View>
          )}
          <TextInput style={ui.input} value={notes} onChangeText={setNotes} placeholder="Notes (optional)" placeholderTextColor={colors.muted} />
          {error && <Text style={ui.error}>{error}</Text>}
          <View style={[ui.row, { gap: 8 }]}>
            <Button title="Cancel" kind="secondary" onPress={props.onClose} disabled={busy} />
            <Button
              title={count.total !== undefined ? `Close with ${formatCents(count.total)}` : "Close drawer"}
              kind="danger"
              onPress={submit}
              disabled={count.total === undefined}
              busy={busy}
              style={{ flex: 1 }}
            />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

/** Red when short, green when over. */
function VarianceRow({ variance, big }: { variance: number; big?: boolean }) {
  const color = variance < 0 ? colors.bad : variance > 0 ? colors.good : colors.muted;
  const text = variance === 0 ? "Balanced" : `${variance < 0 ? "Short" : "Over"} ${formatCents(Math.abs(variance))}`;
  return <Row label="Variance" value={text} color={color} big={big} />;
}

/** After closing: the count against expected, and the closing (Z) report. */
function ClosedResult(props: { session: DrawerSession; terminal: Terminal | null; onDone: () => void }) {
  const { dialog } = useLayout();
  const s = props.session;
  return (
    <Modal transparent animationType="fade" onRequestClose={props.onDone}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: dialog(520), maxHeight: "90%", flexGrow: 0 }]} contentContainerStyle={{ gap: 12 }}>
          <Text style={ui.h1}>Drawer #{s.number} closed</Text>
          <Text style={ui.muted}>
            {timeOf(s.openedAt)} – {s.closedAt ? timeOf(s.closedAt) : "now"}
            {s.closedBy?.name ? ` · closed by ${s.closedBy.name}` : ""}
          </Text>
          <View style={{ gap: 4 }}>
            <Row label="Expected" value={s.expectedCashCents ?? 0} />
            <Row label="Counted" value={s.countedCashCents ?? 0} />
            <VarianceRow variance={s.varianceCents ?? (s.countedCashCents ?? 0) - (s.expectedCashCents ?? 0)} big />
          </View>
          {!!s.notes && <Text style={ui.muted}>{s.notes}</Text>}
          <ReportView report={s.closingReport ?? s.report} expected={s.expected} />
          <PrintReport sessionId={s.id} terminal={props.terminal} />
          <Button title="Done" kind="good" onPress={props.onDone} />
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Time clock ──────────────────────────────────────────────────

interface ClockedIn {
  staffId: string;
  name: string;
  since: string;
}

/** Clock in / out for the signed-in employee, and who's on the clock at this store. */
function TimeClock() {
  const { location, staff } = useSession();
  const status = useClockStatus();
  const [people, setPeople] = useState<ClockedIn[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPeople = useCallback(
    () =>
      api<ClockedIn[]>("GET", `/time/clocked-in?locationId=${location.id}`)
        .then(setPeople)
        .catch(() => {}),
    [location.id],
  );
  useEffect(() => {
    loadPeople();
    const t = setInterval(loadPeople, 60_000);
    return () => clearInterval(t);
  }, [loadPeople]);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (status?.entry) await api("POST", "/time/clock-out");
      else await api("POST", "/time/clock-in", { locationId: location.id });
      refreshClockStatus();
      await loadPeople();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }}>
      <Text style={ui.h1}>Time clock</Text>
      <View style={{ gap: 2 }}>
        <Text style={ui.h2}>{staff.name}</Text>
        <Text style={[ui.muted, status?.entry ? { color: colors.good } : null]}>
          {!status
            ? "Checking…"
            : status.entry
              ? `Clocked in at ${timeOf(status.entry.clockIn)} · ${hoursMinutes(minutesSince(status.entry.clockIn))}`
              : "Not clocked in"}
          {status?.today ? ` · ${hoursMinutes(status.today.minutes)} today` : ""}
        </Text>
      </View>
      <Button title={status?.entry ? "Clock out" : "Clock in"} kind={status?.entry ? "secondary" : "good"} onPress={toggle} busy={busy} disabled={!status} />
      {error && <Text style={ui.error}>{error}</Text>}
      <Text style={ui.h2}>Who's clocked in</Text>
      {!people ? (
        <Text style={ui.muted}>Loading…</Text>
      ) : people.length === 0 ? (
        <Text style={ui.muted}>Nobody is clocked in at {location.name}.</Text>
      ) : (
        people.map((p) => (
          <View key={p.staffId} style={[ui.row, { justifyContent: "space-between", gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
            <Text style={[ui.text, { flex: 1 }]} numberOfLines={1}>
              {p.name}
              {p.staffId === staff.id ? " (you)" : ""}
            </Text>
            <Text style={ui.muted}>
              since {timeOf(p.since)} · {hoursMinutes(minutesSince(p.since))}
            </Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}
