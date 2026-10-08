import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { api, ApiError } from "../../api";
import { useGuard } from "../../approval";
import { Button } from "../../components/Button";
import { Thumb } from "../../components/Thumb";
import { useLayout } from "../../layout";
import { useCan, useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Badge, Card, Chips, DateRangePicker, Field, Input, money, openDocument, Picker, PRESETS, Table, when, type Column, type DateRange } from "../ui";

type Status = "OPEN" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "VOID";
type Method = "PICKUP" | "SHIP";
type FulfillmentStatus = "NEW" | "ACKNOWLEDGED" | "PICKING" | "READY" | "SHIPPED" | "PICKED_UP" | "PROBLEM";

interface Address {
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
}
/** What an online order carries once the server fills it; all optional so an older server still loads. */
interface Fulfillment {
  fulfillment?: Method | null;
  fulfillmentStatus?: FulfillmentStatus | null;
  shippingCents?: number | null;
  shippingAddress?: Address | null;
  customerPhone?: string | null;
  customerNote?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  pickedLineIds?: string[] | null;
  acknowledgedAt?: string | null;
  readyAt?: string | null;
  shippedAt?: string | null;
  pickedUpAt?: string | null;
  fulfilledById?: string | null;
  fulfilledBy?: { name: string } | null;
  ageMinutes?: number | null;
  /** The note left when it was flagged, while it is in PROBLEM. */
  problemNote?: string | null;
  /** The queue rolls the money up here instead of top-level fields. */
  totals?: { subtotalCents?: number; discountCents?: number; taxCents?: number; shippingCents?: number; totalCents?: number; cardAdjustmentCents?: number; chargedCents?: number } | null;
  items?: number | null;
  timeline?: { at: string; event: string; by?: string | null; note?: string | null }[] | null;
}
interface Line {
  id: string;
  variantId?: string;
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
  sku?: string | null;
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
interface Order extends Fulfillment {
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
  customer: { id: string; name: string; email: string | null; phone?: string | null } | null;
  staff: { id: string; name: string } | null;
  location: { name: string };
  lines: Line[];
  payments: Payment[];
}
/** A line as GET /fulfillment/orders/:id lists it: what to pull, not what it cost. */
interface PickLine {
  id: string;
  variantId?: string;
  title: string;
  quantity: number;
  sku?: string | null;
  imageUrl?: string | null;
}
type FulfillmentOrder = Fulfillment & { id: string; lines?: PickLine[] };
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
const FSTATUS: Record<FulfillmentStatus, { text: string; tone?: "good" | "bad" | "warn" | "muted" }> = {
  NEW: { text: "new", tone: "bad" },
  ACKNOWLEDGED: { text: "acknowledged" },
  PICKING: { text: "setting aside" },
  READY: { text: "ready", tone: "good" },
  SHIPPED: { text: "shipped", tone: "muted" },
  PICKED_UP: { text: "picked up", tone: "muted" },
  PROBLEM: { text: "problem", tone: "warn" },
};
const OPEN_STATUSES: FulfillmentStatus[] = ["NEW", "ACKNOWLEDGED", "PICKING", "READY", "PROBLEM"];
const METHOD: Record<Method, string> = { PICKUP: "Pickup", SHIP: "Ship" };
const CHANNEL: Record<string, string> = { POS: "In store", STOREFRONT: "Website", SHOPIFY: "Shopify", TCGPLAYER: "TCGplayer", EBAY: "eBay" };
const CARRIERS: [string, string][] = [["USPS", "USPS"], ["UPS", "UPS"], ["FedEx", "FedEx"], ["DHL", "DHL"], ["Other", "Other"]];
const EVENT: Record<string, string> = { CREATED: "Placed", PLACED: "Placed", PAID: "Paid", ACKNOWLEDGED: "Acknowledged", PICKED: "Set aside", PICKING: "Set aside", READY: "Ready", SHIPPED: "Shipped", PICKED_UP: "Picked up", PROBLEM: "Problem", REOPENED: "Reopened" };
/** Chip key → label and the comma list GET /fulfillment/orders takes. */
const ONLINE_STATUS: Record<string, { label: string; query: string }> = {
  open: { label: "Open", query: "NEW,ACKNOWLEDGED,PICKING,READY,PROBLEM" },
  NEW: { label: "New", query: "NEW" },
  READY: { label: "Ready", query: "READY" },
  done: { label: "Done", query: "SHIPPED,PICKED_UP" },
  PROBLEM: { label: "Problem", query: "PROBLEM" },
};
const TENDERS: Record<string, string> = { CARD: "Card", CASH: "Cash", CHECK: "Check", STORE_CREDIT: "Store credit", LOYALTY: "Rewards", GIFT_CARD: "Gift card", PREORDER_DEPOSIT: "Deposit", EXTERNAL: "Paid online" };
const tenderLabel = (p: Payment) => (p.cardLast4 ? `${p.cardBrand ?? "Card"} •••• ${p.cardLast4}` : (TENDERS[p.tender] ?? p.tender));
const counted = (p: Payment) => p.status !== "DECLINED" && p.status !== "VOIDED";
const tenders = (o: Order) => [...new Set(o.payments.filter((p) => p.amountCents > 0 && counted(p)).map(tenderLabel))].join(", ");
/** What has gone back to the customer so far. */
const refunded = (o: Order) => o.payments.filter((p) => p.amountCents < 0 && counted(p)).reduce((a, p) => a - p.amountCents, 0);
const charged = (o: Order) => o.totals?.chargedCents ?? (o.totalCents ?? 0) + (o.cardAdjustmentCents ?? 0);
const units = (o: Order) => o.items ?? o.lines.reduce((a, l) => a + l.quantity, 0);
const statusBadge = (s: Status) => <Badge text={STATUS[s]?.text ?? s.toLowerCase()} tone={STATUS[s]?.tone} />;
const fulfillmentBadge = (s: FulfillmentStatus | null | undefined) => (s ? <Badge text={FSTATUS[s]?.text ?? String(s).toLowerCase().replace(/_/g, " ")} tone={FSTATUS[s]?.tone} /> : null);
const isOpen = (s: FulfillmentStatus | null | undefined) => !!s && OPEN_STATUSES.includes(s);
/** "35 min", "2 h 10 m", "3 d 4 h". */
const age = (m: number) => (m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} m` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);
const eventLabel = (ev: string) => {
  const k = String(ev).toUpperCase().replace(/^ORDER_/, "");
  return EVENT[k] ?? k.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
};
const addressLines = (a: Address) => [a.name, a.line1, a.line2, [[a.city, a.state].filter(Boolean).join(", "), a.postalCode].filter(Boolean).join(" "), a.country, a.phone].filter((x): x is string => !!x);
/** List endpoints answer with an array, or an object carrying one; rows from the queue may omit lines or payments. */
const rowsOf = (r: unknown): Order[] => {
  const box = r && typeof r === "object" && !Array.isArray(r) ? (r as { rows?: unknown; orders?: unknown }) : null;
  const list = Array.isArray(r) ? r : (box?.rows ?? box?.orders);
  return (Array.isArray(list) ? (list as Order[]) : []).map((o) => ({ ...o, lines: Array.isArray(o.lines) ? o.lines : [], payments: Array.isArray(o.payments) ? o.payments : [] }));
};

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between", gap: 12 }]}>
      <Text style={bold ? ui.text : ui.muted}>{label}</Text>
      <Text style={[ui.text, bold && { fontWeight: "700" }]}>{value}</Text>
    </View>
  );
}

function FulfillmentCell({ o }: { o: Order }) {
  if (!o.fulfillment) return <Text style={ui.muted}>—</Text>;
  return (
    <View style={{ gap: 3, alignItems: "flex-start" }}>
      <Text style={ui.text}>
        {METHOD[o.fulfillment] ?? o.fulfillment}
        {isOpen(o.fulfillmentStatus) && o.ageMinutes != null ? ` · ${age(o.ageMinutes)}` : ""}
      </Text>
      {fulfillmentBadge(o.fulfillmentStatus)}
    </View>
  );
}

/** Sales history: find a sale, see what was sold and how it was paid, refund it; online orders show where they are in fulfillment. */
export function Orders() {
  const { location } = useSession();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [fulfill, setFulfill] = useState("");
  const [fstatus, setFstatus] = useState("open");
  const [range, setRange] = useState<DateRange>(PRESETS.last30!());
  const [scope, setScope] = useState<"here" | "all">("here");
  const [rows, setRows] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const online = fulfill !== "";
  const loc = scope === "here" ? `locationId=${location.id}` : "";
  const path = online
    ? `/fulfillment/orders?${["take=200", loc, `status=${(ONLINE_STATUS[fstatus] ?? ONLINE_STATUS.open!).query}`, fulfill === "online" ? "" : `fulfillment=${fulfill}`, search ? `q=${encodeURIComponent(search)}` : ""].filter(Boolean).join("&")}`
    : `/orders?take=200&from=${range.from.toISOString()}&to=${range.to.toISOString()}${loc ? `&${loc}` : ""}${status ? `&status=${status}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}`;
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    api<unknown>("GET", path)
      .then((r) => live && setRows(rowsOf(r)))
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

  const locationCol: Column<Order>[] = scope === "all" ? [{ key: "l", label: "Location", render: (o) => o.location?.name ?? "", width: 130 }] : [];
  const fulfillmentCol: Column<Order> = { key: "f", label: "Fulfillment", render: (o) => <FulfillmentCell o={o} />, width: 150 };
  const columns: Column<Order>[] = online
    ? [
        { key: "n", label: "Order #", render: (o) => `#${o.number}`, width: 80 },
        { key: "w", label: "Placed", render: (o) => when(o.createdAt), width: 160 },
        ...locationCol,
        { key: "c", label: "Customer", render: (o) => o.customer?.name ?? "Walk-in", width: 160 },
        { key: "i", label: "Items", render: (o) => units(o), width: 60, align: "right" },
        { key: "t", label: "Total", render: (o) => <Text style={[ui.text, { fontWeight: "600", textAlign: "right" }]}>{money(charged(o))}</Text>, width: 90, align: "right" },
        fulfillmentCol,
        { key: "h", label: "Handled by", render: (o) => o.fulfilledBy?.name ?? "", width: 120 },
        { key: "ch", label: "Channel", render: (o) => CHANNEL[o.channel] ?? o.channel?.toLowerCase() ?? "", width: 100 },
      ]
    : [
        { key: "n", label: "Order #", render: (o) => `#${o.number}`, width: 80 },
        { key: "w", label: "When", render: (o) => when(o.createdAt), width: 160 },
        ...locationCol,
        { key: "c", label: "Customer", render: (o) => o.customer?.name ?? "Walk-in", width: 160 },
        { key: "i", label: "Items", render: (o) => units(o), width: 60, align: "right" },
        { key: "sub", label: "Subtotal", render: (o) => money(o.subtotalCents), width: 90, align: "right" },
        { key: "d", label: "Discount", render: (o) => (o.discountCents ? `−${money(o.discountCents)}` : "—"), width: 90, align: "right" },
        { key: "x", label: "Tax", render: (o) => money(o.taxCents), width: 80, align: "right" },
        { key: "t", label: "Total", render: (o) => <Text style={[ui.text, { fontWeight: "600", textAlign: "right" }]}>{money(charged(o))}</Text>, width: 90, align: "right" },
        { key: "p", label: "Tender(s)", render: (o) => tenders(o) || "—", width: 150 },
        { key: "s", label: "Status", render: (o) => statusBadge(o.status), width: 140 },
        fulfillmentCol,
        { key: "e", label: "Employee", render: (o) => o.staff?.name ?? "", width: 120 },
      ];

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
        <View style={{ gap: 4 }}>
          <Text style={[ui.muted, { fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 }]}>Fulfillment</Text>
          <Chips options={[["", "All"], ["online", "Online only"], ["PICKUP", "Pickup"], ["SHIP", "Ship"]]} value={fulfill} onChange={setFulfill} />
        </View>
        {online ? (
          <Chips options={Object.entries(ONLINE_STATUS).map(([k, v]) => [k, v.label] as [string, string])} value={fstatus} onChange={setFstatus} />
        ) : (
          <>
            <Chips options={[["", "All"], ["PAID", "Completed"], ["REFUNDED", "Refunded"], ["VOID", "Void"], ["OPEN", "Pending"]]} value={status} onChange={setStatus} />
            <DateRangePicker value={range} onChange={setRange} />
          </>
        )}
        <Chips options={[["here", location.name], ["all", "All locations"]]} value={scope} onChange={(s) => setScope(s as never)} />
        {error && <Text style={ui.error}>{error}</Text>}
      </Card>
      <Card title={`${rows.length} ${online ? "online " : ""}order${rows.length === 1 ? "" : "s"} · ${money(rows.reduce((a, o) => a + charged(o), 0))}`}>
        <Table rows={rows} keyOf={(o) => o.id} onPress={(o) => setPicked(o.id)} columns={columns} empty={busy ? "Loading…" : online ? "No online orders match." : "No orders match."} />
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
        .then((r) => setO({ ...r, lines: Array.isArray(r.lines) ? r.lines : [], payments: Array.isArray(r.payments) ? r.payments : [] }))
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
          {o.fulfillment ? fulfillmentBadge(o.fulfillmentStatus) : null}
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
          <Field label="Channel"><Text style={ui.text}>{CHANNEL[o.channel] ?? o.channel.toLowerCase()}</Text></Field>
          {o.note && <Field label="Note"><Text style={ui.text}>{o.note}</Text></Field>}
        </View>
      </Card>

      {o.fulfillment && (
        <FulfillmentCard
          order={o}
          onChanged={() => {
            load();
            onChanged();
          }}
        />
      )}

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
        {(o.shippingCents ?? 0) > 0 && <Row label="Shipping" value={money(o.shippingCents)} />}
        <Row label="Tax" value={money(o.taxCents)} />
        {o.cardAdjustmentCents > 0 && <Row label={`Card price adjustment (${(o.cardPriceBps / 100).toFixed(2)}%)`} value={money(o.cardAdjustmentCents)} />}
        <Row label="Total" value={money(charged(o))} bold />
        {returned > 0 && <Row label="Refunded" value={`−${money(returned)}`} />}
      </Card>
    </ScrollView>
  );
}

/**
 * Where an online order is on its way to the customer, and the steps that move
 * it: acknowledge → set aside → ready → shipped / picked up. Every step needs
 * FULFILL_ORDERS; the server refuses (409) a step the order isn't ready for.
 */
function FulfillmentCard({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const guard = useGuard();
  const can = useCan();
  const [extra, setExtra] = useState<Fulfillment>({});
  const [lines, setLines] = useState<PickLine[]>(order.lines);
  const [picked, setPicked] = useState<string[]>(order.pickedLineIds ?? []);
  const [form, setForm] = useState<"ready" | "ship" | "problem" | null>(null);
  const [carrier, setCarrier] = useState("USPS");
  const [carrierName, setCarrierName] = useState("");
  const [tracking, setTracking] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The queue's view of the order adds the timeline, who handled it, and SKUs on the lines.
  const apply = useCallback((r: FulfillmentOrder) => {
    const { lines: ls, ...rest } = r;
    setExtra(rest);
    if (Array.isArray(ls) && ls.length) setLines(ls);
    if (Array.isArray(r.pickedLineIds)) setPicked(r.pickedLineIds);
  }, []);
  const fetchQueue = useCallback(() => api<FulfillmentOrder>("GET", `/fulfillment/orders/${order.id}`), [order.id]);
  useEffect(() => {
    let live = true;
    fetchQueue()
      .then((r) => live && apply(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [fetchQueue, apply]);

  const o: Order = { ...order, ...extra };
  const status = o.fulfillmentStatus ?? null;
  const method = o.fulfillment ?? null;
  const open = isOpen(status);
  const canFulfill = can("FULFILL_ORDERS") !== "DENY";
  const pickable = canFulfill && (status === "NEW" || status === "ACKNOWLEDGED" || status === "PICKING");
  const saved = new Set(o.pickedLineIds ?? []);
  const savedCount = lines.filter((l) => saved.has(l.id)).length;
  const unpicked = lines.length - savedCount;
  const dirty = picked.length !== saved.size || picked.some((id) => !saved.has(id));
  const stamps: [string, string | null | undefined][] = [["CREATED", o.createdAt], ["ACKNOWLEDGED", o.acknowledgedAt], ["READY", o.readyAt], ["SHIPPED", o.shippedAt], ["PICKED_UP", o.pickedUpAt]];
  const timeline: { at: string; event: string; by?: string | null; note?: string | null }[] = o.timeline?.length ? o.timeline : stamps.flatMap(([event, at]) => (at ? [{ event, at }] : []));
  const carrierValue = carrier === "Other" ? carrierName.trim() : carrier;
  const doneAt = o.shippedAt ?? o.pickedUpAt;

  const openForm = (f: "ship" | "problem") => {
    setNote("");
    setError(null);
    setForm(form === f ? null : f);
  };
  const act = async (step: string, body: object = {}) => {
    setBusy(step);
    setError(null);
    try {
      const r = await guard("FULFILL_ORDERS", (token) => api<FulfillmentOrder>("POST", `/fulfillment/orders/${order.id}/${step}`, body, { approvalToken: token }));
      if (!r) return;
      apply(r);
      setForm(null);
      setNote("");
      setTracking("");
      onChanged();
    } catch (e) {
      // The server counts set-aside items too: ask before forcing. Any other 409 means someone else moved it on, so show where it is now.
      if (e instanceof ApiError && e.code === "NOT_ALL_PICKED") setForm("ready");
      else setError(e instanceof ApiError ? e.message : String(e));
      if (e instanceof ApiError && e.status === 409) fetchQueue().then(apply).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };
  const print = async () => {
    setError(null);
    try {
      await openDocument(`/fulfillment/orders/${order.id}/pick-ticket?format=html`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <Card title="Fulfillment" right={<Button title="Print pick ticket" kind="secondary" onPress={print} style={{ minHeight: 36, paddingVertical: 6 }} />}>
      <View style={[ui.row, { gap: 24, flexWrap: "wrap", alignItems: "flex-start" }]}>
        <Field label="Method"><Text style={ui.text}>{method ? (METHOD[method] ?? method) : "—"}</Text></Field>
        <Field label="Status">
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            {fulfillmentBadge(status) ?? <Text style={ui.muted}>—</Text>}
            {open && o.ageMinutes != null ? <Text style={ui.muted}>{age(o.ageMinutes)} old</Text> : null}
          </View>
        </Field>
        {o.fulfilledBy?.name ? <Field label="Handled by"><Text style={ui.text}>{o.fulfilledBy.name}</Text></Field> : null}
        <Field label="Customer phone"><Text style={ui.text}>{o.customerPhone ?? o.customer?.phone ?? "—"}</Text></Field>
        {o.customerNote ? <Field label="Customer note"><Text style={ui.text}>{o.customerNote}</Text></Field> : null}
        {status === "PROBLEM" && o.problemNote ? <Field label="Problem"><Text style={[ui.text, { color: colors.warn }]}>{o.problemNote}</Text></Field> : null}
        {method === "SHIP" && (
          <Field label="Ship to">
            {o.shippingAddress ? addressLines(o.shippingAddress).map((line, i) => <Text key={i} style={ui.text}>{line}</Text>) : <Text style={ui.muted}>No address</Text>}
          </Field>
        )}
        {o.carrier || o.trackingNumber ? <Field label="Shipment"><Text style={ui.text}>{[o.carrier, o.trackingNumber].filter(Boolean).join(" ")}</Text></Field> : null}
      </View>

      <Text style={[ui.text, { fontWeight: "600" }]}>Pick list · {savedCount} of {lines.length} set aside</Text>
      {lines.map((l) => {
        const on = picked.includes(l.id);
        return (
          <Pressable key={l.id} disabled={!pickable} onPress={() => setPicked((p) => (on ? p.filter((x) => x !== l.id) : [...p, l.id]))} style={[ui.row, { gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
            <View style={{ width: 26, height: 26, borderRadius: 6, borderWidth: 1, borderColor: on ? colors.good : colors.border, backgroundColor: on ? colors.good : "transparent", alignItems: "center", justifyContent: "center" }}>
              {on && <Text style={{ color: "#ffffff", fontWeight: "700" }}>✓</Text>}
            </View>
            <Thumb uri={l.imageUrl} title={l.title} size={30} />
            <View style={{ flex: 1 }}>
              <Text style={ui.text}>{l.quantity} × {l.title}</Text>
              {l.sku ? <Text style={ui.muted}>{l.sku}</Text> : null}
            </View>
          </Pressable>
        );
      })}
      {lines.length === 0 && <Text style={ui.muted}>No items.</Text>}
      {pickable && dirty && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button title={`Save set-aside (${picked.length} of ${lines.length})`} kind="secondary" onPress={() => act("pick", { pickedLineIds: picked })} busy={busy === "pick"} />
          <Button title="Undo" kind="secondary" onPress={() => setPicked(o.pickedLineIds ?? [])} />
        </View>
      )}

      {timeline.length > 0 && (
        <View style={{ gap: 2 }}>
          <Text style={ui.muted}>Timeline</Text>
          {timeline.map((t, i) => (
            <Text key={i} style={ui.text}>
              {when(t.at)} · {eventLabel(t.event)}
              {t.by ? ` · ${t.by}` : ""}
              {t.note ? ` — ${t.note}` : ""}
            </Text>
          ))}
        </View>
      )}

      {form === "ready" && (
        <View style={{ gap: 8, padding: 12, borderRadius: 8, backgroundColor: colors.panelAlt }}>
          <Text style={ui.text}>{unpicked > 0 ? `${unpicked} of ${lines.length} item${unpicked === 1 ? " isn't" : "s aren't"} set aside yet.` : "Not every item has been set aside."} Mark the order ready anyway?</Text>
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button title="Mark ready anyway" kind="danger" onPress={() => act("ready", { force: true })} busy={busy === "ready"} />
            <Button title="Cancel" kind="secondary" onPress={() => setForm(null)} />
          </View>
        </View>
      )}
      {form === "ship" && (
        <View style={{ gap: 8, padding: 12, borderRadius: 8, backgroundColor: colors.panelAlt }}>
          <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
            <Picker label="Carrier" options={CARRIERS} value={carrier} onChange={setCarrier} allowNone={false} />
            {carrier === "Other" && (
              <Field label="Carrier name">
                <Input value={carrierName} onChange={setCarrierName} placeholder="e.g. Canada Post" />
              </Field>
            )}
            <Field label="Tracking number">
              <Input value={tracking} onChange={setTracking} placeholder="Optional" />
            </Field>
          </View>
          <Field label="Note">
            <Input value={note} onChange={setNote} placeholder="Optional" />
          </Field>
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button title="Mark shipped" onPress={() => act("ship", { carrier: carrierValue, trackingNumber: tracking.trim() || undefined, note: note.trim() || undefined })} busy={busy === "ship"} disabled={!carrierValue} />
            <Button title="Cancel" kind="secondary" onPress={() => setForm(null)} />
          </View>
        </View>
      )}
      {form === "problem" && (
        <View style={{ gap: 8, padding: 12, borderRadius: 8, backgroundColor: colors.panelAlt }}>
          <Field label="What's wrong?">
            <Input value={note} onChange={setNote} placeholder="e.g. Out of stock" />
          </Field>
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button title="Flag problem" kind="danger" onPress={() => act("problem", { note: note.trim() })} busy={busy === "problem"} disabled={!note.trim()} />
            <Button title="Cancel" kind="secondary" onPress={() => setForm(null)} />
          </View>
        </View>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
      {canFulfill && status && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          {status === "NEW" && <Button title="Acknowledge" onPress={() => act("acknowledge")} busy={busy === "acknowledge"} />}
          {(status === "NEW" || status === "ACKNOWLEDGED" || status === "PICKING") && <Button title="Mark ready" kind={status === "NEW" ? "secondary" : "primary"} onPress={() => (unpicked > 0 ? setForm("ready") : act("ready"))} busy={busy === "ready" && form !== "ready"} />}
          {(status === "READY" || status === "PICKING") && method === "SHIP" && <Button title="Ship" kind={status === "READY" ? "primary" : "secondary"} onPress={() => openForm("ship")} />}
          {status === "READY" && method !== "SHIP" && <Button title="Picked up" kind="good" onPress={() => act("picked-up")} busy={busy === "picked-up"} />}
          {open && status !== "PROBLEM" && <Button title="Problem" kind="danger" onPress={() => openForm("problem")} />}
          {(status === "PROBLEM" || status === "READY") && <Button title={status === "READY" ? "Back to picking" : "Reopen"} kind="secondary" onPress={() => act("reopen")} busy={busy === "reopen"} />}
        </View>
      )}
      {canFulfill && !open && status ? (
        <Text style={ui.muted}>
          {status === "SHIPPED" ? "Shipped" : "Picked up"}
          {doneAt ? ` ${when(doneAt)}` : ""}
          {o.fulfilledBy?.name ? ` by ${o.fulfilledBy.name}` : ""}. Refund from the header if it comes back.
        </Text>
      ) : null}
      {!canFulfill && <Text style={ui.muted}>Your account can see online orders but not move them along. Ask an owner for the "Set aside, ship and hand over online orders" permission.</Text>}
    </Card>
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
