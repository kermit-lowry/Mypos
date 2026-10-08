import { formatCents } from "@mypos/shared";
import * as Print from "expo-print";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FlatList, Modal, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { openDocument } from "../admin/ui";
import { api, ApiError, apiText, type FulfillmentStatus, type OnlineOrder, type OnlineOrderLine, type OnlineOrderTotals, type ShippingAddress } from "../api";
import { useGuard } from "../approval";
import { Button } from "../components/Button";
import { SplitPane } from "../components/SplitPane";
import { useTerminal, type Terminal } from "../components/TerminalPicker";
import { Thumb } from "../components/Thumb";
import { channelLabel, useFulfillmentQueue } from "../fulfillment";
import { useLayout } from "../layout";
import { useCan, useSession } from "../session";
import { colors, ui } from "../theme";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const whenLabel = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const minutesSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 60_000;
const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
/** "12 m", "2 h", "3 d" */
const ageLabel = (m: number) => (m < 60 ? `${Math.max(0, Math.round(m))} m` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`);
const ageOf = (o: OnlineOrder) => o.ageMinutes ?? minutesSince(o.createdAt);
/** Unacknowledged orders go amber after half an hour and red after two. */
const ageColor = (o: OnlineOrder, age: number) => (o.fulfillmentStatus === "NEW" ? (age > 120 ? colors.bad : age > 30 ? colors.warn : colors.muted) : colors.muted);
const itemsLabel = (o: OnlineOrder) => {
  const n = o.items ?? o.lines?.reduce((a, l) => a + l.quantity, 0) ?? 0;
  return `${n} ${n === 1 ? "item" : "items"}`;
};
const methodLabel = (o: OnlineOrder) => (o.fulfillment === "SHIP" ? "Ship" : "Pickup");
const customerName = (o: OnlineOrder) => o.customer?.name ?? o.shippingAddress?.name ?? "Customer";
const phoneOf = (o: OnlineOrder) => o.customerPhone ?? o.customer?.phone ?? o.shippingAddress?.phone ?? null;
/** Money lives under `totals` on the server; older shapes keep it flat. */
const totalsOf = (o: OnlineOrder): OnlineOrderTotals => ({
  subtotalCents: o.totals?.subtotalCents ?? o.subtotalCents ?? 0,
  discountCents: o.totals?.discountCents ?? o.discountCents ?? 0,
  taxCents: o.totals?.taxCents ?? o.taxCents ?? 0,
  shippingCents: o.totals?.shippingCents ?? o.shippingCents ?? 0,
  totalCents: o.totals?.totalCents ?? o.totalCents ?? 0,
  cardAdjustmentCents: o.totals?.cardAdjustmentCents ?? o.cardAdjustmentCents ?? 0,
  chargedCents: o.totals?.chargedCents ?? (o.totals?.totalCents ?? o.totalCents ?? 0) + (o.totals?.cardAdjustmentCents ?? o.cardAdjustmentCents ?? 0),
});
/** A line still to set aside (fully refunded ones aren't). */
const needsPick = (l: OnlineOrderLine) => l.quantity > (l.refundedQty ?? 0);

const OPEN: FulfillmentStatus[] = ["NEW", "ACKNOWLEDGED", "PICKING", "READY"];
const DONE: FulfillmentStatus[] = ["SHIPPED", "PICKED_UP"];
const ALL_STATUSES: FulfillmentStatus[] = [...OPEN, "PROBLEM", ...DONE];

function statusLabel(o: OnlineOrder): string {
  switch (o.fulfillmentStatus) {
    case "NEW":
      return "New";
    case "ACKNOWLEDGED":
      return "Acknowledged";
    case "PICKING":
      return "Setting aside";
    case "READY":
      return o.fulfillment === "SHIP" ? "Ready to ship" : "Ready for pickup";
    case "SHIPPED":
      return "Shipped";
    case "PICKED_UP":
      return "Picked up";
    case "PROBLEM":
      return "Problem";
    default:
      return String(o.fulfillmentStatus ?? "");
  }
}
const statusColor = (s: FulfillmentStatus) => (s === "NEW" ? colors.warn : s === "READY" ? colors.good : s === "PROBLEM" ? colors.bad : DONE.includes(s) ? colors.muted : colors.text);

/** Audit actions on the timeline. */
const EVENT_LABEL: Record<string, string> = {
  ORDER_PLACED: "Placed",
  ORDER_ACKNOWLEDGED: "Acknowledged",
  ORDER_PICKED: "Items set aside",
  ORDER_READY: "Ready",
  ORDER_SHIPPED: "Shipped",
  ORDER_PICKED_UP: "Picked up",
  ORDER_PROBLEM: "Problem",
  ORDER_REOPENED: "Reopened",
  ORDER_REFUNDED: "Refunded",
  REFUND: "Refunded",
};
const eventLabel = (e: string) => {
  const known = EVENT_LABEL[e];
  if (known) return known;
  const words = e.replace(/^ORDER_/, "").toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function Row({ label, value, big, color }: { label: string; value: number | string; big?: boolean; color?: string }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
      <Text style={[big ? ui.h2 : ui.muted, { flex: 1 }]}>{label}</Text>
      <Text style={[big ? ui.h2 : ui.text, color ? { color } : null]}>{typeof value === "number" ? formatCents(value) : value}</Text>
    </View>
  );
}

function ChannelBadge({ channel }: { channel: string }) {
  return (
    <View style={{ paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6, backgroundColor: colors.panelAlt, borderWidth: 1, borderColor: colors.border }}>
      <Text style={[ui.muted, { fontSize: 12, fontWeight: "700" }]}>{channelLabel(channel)}</Text>
    </View>
  );
}

/**
 * Web: the HTML ticket in a new tab. Device: the register's receipt printer,
 * else the system print dialog with the same HTML.
 */
function PrintPickTicket({ orderId, terminal }: { orderId: string; terminal: Terminal | null }) {
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<string>) =>
    fn()
      .then(setMsg)
      .catch((e) => setMsg(errorMessage(e)));
  const htmlPath = `/fulfillment/orders/${orderId}/pick-ticket?format=html`;
  return (
    <View style={{ gap: 6 }}>
      <View style={[ui.row, { gap: 8 }]}>
        {Platform.OS === "web" ? (
          <Button title="Print pick ticket" kind="secondary" style={{ flex: 1 }} onPress={() => run(async () => (await openDocument(htmlPath), "Opened in a new tab"))} />
        ) : (
          <>
            {terminal?.receiptPrinterHost && (
              <Button
                title="Print pick ticket"
                kind="secondary"
                style={{ flex: 1 }}
                onPress={() =>
                  run(async () => {
                    await api("POST", `/fulfillment/orders/${orderId}/pick-ticket/print`, { terminalId: terminal.id });
                    return "Printing on the receipt printer";
                  })
                }
              />
            )}
            <Button
              title={terminal?.receiptPrinterHost ? "Other printer…" : "Print pick ticket"}
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

// ─── List ────────────────────────────────────────────────────────

type Filter = "NEW" | "PICKING" | "READY" | "PROBLEM" | "DONE" | "ALL";
/** Chip, its label, and the statuses it asks the server for. */
const FILTERS: [Filter, string, string | null][] = [
  ["NEW", "New", "NEW"],
  ["PICKING", "To set aside", "ACKNOWLEDGED,PICKING"],
  ["READY", "Ready", "READY"],
  ["PROBLEM", "Problem", "PROBLEM"],
  ["DONE", "Done", "SHIPPED,PICKED_UP"],
  // The server's default is open orders only; "All" asks for the finished ones too.
  ["ALL", "All", ALL_STATUSES.join(",")],
];

/**
 * Online orders for this store: acknowledge them as they come in, tick the
 * items off as they're set aside, then hand them over or ship them. `focus`
 * opens an order from a toast or the header badge.
 */
export function OnlineOrdersScreen({ focus }: { focus?: { id: string; at: number } | null }) {
  const { location } = useSession();
  const { narrow } = useLayout();
  const { counts, latest, markSeen, refresh: refreshQueue } = useFulfillmentQueue();
  const terminalState = useTerminal();
  const [filter, setFilter] = useState<Filter>("NEW");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<OnlineOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const polled = useRef(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ locationId: location.id, take: "100" });
    const status = FILTERS.find(([f]) => f === filter)?.[2];
    if (status) params.set("status", status);
    const query = q.trim().replace(/^#/, "");
    if (query) params.set("q", query);
    try {
      const list = (await api<OnlineOrder[]>("GET", `/fulfillment/orders?${params}`)) ?? [];
      setRows(filter === "DONE" ? list.filter((o) => isToday(o.shippedAt ?? o.pickedUpAt ?? o.createdAt)) : list);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [location.id, filter, q]);
  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);

  // Someone's looking at the queue now; and each poll (a new order, or another
  // register moving one on) refreshes the list too.
  useEffect(() => {
    markSeen();
    if (polled.current) void load();
    polled.current = true;
  }, [latest]);

  useEffect(() => {
    if (!focus) return;
    setSelectedId(focus.id);
    setShowDetail(true);
  }, [focus?.at]);

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([load(), refreshQueue()]);
    setRefreshing(false);
  };

  const chipCount: Partial<Record<Filter, number>> = { NEW: counts.NEW, PICKING: counts.ACKNOWLEDGED + counts.PICKING, READY: counts.READY, PROBLEM: counts.PROBLEM };
  const chips = FILTERS.map(([key, title]) => {
    const n = chipCount[key];
    return (
      <Pressable key={key} onPress={() => setFilter(key)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: filter === key ? colors.accent : colors.panelAlt }}>
        <Text style={ui.text}>
          {title}
          {n ? ` ${n}` : ""}
        </Text>
      </Pressable>
    );
  });

  const list = (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={[ui.row, { gap: 8 }]}>
        <TextInput style={[ui.input, { flex: 1 }]} value={q} onChangeText={setQ} placeholder="Customer or order #" placeholderTextColor={colors.muted} autoCorrect={false} />
        <Pressable onPress={refreshAll} disabled={refreshing} style={{ padding: 10 }}>
          <Text style={{ color: colors.link }}>Refresh</Text>
        </Pressable>
      </View>
      {narrow ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6 }}>
          {chips}
        </ScrollView>
      ) : (
        <View style={[ui.row, { flexWrap: "wrap", gap: 6 }]}>{chips}</View>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
      <FlatList
        style={{ flex: 1 }}
        data={rows ?? []}
        keyExtractor={(o) => o.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={colors.muted} />}
        ListEmptyComponent={<Text style={[ui.muted, { padding: 16, textAlign: "center" }]}>{rows ? "No online orders here." : "Loading…"}</Text>}
        renderItem={({ item: o }) => (
          <OrderRow
            order={o}
            selected={o.id === selectedId}
            onPress={() => {
              setSelectedId(o.id);
              setShowDetail(true);
            }}
          />
        )}
      />
    </View>
  );

  return (
    <SplitPane
      leftLabel="Orders"
      rightLabel="Order"
      showRight={showDetail}
      onToggle={setShowDetail}
      left={list}
      right={
        selectedId ? (
          <OrderDetail
            key={selectedId}
            id={selectedId}
            terminalState={terminalState}
            onChanged={() => {
              void load();
              void refreshQueue();
            }}
          />
        ) : (
          <Text style={[ui.muted, { textAlign: "center", marginTop: 40 }]}>Pick an order to set its items aside.</Text>
        )
      }
    />
  );
}

function OrderRow({ order: o, selected, onPress }: { order: OnlineOrder; selected: boolean; onPress: () => void }) {
  const age = ageOf(o);
  return (
    <Pressable
      onPress={onPress}
      style={{ paddingVertical: 10, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.border, borderRadius: 8, backgroundColor: selected ? colors.panelAlt : "transparent" }}
    >
      <View style={[ui.row, { gap: 8 }]}>
        <ChannelBadge channel={o.channel} />
        <Text style={[ui.text, { flex: 1, fontWeight: "600" }]} numberOfLines={1}>
          #{o.number} · {customerName(o)}
        </Text>
        <Text style={ui.text}>{formatCents(totalsOf(o).chargedCents ?? 0)}</Text>
      </View>
      <View style={[ui.row, { gap: 8, marginTop: 2 }]}>
        <Text style={[ui.muted, { flex: 1 }]} numberOfLines={1}>
          <Text style={{ fontWeight: "700", color: colors.text }}>{methodLabel(o)}</Text>
          {` · ${itemsLabel(o)} · `}
          <Text style={{ color: statusColor(o.fulfillmentStatus) }}>{statusLabel(o)}</Text>
        </Text>
        <Text style={[ui.muted, { color: ageColor(o, age), fontWeight: o.fulfillmentStatus === "NEW" && age > 30 ? "700" : "400" }]}>{ageLabel(age)}</Text>
      </View>
    </Pressable>
  );
}

// ─── Detail ──────────────────────────────────────────────────────

type Sheet = null | "ready-force" | "picked-up" | "ship" | "problem" | "phone";
const PICK_DEBOUNCE_MS = 400;

function OrderDetail({ id, terminalState, onChanged }: { id: string; terminalState: ReturnType<typeof useTerminal>; onChanged: () => void }) {
  const can = useCan();
  const guard = useGuard();
  const level = can("FULFILL_ORDERS");
  const pin = level === "PIN" ? " · PIN" : "";
  const [order, setOrder] = useState<OnlineOrder | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const live = useRef(true);
  const pickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickSeq = useRef(0);

  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const apply = (o: OnlineOrder) => {
    setOrder(o);
    setPicked(new Set(o.pickedLineIds ?? []));
  };
  const load = useCallback(async () => {
    try {
      const o = await api<OnlineOrder>("GET", `/fulfillment/orders/${id}`);
      if (!live.current) return;
      apply(o);
      setError(null);
    } catch (e) {
      if (live.current) setError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const post = (step: string, body?: unknown) => guard("FULFILL_ORDERS", (t) => api<OnlineOrder>("POST", `/fulfillment/orders/${id}/${step}`, body, { approvalToken: t }));

  /** One step of the order. Throws so a sheet can show the error; undefined if the PIN prompt was cancelled. */
  const run = async (step: string, body?: unknown): Promise<OnlineOrder | undefined> => {
    try {
      const r = await post(step, body);
      if (r) {
        apply(r);
        onChanged();
      }
      return r;
    } catch (e) {
      if (e instanceof ApiError && e.code === "FULFILLMENT_STATE") {
        // Another register got there first: show where the order is now.
        void load();
        onChanged();
        throw new ApiError(e.status, e.code, "This order was moved on from another register. It's been refreshed.", e.details);
      }
      throw e;
    }
  };

  /** An inline step button. */
  async function press(name: string, step: string, body?: unknown, done?: string) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const r = await run(step, body);
      if (r && done) setNotice(done);
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_ALL_PICKED") setSheet("ready-force");
      else setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** Tick a line off: shown at once, sent after a short pause so a run of taps is one request. */
  function toggle(lineId: string) {
    if (!order) return;
    const next = new Set(picked);
    if (next.has(lineId)) next.delete(lineId);
    else next.add(lineId);
    setPicked(next);
    setError(null);
    if (pickTimer.current) clearTimeout(pickTimer.current);
    const seq = ++pickSeq.current;
    const before = order.pickedLineIds ?? [];
    pickTimer.current = setTimeout(async () => {
      pickTimer.current = null;
      try {
        const r = await post("pick", { pickedLineIds: [...next] });
        if (!live.current || seq !== pickSeq.current) return;
        if (!r) return setPicked(new Set(before));
        setOrder(r);
        setPicked(new Set(r.pickedLineIds ?? [...next]));
        onChanged();
      } catch (e) {
        if (!live.current || seq !== pickSeq.current) return;
        setError(e instanceof ApiError && e.code === "FULFILLMENT_STATE" ? "This order was moved on from another register. It's been refreshed." : errorMessage(e));
        void load();
      }
    }, PICK_DEBOUNCE_MS);
  }

  if (!order) return error ? <Text style={ui.error}>{error}</Text> : <Text style={ui.muted}>Loading…</Text>;
  const o = order;
  const s = o.fulfillmentStatus;
  const lines = o.lines ?? [];
  const toPick = lines.filter(needsPick);
  const pickedCount = toPick.filter((l) => picked.has(l.id)).length;
  const allPicked = toPick.length > 0 && pickedCount === toPick.length;
  const isOpen = OPEN.includes(s);
  // Ticking from NEW acknowledges the order on the server too.
  const canPick = level !== "DENY" && (s === "NEW" || s === "ACKNOWLEDGED" || s === "PICKING");
  const phone = phoneOf(o);
  const age = ageOf(o);
  const totals = totalsOf(o);

  return (
    <>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 12 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={colors.muted}
          />
        }
      >
        <View style={[ui.row, { justifyContent: "space-between", flexWrap: "wrap", gap: 8 }]}>
          <Text style={ui.h1}>
            #{o.number} · {methodLabel(o)} · {channelLabel(o.channel)}
          </Text>
          <Text style={[ui.text, { fontWeight: "600", color: statusColor(s) }]}>{statusLabel(o)}</Text>
        </View>

        <View style={{ gap: 2 }}>
          <Text style={ui.h2}>{customerName(o)}</Text>
          {phone && (
            <Pressable onPress={() => setSheet("phone")} accessibilityRole="button" accessibilityLabel="Show the phone number large">
              <Text style={{ color: colors.link, fontSize: 16 }}>{phone}</Text>
            </Pressable>
          )}
          {!!o.customer?.email && <Text style={ui.muted}>{o.customer.email}</Text>}
          <Text style={[ui.muted, s === "NEW" ? { color: ageColor(o, age) } : null]}>
            Placed {whenLabel(o.createdAt)} · {ageLabel(age)} ago
          </Text>
        </View>

        {!!o.customerNote && (
          <View style={{ backgroundColor: colors.panelAlt, borderLeftWidth: 3, borderLeftColor: colors.warn, borderRadius: 8, padding: 10, gap: 2 }}>
            <Text style={[ui.muted, { color: colors.warn, fontWeight: "600" }]}>Customer note</Text>
            <Text style={ui.text}>{o.customerNote}</Text>
          </View>
        )}

        {o.fulfillment === "SHIP" && <Address address={o.shippingAddress} carrier={o.carrier} trackingNumber={o.trackingNumber} />}

        {s === "PICKED_UP" && (
          <Text style={[ui.text, { color: colors.good }]}>
            Picked up {o.pickedUpAt ? whenLabel(o.pickedUpAt) : ""}
            {o.fulfilledBy?.name ? ` · handed over by ${o.fulfilledBy.name}` : ""}
          </Text>
        )}
        {s === "SHIPPED" && (
          <Text style={[ui.text, { color: colors.good }]}>
            Shipped {o.shippedAt ? whenLabel(o.shippedAt) : ""}
            {o.fulfilledBy?.name ? ` · by ${o.fulfilledBy.name}` : ""}
          </Text>
        )}
        {s === "PROBLEM" && (
          <View style={{ backgroundColor: colors.panelAlt, borderLeftWidth: 3, borderLeftColor: colors.bad, borderRadius: 8, padding: 10, gap: 2 }}>
            <Text style={[ui.muted, { color: colors.bad, fontWeight: "600" }]}>Parked as a problem</Text>
            <Text style={ui.text}>{o.problemNote || "Reopen it to carry on."}</Text>
          </View>
        )}
        {!!o.note && <Text style={ui.muted}>Note: {o.note}</Text>}

        <View>
          <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
            <Text style={ui.h2}>Items</Text>
            <Text style={[ui.muted, allPicked ? { color: colors.good } : null]}>
              {pickedCount} of {toPick.length} set aside
            </Text>
          </View>
          {lines.map((l) => (
            <PickLine key={l.id} line={l} checked={picked.has(l.id)} enabled={canPick && needsPick(l)} onToggle={() => toggle(l.id)} />
          ))}
        </View>

        <View style={{ gap: 4 }}>
          <Row label="Subtotal" value={totals.subtotalCents} />
          {totals.discountCents > 0 && <Row label="Discounts" value={-totals.discountCents} />}
          <Row label="Tax" value={totals.taxCents} />
          {(o.fulfillment === "SHIP" || totals.shippingCents > 0) && <Row label="Shipping" value={totals.shippingCents} />}
          <Row label="Total" value={totals.totalCents} big />
          {totals.cardAdjustmentCents > 0 && <Row label="Card price adjustment" value={totals.cardAdjustmentCents} />}
          <Row label="Paid by card" value={totals.chargedCents ?? totals.totalCents} color={colors.good} />
          {(o.status === "PARTIALLY_REFUNDED" || o.status === "REFUNDED") && <Row label="Payment" value={o.status === "REFUNDED" ? "Refunded" : "Partly refunded"} color={colors.warn} />}
        </View>

        {notice && <Text style={[ui.text, { color: colors.good }]}>{notice}</Text>}
        {error && <Text style={ui.error}>{error}</Text>}

        {level !== "DENY" && (isOpen || s === "PROBLEM") && (
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            {s === "NEW" && (
              <Button title={`Acknowledge${pin}`} onPress={() => press("ack", "acknowledge", undefined, "Acknowledged · set the items aside")} busy={busy === "ack"} style={{ flexGrow: 1 }} />
            )}
            {(s === "ACKNOWLEDGED" || s === "PICKING") && (
              <>
                <Button
                  title={`Mark ready${pin}`}
                  kind="good"
                  disabled={!allPicked}
                  busy={busy === "ready"}
                  onPress={() => press("ready", "ready", undefined, o.fulfillment === "SHIP" ? "Ready to ship" : "Ready · the customer can be told")}
                  style={{ flexGrow: 1 }}
                />
                {!allPicked && <Button title="Mark ready anyway…" kind="secondary" onPress={() => setSheet("ready-force")} style={{ flexGrow: 1 }} />}
              </>
            )}
            {s === "READY" && o.fulfillment === "PICKUP" && <Button title={`Picked up${pin}`} kind="good" onPress={() => setSheet("picked-up")} style={{ flexGrow: 1 }} />}
            {(s === "READY" || s === "PICKING") && o.fulfillment === "SHIP" && <Button title={`Ship${pin}`} kind="good" onPress={() => setSheet("ship")} style={{ flexGrow: 1 }} />}
            {isOpen && <Button title="Problem…" kind="danger" onPress={() => setSheet("problem")} style={{ flexGrow: 1 }} />}
            {s === "PROBLEM" && <Button title={`Reopen${pin}`} onPress={() => press("reopen", "reopen", undefined, "Reopened · back to setting aside")} busy={busy === "reopen"} style={{ flexGrow: 1 }} />}
            {s === "READY" && (
              <Button title="Not ready after all" kind="secondary" onPress={() => press("reopen", "reopen", undefined, "Back to setting aside")} busy={busy === "reopen"} style={{ flexGrow: 1 }} />
            )}
          </View>
        )}

        <PrintPickTicket orderId={o.id} terminal={terminalState.terminal} />
        <Timeline order={o} />
      </ScrollView>

      {sheet === "phone" && phone && (
        <Sheet title={customerName(o)} onClose={() => setSheet(null)}>
          <Text style={{ color: colors.text, fontSize: 44, fontWeight: "700", textAlign: "center", letterSpacing: 1 }}>{phone}</Text>
          <Button title="Close" kind="secondary" onPress={() => setSheet(null)} />
        </Sheet>
      )}
      {sheet === "ready-force" && (
        <ConfirmSheet
          title={`Mark #${o.number} ready anyway?`}
          message={`${toPick.length - pickedCount} of ${toPick.length} items aren't ticked off. Mark it ready only if everything is set aside.${pin ? " Needs a manager's PIN." : ""}`}
          confirmLabel={`Mark ready anyway${pin}`}
          onSubmit={async () => !!(await run("ready", { force: true }))}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "picked-up" && (
        <NoteSheet
          title={`Hand over #${o.number}`}
          message={`Confirm the customer's name or ID matches ${customerName(o)}.${pin ? " Needs a manager's PIN." : ""}`}
          placeholder="Note (optional)"
          confirmLabel={`Picked up${pin}`}
          kind="good"
          onSubmit={async (note) => !!(await run("picked-up", { note: note || undefined }))}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "problem" && (
        <NoteSheet
          title={`Problem with #${o.number}`}
          message="What's wrong (out of stock, damaged, can't reach the customer…)? The order is parked until it's reopened."
          placeholder="What's the problem?"
          required
          confirmLabel="Mark as problem"
          kind="danger"
          onSubmit={async (note) => !!(await run("problem", { note }))}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "ship" && <ShipSheet order={o} pin={pin} onSubmit={async (body) => !!(await run("ship", body))} onClose={() => setSheet(null)} />}
    </>
  );
}

function PickLine({ line: l, checked, enabled, onToggle }: { line: OnlineOrderLine; checked: boolean; enabled: boolean; onToggle: () => void }) {
  const refunded = l.refundedQty ?? 0;
  const detail = [l.sku, l.unitPriceCents != null ? formatCents(l.unitPriceCents) : null, refunded > 0 ? (refunded >= l.quantity ? "refunded" : `${refunded} refunded`) : null].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={onToggle}
      disabled={!enabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !enabled }}
      style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", gap: 10 }}
    >
      <Thumb uri={l.imageUrl} title={l.title} size={40} />
      <View style={{ flex: 1 }}>
        <Text style={[ui.text, checked ? { color: colors.muted, textDecorationLine: "line-through" } : null]} numberOfLines={2}>
          {l.title}
        </Text>
        <Text style={[ui.muted, refunded >= l.quantity ? { color: colors.warn } : null]}>{detail}</Text>
      </View>
      <Text style={[ui.h2, { minWidth: 34, textAlign: "right" }, refunded >= l.quantity ? { color: colors.muted, textDecorationLine: "line-through" } : null]}>×{l.quantity}</Text>
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 7,
          borderWidth: 2,
          borderColor: checked ? colors.good : enabled ? colors.muted : colors.border,
          backgroundColor: checked ? colors.good : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Text style={{ color: "#ffffff", fontSize: 18, fontWeight: "700" }}>✓</Text>}
      </View>
    </Pressable>
  );
}

function Address({ address: a, carrier, trackingNumber }: { address: ShippingAddress | null | undefined; carrier?: string | null; trackingNumber?: string | null }) {
  const lines = a ? [a.name, a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(", "), a.country, a.phone].filter((x): x is string => !!x) : [];
  return (
    <View style={{ backgroundColor: colors.panelAlt, borderRadius: 8, padding: 10, gap: 2 }}>
      <Text style={[ui.muted, { fontWeight: "600" }]}>Ship to</Text>
      {lines.length === 0 ? <Text style={ui.error}>No shipping address on the order.</Text> : lines.map((x, i) => <Text key={i} style={ui.text}>{x}</Text>)}
      {!!(carrier || trackingNumber) && (
        <Text style={[ui.muted, { marginTop: 4 }]}>
          {[carrier, trackingNumber].filter(Boolean).join(" · ")}
        </Text>
      )}
    </View>
  );
}

function Timeline({ order: o }: { order: OnlineOrder }) {
  const events = o.timeline ?? [];
  if (events.length === 0) return null;
  return (
    <View>
      <Text style={ui.h2}>Timeline</Text>
      {events.map((t, i) => (
        <View key={i} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
            <Text style={[ui.text, { flex: 1 }]} numberOfLines={2}>
              {eventLabel(t.event)}
              {t.by ? ` · ${t.by}` : ""}
            </Text>
            <Text style={ui.muted}>{whenLabel(t.at)}</Text>
          </View>
          {!!t.note && <Text style={ui.muted}>{t.note}</Text>}
        </View>
      ))}
    </View>
  );
}

// ─── Sheets ──────────────────────────────────────────────────────

function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const { dialog } = useLayout();
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: dialog(460), maxHeight: "90%", flexGrow: 0 }]} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
          <Text style={ui.h1}>{title}</Text>
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** Runs `onSubmit`, shows what went wrong, closes when it returns true. */
function useSubmit(onSubmit: () => Promise<boolean>, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (await onSubmit()) onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function ConfirmSheet(props: { title: string; message: string; confirmLabel: string; onSubmit: () => Promise<boolean>; onClose: () => void }) {
  const { busy, error, submit } = useSubmit(props.onSubmit, props.onClose);
  return (
    <Sheet title={props.title} onClose={props.onClose}>
      <Text style={ui.muted}>{props.message}</Text>
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8 }]}>
        <Button title="Back" kind="secondary" onPress={props.onClose} disabled={busy} />
        <Button title={props.confirmLabel} kind="good" onPress={submit} busy={busy} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}

function NoteSheet(props: {
  title: string;
  message: string;
  placeholder: string;
  required?: boolean;
  confirmLabel: string;
  kind: "good" | "danger" | "primary";
  onSubmit: (note: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const { busy, error, submit } = useSubmit(() => props.onSubmit(note.trim()), props.onClose);
  const valid = !props.required || note.trim() !== "";
  return (
    <Sheet title={props.title} onClose={props.onClose}>
      <Text style={ui.muted}>{props.message}</Text>
      <TextInput style={ui.input} value={note} onChangeText={setNote} placeholder={props.placeholder} placeholderTextColor={colors.muted} autoFocus={props.required} multiline />
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8 }]}>
        <Button title="Cancel" kind="secondary" onPress={props.onClose} disabled={busy} />
        <Button title={props.confirmLabel} kind={props.kind} onPress={submit} busy={busy} disabled={!valid} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}

const CARRIERS = ["USPS", "UPS", "FedEx", "DHL", "Other"];

function ShipSheet(props: { order: OnlineOrder; pin: string; onSubmit: (body: { carrier: string; trackingNumber?: string; note?: string }) => Promise<boolean>; onClose: () => void }) {
  const [carrier, setCarrier] = useState<string>(props.order.carrier && CARRIERS.includes(props.order.carrier) ? props.order.carrier : props.order.carrier ? "Other" : "");
  const [other, setOther] = useState(props.order.carrier && !CARRIERS.includes(props.order.carrier) ? props.order.carrier : "");
  const [tracking, setTracking] = useState(props.order.trackingNumber ?? "");
  const [note, setNote] = useState("");
  const name = carrier === "Other" ? other.trim() : carrier;
  const { busy, error, submit } = useSubmit(() => props.onSubmit({ carrier: name, trackingNumber: tracking.trim() || undefined, note: note.trim() || undefined }), props.onClose);
  return (
    <Sheet title={`Ship #${props.order.number}`} onClose={props.onClose}>
      <Text style={ui.muted}>
        To {props.order.shippingAddress?.name ?? customerName(props.order)}
        {props.order.shippingAddress?.city ? `, ${props.order.shippingAddress.city}` : ""}. The customer gets the tracking number.{props.pin ? " Needs a manager's PIN." : ""}
      </Text>
      <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
        {CARRIERS.map((c) => (
          <Pressable key={c} onPress={() => setCarrier(c)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: carrier === c ? colors.accent : colors.panelAlt }}>
            <Text style={ui.text}>{c}</Text>
          </Pressable>
        ))}
      </View>
      {carrier === "Other" && <TextInput style={ui.input} value={other} onChangeText={setOther} placeholder="Carrier" placeholderTextColor={colors.muted} autoFocus />}
      <TextInput style={ui.input} value={tracking} onChangeText={setTracking} placeholder="Tracking number (optional)" placeholderTextColor={colors.muted} autoCapitalize="characters" autoCorrect={false} />
      <TextInput style={ui.input} value={note} onChangeText={setNote} placeholder="Note (optional)" placeholderTextColor={colors.muted} />
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8 }]}>
        <Button title="Cancel" kind="secondary" onPress={props.onClose} disabled={busy} />
        <Button title={name ? `Shipped with ${name}${props.pin}` : `Ship${props.pin}`} kind="good" onPress={submit} busy={busy} disabled={!name} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}
