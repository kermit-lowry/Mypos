import { useCallback, useEffect, useState } from "react";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import { api, ApiError } from "../../api";
import { useGuard } from "../../approval";
import { Button } from "../../components/Button";
import { Thumb } from "../../components/Thumb";
import { useLayout } from "../../layout";
import { useCan, useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Badge, Card, Chips, DateRangePicker, Field, Input, money, openDocument, PRESETS, Table, when, type DateRange } from "../ui";

type Status = "OPEN" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "VOID";

interface Line {
  id: string;
  title: string;
  quantity: number;
  unitPriceCents: number;
  /** Total discount, including deal and reward portions. */
  discountCents: number;
  promoDiscountCents: number;
  rewardDiscountCents: number;
  discountReason: string | null;
  discountNote: string | null;
  refundedQty: number;
  imageUrl?: string | null;
}
interface Payment {
  id: string;
  /** Positive = money in, negative = refund out. */
  amountCents: number;
  tender: string;
  status: "PENDING" | "APPROVED" | "DECLINED" | "VOIDED" | "REFUNDED";
  gateway: string | null;
  gatewayRef: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  changeCents: number | null;
  refundOfId: string | null;
}
interface Order {
  id: string;
  number: number;
  channel: string;
  status: Status;
  createdAt: string;
  note: string | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  /** Cash-price total; card payments added cardAdjustmentCents on top. */
  totalCents: number;
  cardAdjustmentCents: number;
  cardPriceBps: number;
  appliedPromotions: { name: string; discountCents: number }[];
  customer: { id: string; name: string; email: string | null } | null;
  staff: { id: string; name: string } | null;
  location: { name: string };
  lines: Line[];
  payments: Payment[];
}
interface RefundResult {
  refundCents: number;
  legs: { tender: string; amountCents: number; status: string }[];
}

const STATUS: Record<Status, { text: string; tone: "good" | "bad" | "warn" | "muted" }> = {
  PAID: { text: "completed", tone: "good" },
  PARTIALLY_REFUNDED: { text: "partially refunded", tone: "warn" },
  REFUNDED: { text: "refunded", tone: "bad" },
  VOID: { text: "void", tone: "muted" },
  OPEN: { text: "pending", tone: "warn" },
};
const TENDERS: Record<string, string> = { CARD: "Card", CASH: "Cash", CHECK: "Check", STORE_CREDIT: "Store credit", LOYALTY: "Rewards", GIFT_CARD: "Gift card", PREORDER_DEPOSIT: "Deposit", EXTERNAL: "Paid online" };
const tenderLabel = (p: Payment) => (p.cardLast4 ? `${p.cardBrand ?? "Card"} •••• ${p.cardLast4}` : (TENDERS[p.tender] ?? p.tender));
const counted = (p: Payment) => p.status !== "DECLINED" && p.status !== "VOIDED";
const tenders = (o: Order) => [...new Set(o.payments.filter((p) => p.amountCents > 0 && counted(p)).map(tenderLabel))].join(", ");
/** What has gone back to the customer so far. */
const refunded = (o: Order) => o.payments.filter((p) => p.amountCents < 0 && counted(p)).reduce((a, p) => a - p.amountCents, 0);
const charged = (o: Order) => o.totalCents + o.cardAdjustmentCents;
const units = (o: Order) => o.lines.reduce((a, l) => a + l.quantity, 0);
const statusBadge = (s: Status) => <Badge text={STATUS[s]?.text ?? s.toLowerCase()} tone={STATUS[s]?.tone} />;

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between", gap: 12 }]}>
      <Text style={bold ? ui.text : ui.muted}>{label}</Text>
      <Text style={[ui.text, bold && { fontWeight: "700" }]}>{value}</Text>
    </View>
  );
}

/** Sales history: find a sale, see what was sold and how it was paid, refund it. */
export function Orders() {
  const { location } = useSession();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [range, setRange] = useState<DateRange>(PRESETS.last30!());
  const [scope, setScope] = useState<"here" | "all">("here");
  const [rows, setRows] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const path = `/orders?take=200&from=${range.from.toISOString()}&to=${range.to.toISOString()}${scope === "here" ? `&locationId=${location.id}` : ""}${status ? `&status=${status}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}`;
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    api<Order[]>("GET", path)
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [path, tick]);

  const find = () => {
    setSearch(q.trim());
    setTick((t) => t + 1);
  };

  if (picked) return <OrderDetail id={picked} onBack={() => setPicked(null)} onChanged={() => setTick((t) => t + 1)} />;

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card title="Orders">
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <TextInput
            style={[ui.input, { flexGrow: 1, minWidth: 200 }]}
            value={q}
            onChangeText={setQ}
            placeholder="Order # or customer name / email"
            placeholderTextColor={colors.muted}
            onSubmitEditing={find}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button title="Search" onPress={find} busy={busy} />
        </View>
        <Chips options={[["", "All"], ["PAID", "Completed"], ["REFUNDED", "Refunded"], ["VOID", "Void"], ["OPEN", "Pending"]]} value={status} onChange={setStatus} />
        <DateRangePicker value={range} onChange={setRange} />
        <Chips options={[["here", location.name], ["all", "All locations"]]} value={scope} onChange={(s) => setScope(s as never)} />
        {error && <Text style={ui.error}>{error}</Text>}
      </Card>
      <Card title={`${rows.length} orders · ${money(rows.reduce((a, o) => a + charged(o), 0))}`}>
        <Table
          rows={rows}
          keyOf={(o) => o.id}
          onPress={(o) => setPicked(o.id)}
          columns={[
            { key: "n", label: "Order #", render: (o) => `#${o.number}`, width: 80 },
            { key: "w", label: "When", render: (o) => when(o.createdAt), width: 160 },
            ...(scope === "all" ? [{ key: "l", label: "Location", render: (o: Order) => o.location?.name ?? "", width: 130 }] : []),
            { key: "c", label: "Customer", render: (o) => o.customer?.name ?? "Walk-in", width: 160 },
            { key: "i", label: "Items", render: (o) => units(o), width: 60, align: "right" },
            { key: "sub", label: "Subtotal", render: (o) => money(o.subtotalCents), width: 90, align: "right" },
            { key: "d", label: "Discount", render: (o) => (o.discountCents ? `−${money(o.discountCents)}` : "—"), width: 90, align: "right" },
            { key: "x", label: "Tax", render: (o) => money(o.taxCents), width: 80, align: "right" },
            { key: "t", label: "Total", render: (o) => <Text style={[ui.text, { fontWeight: "600", textAlign: "right" }]}>{money(charged(o))}</Text>, width: 90, align: "right" },
            { key: "p", label: "Tender(s)", render: (o) => tenders(o) || "—", width: 150 },
            { key: "s", label: "Status", render: (o) => statusBadge(o.status), width: 140 },
            { key: "e", label: "Employee", render: (o) => o.staff?.name ?? "", width: 120 },
          ]}
          empty={busy ? "Loading…" : "No orders match."}
        />
      </Card>
    </ScrollView>
  );
}

function OrderDetail({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const can = useCan();
  const { narrow } = useLayout();
  const [o, setO] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refunding, setRefunding] = useState(false);

  const load = useCallback(
    () =>
      api<Order>("GET", `/orders/${id}`)
        .then(setO)
        .catch((e) => setError(e instanceof ApiError ? e.message : String(e))),
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);

  const back = <Button title="← Orders" kind="secondary" onPress={onBack} style={{ minHeight: 36, paddingVertical: 6, alignSelf: "flex-start" }} />;
  if (error) return <View style={{ padding: 12, gap: 12 }}>{back}<Text style={ui.error}>{error}</Text></View>;
  if (!o) return <View style={{ padding: 12, gap: 12 }}>{back}<Text style={ui.muted}>Loading…</Text></View>;

  const refundable = (o.status === "PAID" || o.status === "PARTIALLY_REFUNDED") && o.lines.some((l) => l.quantity > l.refundedQty) && can("REFUND") !== "DENY";
  const returned = refunded(o);
  const print = async () => {
    setMessage(null);
    try {
      await openDocument(`/orders/${o.id}/receipt?format=html`);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={[narrow ? { gap: 8 } : [ui.row, { gap: 12, flexWrap: "wrap" }]]}>
        <View style={[ui.row, { gap: 12, flexWrap: "wrap" }]}>
          {back}
          <Text style={ui.h1}>Order #{o.number}</Text>
          {statusBadge(o.status)}
        </View>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", marginLeft: narrow ? 0 : "auto" }]}>
          <Button title="Print receipt" kind="secondary" onPress={print} style={{ minHeight: 40, paddingVertical: 8 }} />
          {refundable && <Button title="Refund" kind="danger" onPress={() => setRefunding((r) => !r)} style={{ minHeight: 40, paddingVertical: 8 }} />}
        </View>
      </View>
      {message && <Text style={ui.text}>{message}</Text>}

      <Card title="Details">
        <View style={[ui.row, { gap: 24, flexWrap: "wrap", alignItems: "flex-start" }]}>
          <Field label="Date"><Text style={ui.text}>{when(o.createdAt)}</Text></Field>
          <Field label="Location"><Text style={ui.text}>{o.location?.name ?? ""}</Text></Field>
          <Field label="Employee"><Text style={ui.text}>{o.staff?.name ?? "—"}</Text></Field>
          <Field label="Customer">
            <Text style={ui.text}>{o.customer?.name ?? "Walk-in"}</Text>
            {o.customer?.email && <Text style={ui.muted}>{o.customer.email}</Text>}
          </Field>
          <Field label="Channel"><Text style={ui.text}>{o.channel === "POS" ? "In store" : o.channel.toLowerCase()}</Text></Field>
          {o.note && <Field label="Note"><Text style={ui.text}>{o.note}</Text></Field>}
        </View>
      </Card>

      {refunding && (
        <RefundForm
          order={o}
          onCancel={() => setRefunding(false)}
          onDone={(r) => {
            setRefunding(false);
            setMessage(`Refunded ${money(r.refundCents)}: ${r.legs.map((l) => `${TENDERS[l.tender] ?? l.tender} ${money(l.amountCents)}${l.status === "PENDING" ? " (pending)" : ""}`).join(", ")}`);
            load();
            onChanged();
          }}
        />
      )}

      <Card title="Items">
        {o.lines.map((l) => {
          const manual = l.discountCents - l.promoDiscountCents - l.rewardDiscountCents;
          return (
            <View key={l.id} style={[ui.row, { gap: 12, alignItems: "flex-start", paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
              <Thumb uri={l.imageUrl} title={l.title} size={40} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={ui.text}>{l.title}</Text>
                <Text style={ui.muted}>{l.quantity} × {money(l.unitPriceCents)}</Text>
                {manual > 0 && <Text style={ui.muted}>Discount −{money(manual)}{l.discountReason ? ` · ${l.discountReason}` : ""}{l.discountNote ? ` (${l.discountNote})` : ""}</Text>}
                {l.promoDiscountCents > 0 && <Text style={ui.muted}>Deal −{money(l.promoDiscountCents)}</Text>}
                {l.rewardDiscountCents > 0 && <Text style={ui.muted}>Reward −{money(l.rewardDiscountCents)}</Text>}
                {l.refundedQty > 0 && <Badge text={`${l.refundedQty} of ${l.quantity} refunded`} tone="warn" />}
              </View>
              <Text style={[ui.text, { fontWeight: "600" }]}>{money(l.unitPriceCents * l.quantity - l.discountCents)}</Text>
            </View>
          );
        })}
      </Card>

      <Card title="Payments">
        <Table
          rows={o.payments}
          keyOf={(p) => p.id}
          columns={[
            { key: "t", label: "Tender", render: (p) => `${tenderLabel(p)}${p.refundOfId || p.amountCents < 0 ? " (refund)" : ""}`, width: 180 },
            { key: "a", label: "Amount", render: (p) => money(p.amountCents), width: 100, align: "right" },
            { key: "s", label: "Status", render: (p) => <Badge text={p.status.toLowerCase()} tone={p.status === "APPROVED" ? "good" : p.status === "PENDING" ? "warn" : p.status === "DECLINED" ? "bad" : "muted"} />, width: 110 },
            { key: "r", label: "Reference", render: (p) => [p.gateway, p.gatewayRef].filter(Boolean).join(" · "), width: 220 },
            { key: "c", label: "Change", render: (p) => (p.changeCents ? money(p.changeCents) : ""), width: 90, align: "right" },
          ]}
          empty="No payments."
        />
      </Card>

      <Card title="Totals">
        <Row label="Subtotal" value={money(o.subtotalCents)} />
        <Row label="Discount" value={o.discountCents ? `−${money(o.discountCents)}` : money(0)} />
        {o.appliedPromotions?.map((p, i) => (
          <View key={i} style={[ui.row, { justifyContent: "space-between", paddingLeft: 12 }]}>
            <Text style={ui.muted}>{p.name}</Text>
            <Text style={ui.muted}>−{money(p.discountCents)}</Text>
          </View>
        ))}
        <Row label="Tax" value={money(o.taxCents)} />
        {o.cardAdjustmentCents > 0 && <Row label={`Card price adjustment (${(o.cardPriceBps / 100).toFixed(2)}%)`} value={money(o.cardAdjustmentCents)} />}
        <Row label="Total" value={money(charged(o))} bold />
        {returned > 0 && <Row label="Refunded" value={`−${money(returned)}`} />}
      </Card>
    </ScrollView>
  );
}

/** Pick how many of each item come back; the money follows the original tenders unless sent to store credit. */
function RefundForm({ order, onDone, onCancel }: { order: Order; onDone: (r: RefundResult) => void; onCancel: () => void }) {
  const guard = useGuard();
  const open = order.lines.filter((l) => l.quantity > l.refundedQty);
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(open.map((l) => [l.id, String(l.quantity - l.refundedQty)])));
  const [reason, setReason] = useState("");
  const [toCredit, setToCredit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = (id: string) => Math.floor(Number(qty[id] ?? "")) || 0;
  const lines = open.map((l) => ({ orderLineId: l.id, quantity: n(l.id) })).filter((l) => l.quantity > 0);
  const over = open.some((l) => n(l.id) > l.quantity - l.refundedQty);
  const count = lines.reduce((a, l) => a + l.quantity, 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await guard("REFUND", (token) => api<RefundResult>("POST", `/orders/${order.id}/refund`, { lines, reason: reason.trim() || undefined, toStoreCredit: toCredit }, { approvalToken: token }));
      if (r) onDone(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Refund">
      {open.map((l) => (
        <View key={l.id} style={[ui.row, { gap: 12, flexWrap: "wrap" }]}>
          <View style={{ flex: 1, minWidth: 160 }}>
            <Text style={ui.text}>{l.title}</Text>
            <Text style={ui.muted}>{l.quantity - l.refundedQty} refundable · {money(l.unitPriceCents)} each</Text>
          </View>
          <View style={{ width: 90 }}>
            <Input value={qty[l.id] ?? ""} onChange={(t) => setQty({ ...qty, [l.id]: t })} keyboard="number-pad" />
          </View>
        </View>
      ))}
      <Field label="Reason">
        <Input value={reason} onChange={setReason} placeholder="e.g. Changed mind" />
      </Field>
      {order.customer && (
        <View style={[ui.row, { gap: 8 }]}>
          <Switch value={toCredit} onValueChange={setToCredit} />
          <Text style={ui.text}>Refund to store credit instead of the original tender</Text>
        </View>
      )}
      {over && <Text style={ui.error}>Can't refund more than was sold.</Text>}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button title={count ? `Refund ${count} item${count === 1 ? "" : "s"}` : "Refund"} kind="danger" onPress={submit} busy={busy} disabled={!count || over} />
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
    </Card>
  );
}
