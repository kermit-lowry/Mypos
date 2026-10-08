import { useCallback, useEffect, useState } from "react";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import { api, ApiError } from "../../api";
import { useGuard } from "../../approval";
import { Button } from "../../components/Button";
import { Thumb } from "../../components/Thumb";
import { useLayout } from "../../layout";
import { useCan, useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Badge, Card, Chips, day, Field, Input, money, openDocument, Stat, Table, when } from "../ui";

type Status = "ACTIVE" | "COMPLETED" | "CANCELLED";

/** A row from GET /layaways; the detail adds lines, payments and totals. */
interface Layaway {
  id: string;
  number: number;
  status: Status;
  locationId: string;
  customerId: string;
  customer?: { id: string; name: string; email?: string | null; phone?: string | null } | null;
  staff?: { name: string } | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  overdue?: boolean;
  dueAt: string;
  createdAt: string;
  completedAt?: string | null;
  cancelledAt?: string | null;
  cancelFeeCents?: number;
  refundedCents?: number;
  /** A count, or the lines themselves. */
  lines?: number | { quantity: number }[];
}
interface Line {
  id: string;
  variantId: string;
  title: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  promoDiscountCents: number;
  taxable: boolean;
  variant?: { sku?: string | null; imageUrl?: string | null; product?: { title?: string; imageUrl?: string | null } | null } | null;
}
interface Payment {
  id: string;
  amountCents: number;
  /** The part that reduced the balance; the rest was the card-price adjustment. */
  appliedCents: number;
  tender: string;
  status: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
  changeCents?: number | null;
  createdAt: string;
  staff?: { name: string } | null;
}
interface Detail extends Omit<Layaway, "lines"> {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  cardPriceBps: number;
  cardAdjustmentCents: number;
  cardAdjustmentTaxCents: number;
  notes?: string | null;
  orderId?: string | null;
  orderNumber?: number | null;
  order?: { number: number } | null;
  cancelReason?: string | null;
  cancelFeePreview?: { feeCents: number; refundCents: number } | null;
  lines: Line[];
  payments: Payment[];
}
interface Stats {
  active: number;
  overdue: number;
  balanceCents: number;
  heldCents: number;
}

const STATUS: Record<Status, { text: string; tone: "good" | "bad" | "warn" | "muted" }> = {
  ACTIVE: { text: "active", tone: "warn" },
  COMPLETED: { text: "picked up", tone: "good" },
  CANCELLED: { text: "cancelled", tone: "muted" },
};
const TENDERS: Record<string, string> = { CARD: "Card", CASH: "Cash", CHECK: "Check", STORE_CREDIT: "Store credit", LOYALTY: "Rewards", GIFT_CARD: "Gift card", EXTERNAL: "Paid online" };
const tenderLabel = (p: Payment) => (p.cardLast4 ? `${p.cardBrand ?? "Card"} •••• ${p.cardLast4}` : (TENDERS[p.tender] ?? p.tender));
const statusBadge = (s: Status) => <Badge text={STATUS[s]?.text ?? String(s).toLowerCase()} tone={STATUS[s]?.tone} />;
const isOverdue = (l: Pick<Layaway, "status" | "overdue" | "dueAt">) => l.status === "ACTIVE" && (l.overdue ?? new Date(l.dueAt).getTime() < Date.now());
const itemCount = (l: Layaway) => (typeof l.lines === "number" ? l.lines : Array.isArray(l.lines) ? l.lines.reduce((a, x) => a + (Number(x.quantity) || 0), 0) : null);
const units = (lines: Line[]) => lines.reduce((a, l) => a + l.quantity, 0);
const saleNumber = (d: Detail) => d.orderNumber ?? d.order?.number ?? null;
const pad = (n: number) => String(n).padStart(2, "0");
/** Local "YYYY-MM-DD" (an ISO slice would give the UTC day). */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime());

function Row({ label, value, bold, color }: { label: string; value: string; bold?: boolean; color?: string }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between", gap: 12 }]}>
      <Text style={bold ? ui.text : ui.muted}>{label}</Text>
      <Text style={[ui.text, bold && { fontWeight: "700" }, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function DueDate({ l }: { l: Pick<Layaway, "status" | "overdue" | "dueAt"> }) {
  const late = isOverdue(l);
  return (
    <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
      <Text style={[ui.text, late && { color: colors.bad }]}>{day(l.dueAt)}</Text>
      {late && <Badge text="overdue" tone="bad" />}
    </View>
  );
}

/** Items held for customers against a deposit: who owes what, what's overdue, and the paperwork. */
export function Layaways() {
  const { location } = useSession();
  const can = useCan();
  const [filter, setFilter] = useState("active");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"here" | "all">("here");
  const [rows, setRows] = useState<Layaway[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const loc = scope === "here" ? `locationId=${location.id}` : "";
  const status = filter === "all" ? "" : filter === "overdue" ? "status=ACTIVE&overdue=true" : `status=${filter.toUpperCase()}`;
  const path = `/layaways?${["take=200", loc, status, search ? `q=${encodeURIComponent(search)}` : ""].filter(Boolean).join("&")}`;
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    api<Layaway[]>("GET", path)
      .then((r) => live && setRows(Array.isArray(r) ? r : []))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [path, tick]);

  // The header numbers come from the report, which needs VIEW_REPORTS; cashiers who only create layaways skip them.
  const showStats = can("VIEW_REPORTS") !== "DENY";
  useEffect(() => {
    if (!showStats) return;
    let live = true;
    api<Stats>("GET", `/reports/layaways${loc ? `?${loc}` : ""}`)
      .then((r) => live && setStats(r))
      .catch(() => live && setStats(null));
    return () => {
      live = false;
    };
  }, [loc, tick, showStats]);

  const find = () => {
    setSearch(q.trim());
    setTick((t) => t + 1);
  };

  if (picked) return <LayawayDetail id={picked} onBack={() => setPicked(null)} onChanged={() => setTick((t) => t + 1)} />;

  const balance = rows.reduce((a, l) => a + (l.status === "ACTIVE" ? l.balanceCents : 0), 0);
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      {stats && (
        <View style={[ui.row, { flexWrap: "wrap", gap: 10 }]}>
          <Stat label="Active" value={String(stats.active ?? 0)} />
          <Stat label="Overdue" value={String(stats.overdue ?? 0)} tone={stats.overdue ? "bad" : undefined} />
          <Stat label="Balance outstanding" value={money(stats.balanceCents ?? 0)} sub="still to be paid" />
          <Stat label="Deposits held" value={money(stats.heldCents ?? 0)} sub="paid so far on active layaways" />
        </View>
      )}
      <Card title="Layaways">
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <TextInput
            style={[ui.input, { flexGrow: 1, minWidth: 200 }]}
            value={q}
            onChangeText={setQ}
            placeholder="Layaway # or customer name / email / phone"
            placeholderTextColor={colors.muted}
            onSubmitEditing={find}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button title="Search" onPress={find} busy={busy} />
        </View>
        <Chips options={[["active", "Active"], ["overdue", "Overdue"], ["completed", "Picked up"], ["cancelled", "Cancelled"], ["all", "All"]]} value={filter} onChange={setFilter} />
        <Chips options={[["here", location.name], ["all", "All locations"]]} value={scope} onChange={(s) => setScope(s as never)} />
        {error && <Text style={ui.error}>{error}</Text>}
      </Card>
      <Card title={`${rows.length} layaway${rows.length === 1 ? "" : "s"}${balance ? ` · ${money(balance)} outstanding` : ""}`}>
        <Table<Layaway>
          rows={rows}
          keyOf={(l) => l.id}
          onPress={(l) => setPicked(l.id)}
          columns={[
            { key: "n", label: "Layaway #", render: (l) => `#${l.number}`, width: 90 },
            { key: "c", label: "Customer", render: (l) => l.customer?.name ?? "", width: 170 },
            { key: "i", label: "Items", render: (l) => itemCount(l) ?? "", width: 60, align: "right" },
            { key: "t", label: "Total", render: (l) => money(l.totalCents), width: 90, align: "right" },
            { key: "p", label: "Paid", render: (l) => money(l.paidCents), width: 90, align: "right" },
            { key: "b", label: "Balance", render: (l) => <Text style={[ui.text, { fontWeight: "600", textAlign: "right" }, isOverdue(l) && { color: colors.bad }]}>{money(l.balanceCents)}</Text>, width: 90, align: "right" },
            { key: "d", label: "Due", render: (l) => <DueDate l={l} />, width: 170 },
            { key: "s", label: "Status", render: (l) => statusBadge(l.status), width: 100 },
            { key: "w", label: "Created", render: (l) => when(l.createdAt), width: 160 },
          ]}
          empty={busy ? "Loading…" : "No layaways match."}
        />
      </Card>
    </ScrollView>
  );
}

function LayawayDetail({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const can = useCan();
  const { narrow } = useLayout();
  const [l, setL] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<"extend" | "notes" | "cancel" | null>(null);

  const load = useCallback(
    () =>
      api<Detail>("GET", `/layaways/${id}`)
        .then((r) => setL({ ...r, lines: Array.isArray(r.lines) ? r.lines : [], payments: Array.isArray(r.payments) ? r.payments : [] }))
        .catch((e) => setError(e instanceof ApiError ? e.message : String(e))),
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);

  const back = <Button title="← Layaways" kind="secondary" onPress={onBack} style={{ minHeight: 36, paddingVertical: 6, alignSelf: "flex-start" }} />;
  if (error) return <View style={{ padding: 12, gap: 12 }}>{back}<Text style={ui.error}>{error}</Text></View>;
  if (!l) return <View style={{ padding: 12, gap: 12 }}>{back}<Text style={ui.muted}>Loading…</Text></View>;

  const active = l.status === "ACTIVE";
  const late = isOverdue(l);
  const manage = can("LAYAWAY_MANAGE") !== "DENY";
  const cancellable = active && can("LAYAWAY_CANCEL") !== "DENY";
  const adjustments = (l.cardAdjustmentCents ?? 0) + (l.cardAdjustmentTaxCents ?? 0);
  const sale = saleNumber(l);
  const toggle = (f: "extend" | "notes" | "cancel") => setForm(form === f ? null : f);
  const refresh = () => {
    load();
    onChanged();
  };
  const print = async () => {
    setMessage(null);
    try {
      await openDocument(`/layaways/${l.id}/receipt?format=html`);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={[narrow ? { gap: 8 } : [ui.row, { gap: 12, flexWrap: "wrap" }]]}>
        <View style={[ui.row, { gap: 12, flexWrap: "wrap" }]}>
          {back}
          <Text style={ui.h1}>Layaway #{l.number}</Text>
          {statusBadge(l.status)}
          {late && <Badge text="overdue" tone="bad" />}
        </View>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", marginLeft: narrow ? 0 : "auto" }]}>
          <Button title="Print statement" kind="secondary" onPress={print} style={{ minHeight: 40, paddingVertical: 8 }} />
          {active && manage && <Button title="Extend due date" kind="secondary" onPress={() => toggle("extend")} style={{ minHeight: 40, paddingVertical: 8 }} />}
          {active && manage && <Button title="Edit notes" kind="secondary" onPress={() => toggle("notes")} style={{ minHeight: 40, paddingVertical: 8 }} />}
          {cancellable && <Button title="Cancel layaway" kind="danger" onPress={() => toggle("cancel")} style={{ minHeight: 40, paddingVertical: 8 }} />}
        </View>
      </View>
      {message && <Text style={ui.text}>{message}</Text>}

      <Card title="Customer">
        <View style={[ui.row, { gap: 24, flexWrap: "wrap", alignItems: "flex-start" }]}>
          <Field label="Name">
            <Text style={ui.text}>{l.customer?.name ?? "—"}</Text>
            {l.customer?.email ? <Text style={ui.muted}>{l.customer.email}</Text> : null}
            {l.customer?.phone ? <Text style={ui.muted}>{l.customer.phone}</Text> : null}
            <Text style={[ui.muted, { color: colors.link }]}>View customer: search for them on the Customers page.</Text>
          </Field>
          <Field label="Opened">
            <Text style={ui.text}>{when(l.createdAt)}</Text>
            {l.staff?.name ? <Text style={ui.muted}>by {l.staff.name}</Text> : null}
          </Field>
          <Field label="Due">
            <DueDate l={l} />
          </Field>
        </View>
      </Card>

      {form === "extend" && (
        <ExtendForm
          layaway={l}
          onCancel={() => setForm(null)}
          onDone={(r) => {
            setForm(null);
            setMessage(`Due date moved to ${day(r.dueAt)}.`);
            refresh();
          }}
        />
      )}
      {form === "notes" && (
        <NotesForm
          layaway={l}
          onCancel={() => setForm(null)}
          onDone={() => {
            setForm(null);
            setMessage("Notes saved.");
            refresh();
          }}
        />
      )}
      {form === "cancel" && (
        <CancelForm
          layaway={l}
          onCancel={() => setForm(null)}
          onDone={(r) => {
            setForm(null);
            setMessage(`Layaway #${l.number} cancelled: fee ${money(r.cancelFeeCents ?? 0)}, refunded ${money(r.refundedCents ?? 0)}${r.toStoreCredit ? " to store credit" : ""}.`);
            refresh();
          }}
        />
      )}

      {l.status === "COMPLETED" && (
        <Card title="Picked up">
          <Text style={ui.text}>
            {l.completedAt ? `${when(l.completedAt)} · ` : ""}
            {sale != null ? `Sale #${sale}` : l.orderId ? "Rung up as a sale" : "Paid in full"}
          </Text>
          {sale != null && <Text style={ui.muted}>Find the sale on the Orders page.</Text>}
        </Card>
      )}
      {l.status === "CANCELLED" && (
        <Card title="Cancelled">
          <View style={[ui.row, { gap: 24, flexWrap: "wrap", alignItems: "flex-start" }]}>
            {l.cancelledAt && <Field label="When"><Text style={ui.text}>{when(l.cancelledAt)}</Text></Field>}
            <Field label="Cancellation fee"><Text style={ui.text}>{money(l.cancelFeeCents ?? 0)}</Text></Field>
            <Field label="Refunded"><Text style={ui.text}>{money(l.refundedCents ?? 0)}</Text></Field>
            {l.cancelReason ? <Field label="Reason"><Text style={ui.text}>{l.cancelReason}</Text></Field> : null}
          </View>
        </Card>
      )}

      <Card title={`Items · ${units(l.lines)}`}>
        {l.lines.map((x) => (
          <View key={x.id} style={[ui.row, { gap: 12, alignItems: "flex-start", paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
            <Thumb uri={x.variant?.imageUrl ?? x.variant?.product?.imageUrl} title={x.title} size={40} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={ui.text}>{x.title}</Text>
              <Text style={ui.muted}>
                {x.quantity} × {money(x.unitPriceCents)}
                {x.variant?.sku ? ` · ${x.variant.sku}` : ""}
                {x.taxable ? "" : " · tax exempt"}
              </Text>
              {x.promoDiscountCents > 0 && <Text style={ui.muted}>Deal −{money(x.promoDiscountCents)}</Text>}
              {x.discountCents - x.promoDiscountCents > 0 && <Text style={ui.muted}>Discount −{money(x.discountCents - x.promoDiscountCents)}</Text>}
            </View>
            <Text style={[ui.text, { fontWeight: "600" }]}>{money(x.unitPriceCents * x.quantity - x.discountCents)}</Text>
          </View>
        ))}
        {l.lines.length === 0 && <Text style={ui.muted}>No items.</Text>}
      </Card>

      <Card title="Totals">
        <Row label="Subtotal" value={money(l.subtotalCents)} />
        <Row label="Deals and discounts" value={l.discountCents ? `−${money(l.discountCents)}` : money(0)} />
        <Row label="Tax" value={money(l.taxCents)} />
        <Row label="Total" value={money(l.totalCents)} bold />
        {adjustments > 0 && <Row label={`Card price adjustments collected${l.cardPriceBps ? ` (${(l.cardPriceBps / 100).toFixed(2)}%)` : ""}`} value={money(adjustments)} />}
        <Row label="Paid" value={money(l.paidCents)} />
        <Row label="Balance" value={money(l.balanceCents)} bold color={active && late ? colors.bad : active && l.balanceCents > 0 ? colors.warn : colors.good} />
        <Row label="Due" value={day(l.dueAt)} color={late ? colors.bad : undefined} />
      </Card>

      <Card title="Payments">
        <Table<Payment>
          rows={l.payments}
          keyOf={(p) => p.id}
          columns={[
            { key: "w", label: "Date", render: (p) => when(p.createdAt), width: 160 },
            { key: "t", label: "Tender", render: (p) => tenderLabel(p), width: 170 },
            { key: "a", label: "Amount", render: (p) => money(p.amountCents), width: 90, align: "right" },
            { key: "ap", label: "Applied", render: (p) => money(p.appliedCents ?? p.amountCents), width: 90, align: "right" },
            { key: "s", label: "Status", render: (p) => <Badge text={String(p.status ?? "").toLowerCase()} tone={p.status === "APPROVED" ? "good" : p.status === "PENDING" ? "warn" : p.status === "DECLINED" ? "bad" : "muted"} />, width: 110 },
            { key: "b", label: "By", render: (p) => p.staff?.name ?? "", width: 120 },
          ]}
          empty="No payments yet."
        />
      </Card>

      <Card title="Notes">
        <Text style={l.notes ? ui.text : ui.muted}>{l.notes || "No notes."}</Text>
      </Card>
    </ScrollView>
  );
}

/** Push the due date out; needs LAYAWAY_MANAGE. */
function ExtendForm({ layaway, onDone, onCancel }: { layaway: Detail; onDone: (l: Detail) => void; onCancel: () => void }) {
  const guard = useGuard();
  const [date, setDate] = useState(localDay(new Date(layaway.dueAt)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = isDay(date);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const dueAt = new Date(`${date}T23:59:59`).toISOString();
      const r = await guard("LAYAWAY_MANAGE", (token) => api<Partial<Detail>>("POST", `/layaways/${layaway.id}/extend`, { dueAt }, { approvalToken: token }));
      if (r) onDone({ ...layaway, ...r, dueAt: r.dueAt ?? dueAt });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Extend due date">
      <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
        <Field label="New due date (YYYY-MM-DD)">
          <Input value={date} onChange={setDate} placeholder={localDay(new Date())} />
        </Field>
      </View>
      <Text style={ui.muted}>Currently due {day(layaway.dueAt)}.</Text>
      {!ok && date.trim() !== "" && <Text style={ui.error}>Enter a date as YYYY-MM-DD.</Text>}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button title="Extend" onPress={submit} busy={busy} disabled={!ok} />
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    </Card>
  );
}

function NotesForm({ layaway, onDone, onCancel }: { layaway: Detail; onDone: () => void; onCancel: () => void }) {
  const guard = useGuard();
  const [notes, setNotes] = useState(layaway.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await guard("LAYAWAY_MANAGE", async (token) => (await api("PATCH", `/layaways/${layaway.id}`, { notes: notes.trim() }, { approvalToken: token }), true));
      if (r) onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Notes">
      <Input value={notes} onChange={setNotes} placeholder="Anything the next person should know" multiline />
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button title="Save notes" onPress={submit} busy={busy} />
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    </Card>
  );
}

/**
 * Cancel and refund. The store's fee comes off unless a manager waives it
 * (LAYAWAY_MANAGE); money goes to store credit by default because card refunds
 * need the register's terminal.
 */
function CancelForm({ layaway, onDone, onCancel }: { layaway: Detail; onDone: (r: Detail & { toStoreCredit: boolean }) => void; onCancel: () => void }) {
  const guard = useGuard();
  const can = useCan();
  const [reason, setReason] = useState("");
  const [toCredit, setToCredit] = useState(true);
  const [waive, setWaive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWaive = can("LAYAWAY_MANAGE") !== "DENY";
  const preview = layaway.cancelFeePreview;
  const fee = waive ? 0 : (preview?.feeCents ?? 0);
  const refund = waive ? layaway.paidCents : (preview?.refundCents ?? Math.max(0, layaway.paidCents - fee));

  async function submit() {
    setBusy(true);
    setError(null);
    const body = { toStoreCredit: toCredit, waiveFee: waive || undefined, reason: reason.trim() || undefined };
    const call = (token?: string) => api<Detail>("POST", `/layaways/${layaway.id}/cancel`, body, { approvalToken: token });
    try {
      let r: Detail | undefined;
      try {
        r = await guard("LAYAWAY_CANCEL", call);
      } catch (e) {
        // Waiving the fee is a manager's call: the server names LAYAWAY_MANAGE, so ask for that PIN and retry.
        const d = e instanceof ApiError ? (e.details as { permission?: string; permissions?: string[] } | undefined) : undefined;
        const needsManage = e instanceof ApiError && e.code === "APPROVAL_REQUIRED" && (d?.permission === "LAYAWAY_MANAGE" || d?.permissions?.includes("LAYAWAY_MANAGE"));
        if (!needsManage) throw e;
        r = await guard("LAYAWAY_MANAGE", call, { needsApproval: true });
      }
      if (r) onDone({ ...r, toStoreCredit: toCredit });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Cancel layaway #${layaway.number}`}>
      <Text style={ui.muted}>The items go back on the shelf. The customer has paid {money(layaway.paidCents)} so far.</Text>
      <Row label="Cancellation fee" value={fee ? `−${money(fee)}` : money(0)} />
      <Row label="Refund to customer" value={money(refund)} bold />
      {!preview && !waive && <Text style={ui.muted}>The server works out the fee when you confirm.</Text>}
      <Field label="Reason">
        <Input value={reason} onChange={setReason} placeholder="e.g. Changed mind" />
      </Field>
      <View style={[ui.row, { gap: 8 }]}>
        <Switch value={toCredit} onValueChange={setToCredit} />
        <Text style={[ui.text, { flex: 1 }]}>Refund to store credit</Text>
      </View>
      {!toCredit && <Text style={ui.muted}>Off sends the money back the way it came in. Card refunds need the register's terminal, so cash and store credit are what the website can do.</Text>}
      {canWaive && (
        <View style={[ui.row, { gap: 8 }]}>
          <Switch value={waive} onValueChange={setWaive} />
          <Text style={[ui.text, { flex: 1 }]}>Waive the cancellation fee{can("LAYAWAY_MANAGE") === "PIN" ? " (manager PIN)" : ""}</Text>
        </View>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button title={can("LAYAWAY_CANCEL") === "PIN" ? "Cancel layaway · PIN" : "Cancel layaway"} kind="danger" onPress={submit} busy={busy} />
        <Button title="Keep it" kind="secondary" onPress={onCancel} />
      </View>
    </Card>
  );
}
