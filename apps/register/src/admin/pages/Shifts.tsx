import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { api, ApiError, getToken } from "../../api";
import { useGuard } from "../../approval";
import { Button } from "../../components/Button";
import { useLayout } from "../../layout";
import { useCan, useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Badge, Card, Chips, DateRangePicker, downloadCsv, Field, Input, money, openDocument, PRESETS, Stat, Table, when, type Column, type DateRange } from "../ui";
import { KeyValues } from "./Reports";

type Status = "OPEN" | "CLOSED";
type Kind = "PAID_IN" | "PAID_OUT" | "DROP";

/**
 * One drawer session as this page shows it. The API has two shapes — session
 * objects from /drawer/* (nested names, openingFloatCents…) and flat shift
 * rows from /reports/* (string names, floatCents…) — and `normalize` folds
 * both into this.
 */
interface Session {
  id: string;
  number: number;
  status: Status;
  register: string;
  openedBy: string;
  openedAt: string;
  closedBy: string;
  closedAt: string | null;
  floatCents: number;
  expectedCents: number | null;
  countedCents: number | null;
  /** counted − expected (negative = short). */
  varianceCents: number | null;
  approvedBy: string;
  notes: string | null;
  /** Cash in and out, when the endpoint gives it (shift rows do). */
  cashSalesCents: number | null;
  cashRefundsCents: number | null;
  tradeInCashCents: number | null;
  paidInCents: number | null;
  paidOutCents: number | null;
  dropCents: number | null;
}
interface Movement {
  id: string;
  kind: Kind;
  amountCents: number;
  reason: string;
  note?: string | null;
  createdAt: string;
  staff?: { name: string } | null;
  approver?: { name: string } | null;
}
/** How the expected cash in the drawer was built up. */
interface Expected {
  openingFloatCents: number;
  cashSalesCents: number;
  cashRefundsCents: number;
  tradeInCashCents: number;
  paidInCents: number;
  paidOutCents: number;
  dropCents: number;
  expectedCents: number;
}
interface Tender {
  tender: string;
  count: number;
  netCents: number;
}
/** The X (open) or Z (closed) report; tenders live under sales.byTender on the server's shape. */
interface Report {
  sales?: Record<string, unknown> & { byTender?: { tender: string; count: number; amountCents?: number; netCents?: number }[]; tradeIns?: Record<string, unknown> };
  tenders?: Tender[];
  tradeIns?: Record<string, unknown>;
  byEmployee?: { staffId?: string; staff?: string; name?: string; orders: number; netCents: number }[];
}
interface Detail extends Session {
  movements: Movement[];
  expected: Expected | null;
  report: Report | null;
}
interface DayTotals {
  floatCents: number;
  cashSalesCents: number;
  cashRefundsCents: number;
  tradeInCashCents: number;
  paidInCents: number;
  paidOutCents: number;
  dropCents: number;
  expectedCents: number;
  countedCents: number;
  varianceCents: number;
}
interface DayReport {
  date: string;
  sessions: Session[];
  totals: DayTotals;
  sales?: Record<string, unknown>;
  tenders?: Tender[];
}

const nameOf = (x: unknown): string => (typeof x === "string" ? x : x && typeof x === "object" && "name" in x ? String((x as { name?: unknown }).name ?? "") : "");
const num = (...xs: unknown[]): number | null => xs.find((x): x is number => typeof x === "number") ?? null;
function normalize(r: any): Session {
  return {
    id: String(r.id ?? r.number),
    number: Number(r.number) || 0,
    status: r.status === "OPEN" ? "OPEN" : "CLOSED",
    register: r.terminal?.name ?? r.terminalName ?? r.register ?? (r.terminalId ? "Register" : "Main drawer"),
    openedBy: nameOf(r.openedBy),
    openedAt: String(r.openedAt ?? ""),
    closedBy: nameOf(r.closedBy),
    closedAt: r.closedAt ? String(r.closedAt) : null,
    floatCents: num(r.openingFloatCents, r.floatCents) ?? 0,
    expectedCents: num(r.expectedCashCents, r.expectedCents, r.expected?.expectedCents),
    countedCents: num(r.countedCashCents, r.countedCents),
    varianceCents: num(r.varianceCents),
    approvedBy: nameOf(r.approvedBy),
    notes: typeof r.notes === "string" ? r.notes : null,
    cashSalesCents: num(r.cashSalesCents, r.expected?.cashSalesCents),
    cashRefundsCents: num(r.cashRefundsCents, r.expected?.cashRefundsCents),
    tradeInCashCents: num(r.tradeInCashCents, r.expected?.tradeInCashCents),
    paidInCents: num(r.paidInCents, r.expected?.paidInCents),
    paidOutCents: num(r.paidOutCents, r.expected?.paidOutCents),
    dropCents: num(r.dropCents, r.expected?.dropCents),
  };
}
const normalizeDetail = (r: any): Detail => ({ ...normalize(r), movements: Array.isArray(r.movements) ? r.movements : [], expected: r.expected ?? null, report: r.report ?? null });
const normalizeDay = (r: any): DayReport => ({ date: String(r.date ?? ""), sessions: (Array.isArray(r.sessions) ? r.sessions : []).map(normalize), totals: r.totals ?? {}, sales: r.sales, tenders: Array.isArray(r.tenders) ? r.tenders : [] });
const reportTenders = (r: Report): Tender[] => r.tenders ?? (r.sales?.byTender ?? []).map((t) => ({ tender: t.tender, count: t.count, netCents: t.netCents ?? t.amountCents ?? 0 }));

const KIND: Record<Kind, string> = { PAID_IN: "Paid in", PAID_OUT: "Paid out", DROP: "Safe drop" };
const tenderName = (t: string) => t.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const statusBadge = (s: Status) => <Badge text={s === "OPEN" ? "open" : "closed"} tone={s === "OPEN" ? "warn" : "good"} />;
const varianceText = (c: number | null | undefined) => (c == null ? "" : c === 0 ? "exact" : c < 0 ? `short ${money(-c)}` : `over ${money(c)}`);
const pad = (n: number) => String(n).padStart(2, "0");
/** Local "YYYY-MM-DD". */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shiftDay = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};
const niceDay = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
/** Whole cents from a dollars field; null when blank or not a number. */
const dollars = (s: string) => {
  if (!s.trim()) return null;
  const n = Math.round(Number(s) * 100);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Short in red, over in amber, exact in green. */
function Variance({ cents, right = true }: { cents: number | null | undefined; right?: boolean }) {
  if (cents == null) return <Text style={[ui.muted, right && { textAlign: "right" }]}>—</Text>;
  const color = cents === 0 ? colors.good : cents < 0 ? colors.bad : colors.warn;
  return <Text style={[ui.text, { color, fontWeight: "600" }, right && { textAlign: "right" }]}>{cents === 0 ? "exact" : `${cents < 0 ? "−" : "+"}${money(Math.abs(cents))}`}</Text>;
}

function Line({ label, value, bold, sign }: { label: string; value: ReactNode; bold?: boolean; sign?: "+" | "−" }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between", gap: 12 }]}>
      <Text style={bold ? ui.text : ui.muted}>
        {sign ? `${sign} ` : ""}
        {label}
      </Text>
      {typeof value === "string" ? <Text style={[ui.text, bold && { fontWeight: "700" }]}>{value}</Text> : value}
    </View>
  );
}

/** The columns every list of sessions shares. */
const sessionColumns = (withStatus: boolean): Column<Session>[] => [
  { key: "n", label: "Drawer #", render: (s) => `#${s.number}`, width: 80 },
  { key: "r", label: "Register", render: (s) => s.register, width: 120 },
  ...(withStatus ? [{ key: "s", label: "Status", render: (s: Session) => statusBadge(s.status), width: 80 }] : []),
  { key: "ob", label: "Opened by", render: (s) => s.openedBy, width: 120 },
  { key: "oa", label: "Opened", render: (s) => (s.openedAt ? when(s.openedAt) : ""), width: 160 },
  { key: "cb", label: "Closed by", render: (s) => s.closedBy, width: 120 },
  { key: "ca", label: "Closed", render: (s) => (s.closedAt ? when(s.closedAt) : ""), width: 160 },
  { key: "f", label: "Float", render: (s) => money(s.floatCents), width: 90, align: "right" },
  { key: "e", label: "Expected", render: (s) => money(s.expectedCents), width: 90, align: "right" },
  { key: "c", label: "Counted", render: (s) => money(s.countedCents), width: 90, align: "right" },
  { key: "v", label: "Variance", render: (s) => <Variance cents={s.varianceCents} />, width: 90, align: "right" },
  { key: "a", label: "Approved by", render: (s) => s.approvedBy, width: 120 },
];

/** Cash drawers: the end-of-day close-out and every drawer session. */
export function Shifts() {
  const [view, setView] = useState<"daily" | "sessions">("daily");
  const [picked, setPicked] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const changed = () => setTick((t) => t + 1);

  if (picked) return <SessionDetail id={picked} onBack={() => setPicked(null)} onChanged={changed} />;
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Chips options={[["daily", "Daily close"], ["sessions", "Drawer sessions"]]} value={view} onChange={(v) => setView(v as never)} />
      {view === "daily" ? <DailyClose tick={tick} onOpen={setPicked} onChanged={changed} /> : <Sessions tick={tick} onOpen={setPicked} />}
    </ScrollView>
  );
}

function Step({ n, title, done, status, children }: { n: number; title: string; done: boolean; status?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
      <View style={[ui.row, { gap: 10 }]}>
        <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: done ? colors.good : colors.panelAlt }}>
          <Text style={{ color: done ? "#ffffff" : colors.text, fontWeight: "700", fontSize: 13 }}>{done ? "✓" : n}</Text>
        </View>
        <Text style={[ui.h2, { flex: 1 }]}>{title}</Text>
        {status && <Badge text={status} tone={done ? "good" : "warn"} />}
      </View>
      {children}
    </View>
  );
}

/** The printable day report: the same numbers as the page, as plain HTML. */
function dayReportHtml(d: DayReport, where: string) {
  const cell = (v: unknown, right = false) => `<td${right ? ' class="r"' : ""}>${esc(v)}</td>`;
  const open = d.sessions.filter((s) => s.status === "OPEN").length;
  const sessions = d.sessions
    .map((s) => `<tr>${cell(`#${s.number}`)}${cell(s.register)}${cell(s.status.toLowerCase())}${cell(s.openedBy)}${cell(s.openedAt ? when(s.openedAt) : "")}${cell(s.closedBy)}${cell(s.closedAt ? when(s.closedAt) : "")}${cell(money(s.floatCents), true)}${cell(money(s.expectedCents), true)}${cell(money(s.countedCents), true)}${cell(varianceText(s.varianceCents), true)}${cell(s.approvedBy)}</tr>`)
    .join("");
  const t = d.totals;
  const totals = [
    ["Opening floats", t.floatCents],
    ["Cash sales", t.cashSalesCents],
    ["Cash refunds", -t.cashRefundsCents],
    ["Trade-in cash paid", -t.tradeInCashCents],
    ["Paid in", t.paidInCents],
    ["Paid out", -t.paidOutCents],
    ["Safe drops", -t.dropCents],
    ["Expected in drawers", t.expectedCents],
    ["Counted", t.countedCents],
  ]
    .map(([k, v]) => `<tr>${cell(k)}${cell(money(Number(v) || 0), true)}</tr>`)
    .join("");
  const sales = Object.entries(d.sales ?? {})
    .filter(([, v]) => typeof v !== "object")
    .map(([k, v]) => `<tr>${cell(k.replace(/Cents$/, "").replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()))}${cell(k.endsWith("Cents") ? money(Number(v)) : String(v), true)}</tr>`)
    .join("");
  const tenders = (d.tenders ?? []).map((x) => `<tr>${cell(tenderName(x.tender))}${cell(x.count, true)}${cell(money(x.netCents), true)}</tr>`).join("");
  const body = `<h1>Daily close · ${esc(niceDay(d.date))}</h1><p class="muted">${esc(where)} · printed ${esc(when(new Date()))}</p>
<h2>Drawers${open ? ` (${open} still open)` : ""}</h2><table><tr><th>#</th><th>Register</th><th>Status</th><th>Opened by</th><th>Opened</th><th>Closed by</th><th>Closed</th><th class="r">Float</th><th class="r">Expected</th><th class="r">Counted</th><th class="r">Variance</th><th>Approved by</th></tr>${sessions || '<tr><td colspan="12">No drawers were opened.</td></tr>'}</table>
<h2>Cash</h2><table>${totals}<tr><th>Variance</th><th class="r">${esc(varianceText(t.varianceCents) || "—")}</th></tr><tr><th>To deposit (drops + counted − floats)</th><th class="r">${esc(money((t.dropCents ?? 0) + (t.countedCents ?? 0) - (t.floatCents ?? 0)))}</th></tr></table>
<h2>Sales</h2><table>${sales || '<tr><td colspan="2">No sales.</td></tr>'}</table>
<h2>Payments</h2><table><tr><th>Tender</th><th class="r">Count</th><th class="r">Net</th></tr>${tenders || '<tr><td colspan="3">No payments.</td></tr>'}</table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Daily close ${esc(d.date)}</title><style>body{font:14px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 6px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #ddd;font-size:13px;vertical-align:top}th{font-weight:600}td.r,th.r{text-align:right}.muted{color:#666}@media print{body{margin:0}}</style></head><body>${body}</body></html>`;
}

/** Open a built HTML page in a new tab and print it (browser only). */
function printHtml(html: string) {
  if (Platform.OS !== "web") return;
  const w = window.open("", "_blank");
  if (!w) throw new Error("Allow pop-ups to print");
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

/** The end-of-day checklist: close every drawer, check the counts, bank the cash, read the totals. */
function DailyClose({ tick, onOpen, onChanged }: { tick: number; onOpen: (id: string) => void; onChanged: () => void }) {
  const { location } = useSession();
  const can = useCan();
  const { narrow } = useLayout();
  const [date, setDate] = useState(localDay(new Date()));
  const [scope, setScope] = useState<"here" | "all">("here");
  const [d, setD] = useState<DayReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const path = `/reports/daily-close?date=${date}${scope === "here" ? `&locationId=${location.id}` : ""}`;
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    api("GET", path)
      .then((r) => live && setD(normalizeDay(r)))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [path, tick]);

  const alert = (location as { cashVarianceAlertCents?: number }).cashVarianceAlertCents ?? 0;
  const sessions = d?.sessions ?? [];
  const open = sessions.filter((s) => s.status === "OPEN");
  const closed = sessions.filter((s) => s.status === "CLOSED");
  // Closed off by more than the alert and nobody accepted it: worth a look.
  const flagged = closed.filter((s) => s.varianceCents != null && Math.abs(s.varianceCents) > alert && !s.approvedBy);
  const sum = (list: Session[], f: (s: Session) => number | null) => list.reduce((a, s) => a + (f(s) ?? 0), 0);
  const drops = sum(sessions, (s) => s.dropCents);
  const countedLessFloat = sum(closed, (s) => (s.countedCents ?? 0) - s.floatCents);
  const paidIn = sum(sessions, (s) => s.paidInCents);
  const paidOut = sum(sessions, (s) => s.paidOutCents);
  const allClosed = open.length === 0;
  const isToday = date === localDay(new Date());
  const where = scope === "here" ? location.name : "All locations";

  const print = () => {
    if (!d) return;
    setMessage(null);
    try {
      printHtml(dayReportHtml(d, where));
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <>
      <Card title="Daily close">
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button title="◀" kind="secondary" style={{ minHeight: 40, paddingVertical: 8, paddingHorizontal: 14 }} onPress={() => setDate(shiftDay(date, -1))} />
          <Text style={[ui.h2, { flexShrink: 1 }]}>{niceDay(date)}</Text>
          <Button title="▶" kind="secondary" style={{ minHeight: 40, paddingVertical: 8, paddingHorizontal: 14 }} onPress={() => setDate(shiftDay(date, 1))} disabled={isToday} />
          {!isToday && <Button title="Today" kind="secondary" style={{ minHeight: 40, paddingVertical: 8 }} onPress={() => setDate(localDay(new Date()))} />}
        </View>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Chips options={[["here", location.name], ["all", "All locations"]]} value={scope} onChange={(s) => setScope(s as never)} />
          <View style={[ui.row, { gap: 8, flexWrap: "wrap", marginLeft: narrow ? 0 : "auto" }]}>
            <Button title="Print day report" kind="secondary" style={{ minHeight: 40, paddingVertical: 8 }} onPress={print} disabled={!d} />
            {Platform.OS === "web" && <Button title="Download CSV" kind="secondary" style={{ minHeight: 40, paddingVertical: 8 }} onPress={() => downloadCsv(path, getToken())} disabled={!d} />}
          </View>
        </View>
        {error && <Text style={ui.error}>{error}</Text>}
        {message && <Text style={ui.text}>{message}</Text>}
        {!d && busy && <Text style={ui.muted}>Loading…</Text>}
      </Card>

      {d && (
        <Card title="Close-out checklist">
          <Text style={ui.muted}>Work down the list at the end of the day. Floats stay in the drawers for tomorrow; drops and the rest of the counted cash go to the bank.</Text>

          <Step n={1} title="Every drawer closed" done={allClosed} status={allClosed ? (sessions.length ? "done" : "no drawers") : `${open.length} open`}>
            {open.length === 0 ? (
              <Text style={ui.muted}>{sessions.length ? "All drawers are closed." : "No drawers were opened on this day."}</Text>
            ) : (
              open.map((s) => (
                <View key={s.id} style={{ gap: 8, backgroundColor: colors.panelAlt, borderRadius: 8, padding: 10 }}>
                  <View style={[ui.row, { gap: 12, flexWrap: "wrap" }]}>
                    <View style={{ flex: 1, minWidth: 180 }}>
                      <Text style={ui.text}>
                        Drawer #{s.number} · {s.register}
                      </Text>
                      <Text style={ui.muted}>
                        Opened by {s.openedBy || "—"} at {s.openedAt ? when(s.openedAt) : "—"} · float {money(s.floatCents)}
                        {s.expectedCents != null ? ` · expected ${money(s.expectedCents)}` : ""}
                      </Text>
                    </View>
                    <View style={[ui.row, { gap: 8 }]}>
                      <Button title="Details" kind="secondary" style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => onOpen(s.id)} />
                      {can("DRAWER_OPEN_CLOSE") !== "DENY" && <Button title={closing === s.id ? "Cancel" : "Close now"} kind={closing === s.id ? "secondary" : "primary"} style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => setClosing(closing === s.id ? null : s.id)} />}
                    </View>
                  </View>
                  {closing === s.id && (
                    <CloseForm
                      session={s}
                      expected={s.expectedCents}
                      onCancel={() => setClosing(null)}
                      onDone={(r) => {
                        setClosing(null);
                        setMessage(`Drawer #${r.number} closed: ${varianceText(r.varianceCents) || "counted"}.`);
                        onChanged();
                      }}
                    />
                  )}
                </View>
              ))
            )}
          </Step>

          <Step n={2} title="Counts and variances" done={allClosed && flagged.length === 0} status={flagged.length ? `${flagged.length} to review` : closed.length ? "ok" : undefined}>
            {flagged.length > 0 && (
              <Text style={[ui.muted, { color: colors.warn }]}>
                {flagged.map((s) => `#${s.number} ${varianceText(s.varianceCents)}`).join(", ")} — off by more than {money(alert)} and not signed off by a manager.
              </Text>
            )}
            <Table<Session> rows={sessions} keyOf={(s) => s.id} onPress={(s) => onOpen(s.id)} columns={sessionColumns(true)} empty="No drawers on this day." />
          </Step>

          <Step n={3} title="Cash to deposit" done={allClosed && closed.length > 0} status={allClosed && closed.length > 0 ? money(drops + countedLessFloat) : undefined}>
            <View style={[ui.row, { flexWrap: "wrap", gap: 10 }]}>
              <Stat label="Safe drops" value={money(drops)} sub="taken to the safe during the day" />
              <Stat label="Counted less floats" value={money(countedLessFloat)} sub={`${closed.length} closed drawer${closed.length === 1 ? "" : "s"}`} />
              <Stat label="Paid in" value={money(paidIn)} />
              <Stat label="Paid out" value={money(paidOut)} tone={paidOut ? "warn" : undefined} />
              <Stat label="To deposit" value={money(drops + countedLessFloat)} sub="drops + counted − floats" tone="good" />
            </View>
            {open.length > 0 && <Text style={ui.muted}>Open drawers are left out until they are closed.</Text>}
          </Step>

          <Step n={4} title="Day totals" done={allClosed}>
            <View style={[narrow ? { gap: 12 } : [ui.row, { gap: 24, alignItems: "flex-start" }]]}>
              <View style={{ flex: 1, minWidth: 240 }}>
                <Text style={[ui.muted, { fontWeight: "600", marginBottom: 4 }]}>Sales</Text>
                {d.sales && Object.keys(d.sales).length ? <KeyValues obj={d.sales} /> : <Text style={ui.muted}>No sales.</Text>}
              </View>
              <View style={{ flex: 1, minWidth: 240 }}>
                <Text style={[ui.muted, { fontWeight: "600", marginBottom: 4 }]}>Payments</Text>
                <Table<Tender> rows={d.tenders ?? []} keyOf={(r) => r.tender} columns={[{ key: "t", label: "Tender", render: (r) => tenderName(r.tender), width: 140 }, { key: "c", label: "Count", render: (r) => r.count, width: 60, align: "right" }, { key: "n", label: "Net", render: (r) => money(r.netCents), width: 100, align: "right" }]} empty="No payments." />
              </View>
            </View>
          </Step>
        </Card>
      )}
    </>
  );
}

/** Every drawer session, filtered; tap one for its detail. */
function Sessions({ tick, onOpen }: { tick: number; onOpen: (id: string) => void }) {
  const { location } = useSession();
  const [status, setStatus] = useState("");
  const [range, setRange] = useState<DateRange>(PRESETS.last30!());
  const [scope, setScope] = useState<"here" | "all">("here");
  const [rows, setRows] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = `/drawer/sessions?take=200&from=${range.from.toISOString()}&to=${range.to.toISOString()}${status ? `&status=${status}` : ""}${scope === "here" ? `&locationId=${location.id}` : ""}`;
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    api<unknown[]>("GET", path)
      .then((r) => live && setRows((Array.isArray(r) ? r : []).map(normalize)))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [path, tick]);

  const openCount = rows.filter((s) => s.status === "OPEN").length;
  return (
    <>
      <Card title="Drawer sessions">
        <Chips options={[["OPEN", "Open"], ["CLOSED", "Closed"], ["", "All"]]} value={status} onChange={setStatus} />
        <DateRangePicker value={range} onChange={setRange} />
        <Chips options={[["here", location.name], ["all", "All locations"]]} value={scope} onChange={(s) => setScope(s as never)} />
        {error && <Text style={ui.error}>{error}</Text>}
      </Card>
      <Card title={`${rows.length} session${rows.length === 1 ? "" : "s"}${openCount ? ` · ${openCount} open` : ""}`}>
        <Table<Session> rows={rows} keyOf={(s) => s.id} onPress={(s) => onOpen(s.id)} columns={sessionColumns(true)} empty={busy ? "Loading…" : "No drawer sessions match."} />
      </Card>
    </>
  );
}

function SessionDetail({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const can = useCan();
  const { narrow } = useLayout();
  const [s, setS] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<"close" | "movement" | null>(null);

  const load = useCallback(
    () =>
      api("GET", `/drawer/${id}`)
        .then((r) => setS(normalizeDetail(r)))
        .catch((e) => setError(e instanceof ApiError ? e.message : String(e))),
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);

  const back = <Button title="← Shifts" kind="secondary" onPress={onBack} style={{ minHeight: 36, paddingVertical: 6, alignSelf: "flex-start" }} />;
  if (error) return <View style={{ padding: 12, gap: 12 }}>{back}<Text style={ui.error}>{error}</Text></View>;
  if (!s) return <View style={{ padding: 12, gap: 12 }}>{back}<Text style={ui.muted}>Loading…</Text></View>;

  const open = s.status === "OPEN";
  const x = s.expected;
  const r = s.report;
  const print = async () => {
    setMessage(null);
    try {
      await openDocument(`/drawer/${s.id}/report?format=html`);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  };
  const refresh = () => {
    load();
    onChanged();
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={[narrow ? { gap: 8 } : [ui.row, { gap: 12, flexWrap: "wrap" }]]}>
        <View style={[ui.row, { gap: 12, flexWrap: "wrap" }]}>
          {back}
          <Text style={ui.h1}>Drawer #{s.number}</Text>
          {statusBadge(s.status)}
        </View>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", marginLeft: narrow ? 0 : "auto" }]}>
          <Button title={open ? "Print X report" : "Print report"} kind="secondary" onPress={print} style={{ minHeight: 40, paddingVertical: 8 }} />
          {open && can("CASH_IN_OUT") !== "DENY" && <Button title="Paid in / out" kind="secondary" onPress={() => setForm(form === "movement" ? null : "movement")} style={{ minHeight: 40, paddingVertical: 8 }} />}
          {open && can("DRAWER_OPEN_CLOSE") !== "DENY" && <Button title="Close drawer" onPress={() => setForm(form === "close" ? null : "close")} style={{ minHeight: 40, paddingVertical: 8 }} />}
        </View>
      </View>
      {message && <Text style={ui.text}>{message}</Text>}

      <Card title="Details">
        <View style={[ui.row, { gap: 24, flexWrap: "wrap", alignItems: "flex-start" }]}>
          <Field label="Register"><Text style={ui.text}>{s.register}</Text></Field>
          <Field label="Opened">
            <Text style={ui.text}>{s.openedAt ? when(s.openedAt) : "—"}</Text>
            <Text style={ui.muted}>{s.openedBy || "—"}</Text>
          </Field>
          <Field label="Closed">
            <Text style={ui.text}>{s.closedAt ? when(s.closedAt) : "Still open"}</Text>
            {s.closedBy !== "" && <Text style={ui.muted}>{s.closedBy}</Text>}
          </Field>
          {s.approvedBy !== "" && <Field label="Variance accepted by"><Text style={ui.text}>{s.approvedBy}</Text></Field>}
          {s.notes ? <Field label="Notes"><Text style={ui.text}>{s.notes}</Text></Field> : null}
        </View>
      </Card>

      {form === "movement" && (
        <MovementForm
          sessionId={s.id}
          onCancel={() => setForm(null)}
          onDone={(m) => {
            setForm(null);
            setMessage(`${KIND[m.kind] ?? m.kind} ${money(m.amountCents)} recorded.`);
            refresh();
          }}
        />
      )}
      {form === "close" && (
        <CloseForm
          session={s}
          expected={x?.expectedCents ?? s.expectedCents}
          onCancel={() => setForm(null)}
          onDone={(c) => {
            setForm(null);
            setMessage(`Drawer closed: ${varianceText(c.varianceCents) || "counted"}${c.countedCents != null ? ` (${money(c.countedCents)} counted)` : ""}.`);
            refresh();
          }}
        />
      )}

      <Card title="Cash">
        {x ? (
          <>
            <Line label="Opening float" value={money(x.openingFloatCents)} sign="+" />
            <Line label="Cash sales" value={money(x.cashSalesCents)} sign="+" />
            <Line label="Cash refunds" value={money(x.cashRefundsCents)} sign="−" />
            <Line label="Trade-in cash paid" value={money(x.tradeInCashCents)} sign="−" />
            <Line label="Paid in" value={money(x.paidInCents)} sign="+" />
            <Line label="Paid out" value={money(x.paidOutCents)} sign="−" />
            <Line label="Safe drops" value={money(x.dropCents)} sign="−" />
            <Line label="Expected in drawer" value={money(x.expectedCents)} bold />
          </>
        ) : (
          <Line label="Opening float" value={money(s.floatCents)} />
        )}
        {!open && (
          <>
            {!x && <Line label="Expected" value={money(s.expectedCents)} />}
            <Line label="Counted" value={money(s.countedCents)} bold />
            <Line label="Variance" value={<Variance cents={s.varianceCents} />} bold />
          </>
        )}
        {open && !x && <Text style={ui.muted}>The count is blind: the expected amount shows once the drawer is closed, or to anyone who can view reports.</Text>}
      </Card>

      <Card title="Paid in, paid out, drops">
        <Table<Movement>
          rows={s.movements}
          keyOf={(m) => m.id}
          columns={[
            { key: "w", label: "When", render: (m) => when(m.createdAt), width: 160 },
            { key: "k", label: "Type", render: (m) => <Badge text={KIND[m.kind] ?? m.kind} tone={m.kind === "PAID_IN" ? "good" : m.kind === "DROP" ? "muted" : "warn"} />, width: 100 },
            { key: "a", label: "Amount", render: (m) => `${m.kind === "PAID_IN" ? "+" : "−"}${money(m.amountCents)}`, width: 90, align: "right" },
            { key: "r", label: "Reason", render: (m) => `${m.reason}${m.note ? ` · ${m.note}` : ""}`, width: 240 },
            { key: "s", label: "By", render: (m) => m.staff?.name ?? "", width: 120 },
            { key: "p", label: "Approved by", render: (m) => m.approver?.name ?? "", width: 120 },
          ]}
          empty="No cash in or out besides sales."
        />
      </Card>

      {r && (
        <>
          <Card title={open ? "So far this shift (X report)" : "Closing report"}>
            <View style={[narrow ? { gap: 12 } : [ui.row, { gap: 24, alignItems: "flex-start" }]]}>
              <View style={{ flex: 1, minWidth: 240 }}>
                <Text style={[ui.muted, { fontWeight: "600", marginBottom: 4 }]}>Sales</Text>
                {r.sales ? <KeyValues obj={r.sales} /> : <Text style={ui.muted}>No sales.</Text>}
                {(r.tradeIns ?? r.sales?.tradeIns) && (
                  <>
                    <Text style={[ui.muted, { fontWeight: "600", marginTop: 10, marginBottom: 4 }]}>Trade-ins</Text>
                    <KeyValues obj={(r.tradeIns ?? r.sales?.tradeIns)!} />
                  </>
                )}
              </View>
              <View style={{ flex: 1, minWidth: 240 }}>
                <Text style={[ui.muted, { fontWeight: "600", marginBottom: 4 }]}>Payments</Text>
                <Table<Tender> rows={reportTenders(r)} keyOf={(t) => t.tender} columns={[{ key: "t", label: "Tender", render: (t) => tenderName(t.tender), width: 140 }, { key: "c", label: "Count", render: (t) => t.count, width: 60, align: "right" }, { key: "n", label: "Net", render: (t) => money(t.netCents), width: 100, align: "right" }]} empty="No payments." />
              </View>
            </View>
          </Card>
          <Card title="By employee">
            <Table
              rows={r.byEmployee ?? []}
              keyOf={(e) => e.staffId ?? e.staff ?? e.name ?? ""}
              columns={[
                { key: "s", label: "Employee", render: (e) => e.staff ?? e.name ?? "", width: 180 },
                { key: "o", label: "Sales", render: (e) => e.orders, width: 70, align: "right" },
                { key: "n", label: "Net", render: (e) => money(e.netCents), width: 110, align: "right" },
              ]}
              empty="No sales on this drawer."
            />
          </Card>
        </>
      )}
    </ScrollView>
  );
}

/**
 * Count the cash and close. A count off by more than the store's alert amount
 * needs a manager to accept the variance (CASH_VARIANCE_OVERRIDE).
 */
function CloseForm({ session, expected, onDone, onCancel }: { session: Session; expected?: number | null; onDone: (s: Session) => void; onCancel: () => void }) {
  const guard = useGuard();
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = dollars(counted);
  const variance = cents != null && expected != null ? cents - expected : null;

  async function submit() {
    if (cents == null) return setError("Enter the cash counted in the drawer, in dollars.");
    setBusy(true);
    setError(null);
    const body = { countedCashCents: cents, notes: notes.trim() || undefined };
    const call = (token?: string) => api("POST", `/drawer/${session.id}/close`, body, { approvalToken: token }).then(normalize);
    try {
      let r: Session | undefined;
      try {
        r = await guard("DRAWER_OPEN_CLOSE", call);
      } catch (e) {
        const d = e instanceof ApiError ? (e.details as { permission?: string } | undefined) : undefined;
        if (!(e instanceof ApiError && e.code === "APPROVAL_REQUIRED" && d?.permission === "CASH_VARIANCE_OVERRIDE")) throw e;
        r = await guard("CASH_VARIANCE_OVERRIDE", call, { needsApproval: true });
      }
      if (r) onDone(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={ui.h2}>Close drawer #{session.number}</Text>
      <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
        <Field label="Cash counted ($)">
          <Input value={counted} onChange={setCounted} keyboard="decimal-pad" placeholder="0.00" />
        </Field>
        <Field label="Notes">
          <Input value={notes} onChange={setNotes} placeholder="Anything odd about the count" />
        </Field>
      </View>
      {expected != null && (
        <View style={[ui.row, { gap: 8 }]}>
          <Text style={ui.muted}>Expected {money(expected)}</Text>
          {variance != null && (
            <>
              <Text style={ui.muted}>·</Text>
              <Variance cents={variance} right={false} />
            </>
          )}
        </View>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button title="Close drawer" onPress={submit} busy={busy} disabled={cents == null} />
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    </View>
  );
}

/** Cash in or out of an open drawer besides sales: paid in, paid out, or a drop to the safe. */
function MovementForm({ sessionId, onDone, onCancel }: { sessionId: string; onDone: (m: Movement) => void; onCancel: () => void }) {
  const guard = useGuard();
  const [kind, setKind] = useState<Kind>("PAID_OUT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = dollars(amount);
  const ok = cents != null && cents > 0 && reason.trim() !== "";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const m = await guard("CASH_IN_OUT", (token) => api<Movement>("POST", `/drawer/${sessionId}/movements`, { kind, amountCents: cents, reason: reason.trim(), note: note.trim() || undefined }, { approvalToken: token }));
      if (m) onDone(m);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Paid in / paid out / safe drop">
      <Chips options={[["PAID_IN", "Paid in"], ["PAID_OUT", "Paid out"], ["DROP", "Safe drop"]]} value={kind} onChange={(k) => setKind(k as Kind)} />
      <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
        <Field label="Amount ($)">
          <Input value={amount} onChange={setAmount} keyboard="decimal-pad" placeholder="0.00" />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={setReason} placeholder={kind === "DROP" ? "e.g. Over $500 in drawer" : kind === "PAID_IN" ? "e.g. Change from the bank" : "e.g. Window cleaner"} />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={setNote} placeholder="Optional" />
        </Field>
      </View>
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button title={`Record ${KIND[kind].toLowerCase()}`} onPress={submit} busy={busy} disabled={!ok} />
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    </Card>
  );
}
