import { cardPrice, formatBps, formatCents, type Permission, type PermissionLevel, type TenderInput } from "@mypos/shared";
import * as Print from "expo-print";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Modal, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { openDocument } from "../admin/ui";
import { api, ApiError, apiText, type Customer, type Layaway, type LayawayLine, type LayawayPayment } from "../api";
import { useGuard } from "../approval";
import { Button } from "../components/Button";
import { NumberPrompt } from "../components/NumberPrompt";
import { SplitPane } from "../components/SplitPane";
import { amountTotals, changeFor, TenderSheet } from "../components/TenderSheet";
import { useTerminal, type Terminal } from "../components/TerminalPicker";
import { Thumb } from "../components/Thumb";
import { useLayout } from "../layout";
import { useCan, useSession } from "../session";
import { colors, ui } from "../theme";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** "Oct 30, 2026" */
export const dayLabel = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
const whenLabel = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const lineCount = (l: Layaway) => l.lineCount ?? l._count?.lines ?? l.lines?.length;
const tenderName = (t: string) => (t === "LOYALTY" ? "Rewards" : t.charAt(0) + t.slice(1).toLowerCase().replace("_", " "));

/** Friendlier wording for the layaway errors a cashier can act on. */
export function layawayError(e: unknown): unknown {
  if (!(e instanceof ApiError)) return e;
  const d = (e.details ?? {}) as { minimumCents?: number; balanceCents?: number };
  const message =
    e.code === "DEPOSIT_TOO_SMALL"
      ? d.minimumCents != null
        ? `The deposit must be at least ${formatCents(d.minimumCents)}`
        : "The deposit is below the store's minimum"
      : e.code === "OVERPAID"
        ? `That's more than the balance${d.balanceCents != null ? ` (${formatCents(d.balanceCents)})` : ""}`
        : e.code === "BALANCE_DUE"
          ? `${formatCents(d.balanceCents ?? 0)} is still owed. Take the payment first.`
          : e.code === "LAYAWAY_NO_MANUAL_DISCOUNT"
            ? "Layaways can't carry manual discounts. Remove them from the cart first; deals still apply."
            : e.code === "LAYAWAY_DISABLED"
              ? "Layaway is turned off for this store."
              : null;
  return message ? new ApiError(e.status, e.code, message, e.details) : e;
}

/** Whether an APPROVAL_REQUIRED error names this permission. */
function asksFor(e: ApiError, permission: Permission): boolean {
  const d = (e.details ?? {}) as { permission?: Permission; permissions?: Permission[] };
  return d.permission === permission || !!d.permissions?.includes(permission);
}

function Row({ label, value, big, color }: { label: string; value: number | string; big?: boolean; color?: string }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
      <Text style={[big ? ui.h2 : ui.muted, { flex: 1 }]}>{label}</Text>
      <Text style={[big ? ui.h2 : ui.text, color ? { color } : null]}>{typeof value === "number" ? formatCents(value) : value}</Text>
    </View>
  );
}

/**
 * Web: the HTML statement in a new tab. Device: the register's receipt printer,
 * or the system print dialog. With `auto` (a cash payment) it prints on the
 * receipt printer by itself and pops the drawer for change.
 */
export function PrintStatement({ layawayId, terminal, auto }: { layawayId: string; terminal: Terminal | null; auto?: boolean }) {
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<string>) =>
    fn()
      .then(setMsg)
      .catch((e) => setMsg(errorMessage(e)));
  const htmlPath = `/layaways/${layawayId}/receipt?format=html`;
  const printOnRegister = (openDrawer: boolean) =>
    run(async () => {
      await api("POST", `/layaways/${layawayId}/receipt/print`, { terminalId: terminal!.id, openDrawer: openDrawer || undefined });
      return openDrawer ? "Statement printed · drawer open" : "Printing on the receipt printer";
    });
  useEffect(() => {
    if (auto && terminal?.receiptPrinterHost) void printOnRegister(true);
  }, [layawayId]);
  return (
    <View style={{ gap: 6 }}>
      <View style={[ui.row, { gap: 8 }]}>
        {Platform.OS === "web" ? (
          <Button title="Print statement" kind="secondary" style={{ flex: 1 }} onPress={() => run(async () => (await openDocument(htmlPath), "Opened in a new tab"))} />
        ) : (
          <>
            {terminal && <Button title="Print statement" kind="secondary" style={{ flex: 1 }} onPress={() => printOnRegister(false)} />}
            <Button
              title={terminal ? "Other printer…" : "Print statement"}
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

type Filter = "ACTIVE" | "OVERDUE" | "COMPLETED" | "CANCELLED" | "ALL";
const FILTERS: [Filter, string][] = [
  ["ACTIVE", "Active"],
  ["OVERDUE", "Overdue"],
  ["COMPLETED", "Completed"],
  ["CANCELLED", "Cancelled"],
  ["ALL", "All"],
];

/**
 * Layaways at this store: find one by customer or number, then take a
 * payment, hand the items over (which creates the sale), or cancel it.
 */
export function LayawayScreen() {
  const { location } = useSession();
  const { narrow } = useLayout();
  const terminalState = useTerminal();
  const [filter, setFilter] = useState<Filter>("ACTIVE");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Layaway[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ locationId: location.id, take: "100" });
    if (filter === "OVERDUE") {
      params.set("status", "ACTIVE");
      params.set("overdue", "true");
    } else if (filter !== "ALL") params.set("status", filter);
    const query = q.trim().replace(/^#/, "");
    if (query) params.set("q", query);
    try {
      setRows(await api<Layaway[]>("GET", `/layaways?${params}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [location.id, filter, q]);
  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);

  const chips = FILTERS.map(([key, title]) => (
    <Pressable key={key} onPress={() => setFilter(key)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: filter === key ? colors.accent : colors.panelAlt }}>
      <Text style={ui.text}>{title}</Text>
    </Pressable>
  ));

  const list = (
    <View style={{ flex: 1, gap: 8 }}>
      <TextInput style={ui.input} value={q} onChangeText={setQ} placeholder="Customer or layaway #" placeholderTextColor={colors.muted} autoCorrect={false} />
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
        keyExtractor={(l) => l.id}
        ListEmptyComponent={<Text style={[ui.muted, { padding: 16, textAlign: "center" }]}>{rows ? "No layaways here." : "Loading…"}</Text>}
        renderItem={({ item: l }) => (
          <LayawayRow
            layaway={l}
            selected={l.id === selectedId}
            onPress={() => {
              setSelectedId(l.id);
              setShowDetail(true);
            }}
          />
        )}
      />
    </View>
  );

  return (
    <SplitPane
      leftLabel="Layaways"
      rightLabel="Details"
      showRight={showDetail}
      onToggle={setShowDetail}
      left={list}
      right={
        selectedId ? (
          <LayawayDetail key={selectedId} id={selectedId} terminalState={terminalState} onChanged={load} />
        ) : (
          <Text style={[ui.muted, { textAlign: "center", marginTop: 40 }]}>Pick a layaway to see its items and payments.</Text>
        )
      }
    />
  );
}

function LayawayRow({ layaway: l, selected, onPress }: { layaway: Layaway; selected: boolean; onPress: () => void }) {
  const n = lineCount(l);
  const overdue = l.status === "ACTIVE" && l.overdue;
  const when =
    l.status === "ACTIVE"
      ? `Due ${dayLabel(l.dueAt)}${overdue ? " · overdue" : ""}`
      : l.status === "COMPLETED"
        ? `Picked up ${dayLabel(l.completedAt ?? l.dueAt)}`
        : `Cancelled ${dayLabel(l.cancelledAt ?? l.dueAt)}`;
  return (
    <Pressable
      onPress={onPress}
      style={{ paddingVertical: 10, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.border, borderRadius: 8, backgroundColor: selected ? colors.panelAlt : "transparent" }}
    >
      <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
        <Text style={[ui.text, { flex: 1, fontWeight: "600" }]} numberOfLines={1}>
          #{l.number} · {l.customer?.name ?? "Customer"}
        </Text>
        <Text style={ui.text}>{formatCents(l.totalCents)}</Text>
      </View>
      <Text style={ui.muted}>
        {[n !== undefined ? `${n} ${n === 1 ? "item" : "items"}` : null, `paid ${formatCents(l.paidCents)}`, `balance ${formatCents(l.balanceCents)}`].filter(Boolean).join(" · ")}
      </Text>
      <Text style={[ui.muted, overdue ? { color: colors.bad } : null]}>{when}</Text>
    </Pressable>
  );
}

// ─── Detail ──────────────────────────────────────────────────────

type Action = null | { kind: "amount" } | { kind: "pay"; amountCents: number; pickup: boolean } | { kind: "cancel" };
interface Paid {
  layaway: Layaway;
  tenders: TenderInput[];
  pickup: boolean;
}
interface Completed {
  layaway: Layaway;
  order: { id: string; number: number };
}

function LayawayDetail({ id, terminalState, onChanged }: { id: string; terminalState: ReturnType<typeof useTerminal>; onChanged: () => void }) {
  const { location } = useSession();
  const can = useCan();
  const guard = useGuard();
  const [layaway, setLayaway] = useState<Layaway | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [paid, setPaid] = useState<Paid | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const l = await api<Layaway>("GET", `/layaways/${id}`);
      setLayaway(l);
      setError(null);
      // The customer's live store-credit balance, to pay with it.
      setCustomer(await api<Customer>("GET", `/customers/${l.customerId}`).catch(() => null));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const terminalId = terminalState.terminal?.id;
  const completeLayaway = () =>
    guard("LAYAWAY_CREATE", (t) => api<Completed>("POST", `/layaways/${id}/complete`, undefined, { approvalToken: t }));

  /** Nothing owed: hand the items over and create the sale. */
  async function pickUpNow() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await completeLayaway();
      if (r) {
        setNotice(`Sale #${r.order.number} created`);
        await load();
        onChanged();
      }
    } catch (e) {
      setError(errorMessage(layawayError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(input: { toStoreCredit: boolean; waiveFee: boolean; reason: string }): Promise<boolean> {
    const body = { toStoreCredit: input.toStoreCredit, waiveFee: input.waiveFee || undefined, reason: input.reason || undefined, terminalId };
    const run = (t?: string) => api<Layaway>("POST", `/layaways/${id}/cancel`, body, { approvalToken: t });
    let r: Layaway | undefined;
    try {
      r = await guard("LAYAWAY_CANCEL", run);
    } catch (e) {
      // Waiving the fee is a manager's call: their PIN approves it, then the same request goes again.
      if (!(e instanceof ApiError) || e.code !== "APPROVAL_REQUIRED" || !asksFor(e, "LAYAWAY_MANAGE")) throw e;
      r = await guard("LAYAWAY_MANAGE", run);
    }
    if (!r) return false;
    setNotice(`Cancelled · ${formatCents(r.refundedCents)} refunded${input.toStoreCredit ? " to store credit" : ""}`);
    await load();
    onChanged();
    return true;
  }

  /** Close the payment sheet; after a payment, show the new balance. */
  function closeSheet() {
    setAction(null);
    if (paid) {
      setPaid(null);
      void load();
    }
  }

  if (!layaway) return error ? <Text style={ui.error}>{error}</Text> : <Text style={ui.muted}>Loading…</Text>;
  const l = layaway;
  const active = l.status === "ACTIVE";
  const overdue = active && l.overdue;
  const bps = l.cardPriceBps ?? location.cardPriceBps;
  const createLevel = can("LAYAWAY_CREATE");
  const cancelLevel = can("LAYAWAY_CANCEL");
  const pin = createLevel === "PIN" ? " · PIN" : "";

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
        <View style={[ui.row, { justifyContent: "space-between", flexWrap: "wrap", gap: 8 }]}>
          <Text style={ui.h1}>Layaway #{l.number}</Text>
          <Text style={[ui.text, { fontWeight: "600", color: l.status === "CANCELLED" || overdue ? colors.bad : l.status === "COMPLETED" ? colors.muted : colors.good }]}>
            {l.status === "ACTIVE" ? (overdue ? "Overdue" : "Active") : l.status === "COMPLETED" ? "Picked up" : "Cancelled"}
          </Text>
        </View>
        <View style={{ gap: 2 }}>
          <Text style={ui.h2}>{l.customer?.name ?? customer?.name ?? "Customer"}</Text>
          {!!(l.customer?.phone || l.customer?.email) && <Text style={ui.muted}>{[l.customer?.phone, l.customer?.email].filter(Boolean).join(" · ")}</Text>}
          <Text style={ui.muted}>
            Opened {dayLabel(l.createdAt)}
            {l.staff?.name ? ` by ${l.staff.name}` : ""}
          </Text>
          {!!l.notes && <Text style={ui.muted}>{l.notes}</Text>}
        </View>
        {l.status === "COMPLETED" && <Text style={[ui.text, { color: colors.good }]}>Picked up {dayLabel(l.completedAt)} · the sale was created</Text>}
        {l.status === "CANCELLED" && (
          <View style={{ gap: 2 }}>
            <Text style={[ui.text, { color: colors.bad }]}>Cancelled {dayLabel(l.cancelledAt)}</Text>
            <Text style={ui.muted}>
              Fee {formatCents(l.cancelFeeCents)} · refunded {formatCents(l.refundedCents)}
              {l.cancelReason ? ` · ${l.cancelReason}` : ""}
            </Text>
          </View>
        )}
        <Lines lines={l.lines ?? []} />
        <View style={{ gap: 4 }}>
          <Row label="Subtotal" value={l.subtotalCents} />
          {l.discountCents > 0 && <Row label="Discounts" value={-l.discountCents} />}
          <Row label="Tax" value={l.taxCents} />
          <Row label="Total" value={l.totalCents} big />
          <Row label="Paid" value={l.paidCents} />
          {l.cardAdjustmentCents > 0 && <Row label="Card price adjustments" value={l.cardAdjustmentCents} />}
          {active && (
            <>
              <Row label="Balance" value={l.balanceCents} big color={overdue ? colors.bad : undefined} />
              {bps > 0 && l.balanceCents > 0 && <Row label={`Balance at card price (+${formatBps(bps)})`} value={cardPrice(l.balanceCents, bps)} />}
              <Row label="Due" value={`${dayLabel(l.dueAt)}${overdue ? " · overdue" : ""}`} color={overdue ? colors.bad : undefined} />
            </>
          )}
        </View>
        <Payments payments={l.payments ?? []} />
        {notice && <Text style={[ui.text, { color: colors.good }]}>{notice}</Text>}
        {error && <Text style={ui.error}>{error}</Text>}
        {active && (
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            {createLevel !== "DENY" && l.balanceCents > 0 && <Button title={`Take payment${pin}`} onPress={() => setAction({ kind: "amount" })} style={{ flexGrow: 1 }} />}
            {createLevel !== "DENY" && (
              <Button
                title={l.balanceCents > 0 ? `Pick up · pay ${formatCents(l.balanceCents)}${pin}` : `Pick up${pin}`}
                kind="good"
                onPress={() => (l.balanceCents > 0 ? setAction({ kind: "pay", amountCents: l.balanceCents, pickup: true }) : pickUpNow())}
                busy={busy}
                style={{ flexGrow: 1 }}
              />
            )}
            {cancelLevel !== "DENY" && (
              <Button title={`Cancel${cancelLevel === "PIN" ? " · PIN" : ""}`} kind="danger" onPress={() => setAction({ kind: "cancel" })} style={{ flexGrow: 1 }} />
            )}
          </View>
        )}
        <PrintStatement layawayId={l.id} terminal={terminalState.terminal} />
      </ScrollView>

      {action?.kind === "amount" && (
        <NumberPrompt
          title="Payment amount"
          message={`Balance ${formatCents(l.balanceCents)}`}
          initial={(l.balanceCents / 100).toFixed(2)}
          onSubmit={(n) => {
            const amountCents = Math.min(Math.round(n * 100), l.balanceCents);
            if (amountCents > 0) setAction({ kind: "pay", amountCents, pickup: false });
          }}
          onClose={() => setAction((a) => (a?.kind === "amount" ? null : a))}
        />
      )}

      {action?.kind === "pay" && (
        <TenderSheet<{ layaway: Layaway }>
          dual={amountTotals(action.amountCents, bps)}
          bps={bps}
          cardPricedTenders={location.cardPricedTenders ?? []}
          terminalState={terminalState}
          customer={customer}
          heading={`${action.pickup ? "Balance" : "Payment"} on layaway #${l.number} · ${l.customer?.name ?? ""} · balance ${formatCents(l.balanceCents)}`}
          submitLabel={action.pickup ? "Pay & pick up" : "Take payment"}
          exclude={["LOYALTY"]}
          onCancel={closeSheet}
          submit={async (tenders, idempotencyKey) => {
            try {
              const r = await guard("LAYAWAY_CREATE", (t) =>
                api<{ layaway: Layaway }>("POST", `/layaways/${id}/payments`, { tenders, idempotencyKey, terminalId }, { approvalToken: t }),
              );
              if (!r) throw new ApiError(0, "CANCELLED", "Manager approval cancelled");
              return r;
            } catch (e) {
              throw layawayError(e);
            }
          }}
          onPaid={(r, tenders) => setPaid({ layaway: r.layaway, tenders, pickup: action.pickup })}
          done={
            paid && (
              <>
                <Text style={ui.h1}>{paid.layaway.balanceCents <= 0 ? "Paid in full" : "Payment taken"}</Text>
                {changeFor(paid.tenders) > 0 && <Text style={[ui.h1, { color: colors.good, fontSize: 40 }]}>Change {formatCents(changeFor(paid.tenders))}</Text>}
                <View style={{ gap: 4 }}>
                  <Row label="Paid so far" value={paid.layaway.paidCents} />
                  <Row label="Balance" value={paid.layaway.balanceCents} big />
                  {paid.layaway.balanceCents > 0 && <Row label="Due" value={dayLabel(paid.layaway.dueAt)} />}
                </View>
                {paid.pickup && <Pickup run={completeLayaway} onCompleted={onChanged} />}
                <PrintStatement layawayId={id} terminal={terminalState.terminal} auto={paid.tenders.some((t) => t.type === "CASH")} />
                <Button title="Done" kind="good" onPress={closeSheet} />
              </>
            )
          }
        />
      )}

      {action?.kind === "cancel" && (
        <CancelSheet layaway={l} level={cancelLevel} canWaive={can("LAYAWAY_MANAGE") !== "DENY"} onSubmit={cancel} onClose={() => setAction(null)} />
      )}
    </>
  );
}

/** Right after the balance is paid: create the sale, and say which. */
function Pickup({ run, onCompleted }: { run: () => Promise<Completed | undefined>; onCompleted: () => void }) {
  const [state, setState] = useState<{ busy: boolean; number?: number; error?: string }>({ busy: true });
  const go = async () => {
    setState({ busy: true });
    try {
      const r = await run();
      if (!r) return setState({ busy: false, error: "Manager approval cancelled" });
      setState({ busy: false, number: r.order.number });
      onCompleted();
    } catch (e) {
      setState({ busy: false, error: errorMessage(layawayError(e)) });
    }
  };
  useEffect(() => {
    void go();
  }, []);
  if (state.number !== undefined) return <Text style={[ui.h2, { color: colors.good }]}>Sale #{state.number} created · picked up</Text>;
  if (state.busy) return <Text style={ui.muted}>Creating the sale…</Text>;
  return (
    <View style={{ gap: 8 }}>
      <Text style={ui.error}>{state.error}</Text>
      <Button title="Try again" kind="secondary" onPress={go} />
    </View>
  );
}

function Lines({ lines }: { lines: LayawayLine[] }) {
  return (
    <View>
      {lines.map((x) => (
        <View key={x.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", gap: 10 }}>
          <Thumb uri={x.variant?.imageUrl ?? x.variant?.product?.imageUrl} title={x.title} size={40} />
          <View style={{ flex: 1 }}>
            <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
              <Text style={[ui.text, { flex: 1 }]} numberOfLines={2}>
                {x.title}
              </Text>
              <Text style={ui.text}>{formatCents(x.unitPriceCents * x.quantity - x.discountCents)}</Text>
            </View>
            <Text style={ui.muted}>
              {x.quantity} × {formatCents(x.unitPriceCents)}
              {x.variant?.sku ? ` · ${x.variant.sku}` : ""}
            </Text>
            {!!x.promoDiscountCents && <Text style={[ui.muted, { color: colors.good }]}>Deal −{formatCents(x.promoDiscountCents)}</Text>}
          </View>
        </View>
      ))}
    </View>
  );
}

const SETTLED = ["CAPTURED", "SUCCEEDED", "APPROVED", "COMPLETED", "PAID"];

function Payments({ payments }: { payments: LayawayPayment[] }) {
  if (payments.length === 0) return null;
  return (
    <View>
      <Text style={ui.h2}>Payments</Text>
      {payments.map((p) => (
        <View key={p.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
            <Text style={[ui.text, { flex: 1 }]} numberOfLines={1}>
              {tenderName(p.tender)}
              {p.cardLast4 ? ` ${p.cardBrand ?? ""} •••• ${p.cardLast4}` : ""}
              {p.status && !SETTLED.includes(p.status) ? ` · ${p.status.toLowerCase()}` : ""}
            </Text>
            <Text style={ui.text}>{formatCents(p.amountCents)}</Text>
          </View>
          <Text style={ui.muted}>
            {[whenLabel(p.createdAt), p.staff?.name, p.appliedCents !== p.amountCents ? `${formatCents(p.appliedCents)} toward the balance` : null].filter(Boolean).join(" · ")}
          </Text>
        </View>
      ))}
    </View>
  );
}

function CancelSheet(props: {
  layaway: Layaway;
  level: PermissionLevel;
  canWaive: boolean;
  onSubmit: (input: { toStoreCredit: boolean; waiveFee: boolean; reason: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const { dialog } = useLayout();
  const l = props.layaway;
  const [reason, setReason] = useState("");
  const [toStoreCredit, setToStoreCredit] = useState(false);
  const [waiveFee, setWaiveFee] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = l.cancelFeePreview;
  const fee = waiveFee ? 0 : (preview?.feeCents ?? 0);
  const refund = waiveFee ? l.paidCents : (preview?.refundCents ?? l.paidCents - fee);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (await props.onSubmit({ toStoreCredit, waiveFee, reason: reason.trim() })) props.onClose();
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
          <Text style={ui.h1}>Cancel layaway #{l.number}</Text>
          <Text style={ui.muted}>
            The items go back on the shelf and the customer gets their payments back, less the fee.
            {props.level === "PIN" ? " Needs a manager's PIN." : ""}
          </Text>
          <View style={{ gap: 4 }}>
            <Row label="Paid" value={l.paidCents} />
            <Row label="Cancellation fee" value={-fee} />
            <Row label={toStoreCredit ? "Refund to store credit" : "Refund"} value={refund} big />
          </View>
          <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
            <Text style={[ui.text, { flex: 1 }]}>Refund to store credit</Text>
            <Switch value={toStoreCredit} onValueChange={setToStoreCredit} />
          </View>
          {props.canWaive && (preview ? preview.feeCents > 0 : true) && (
            <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
              <Text style={[ui.text, { flex: 1 }]}>Waive the fee</Text>
              <Switch value={waiveFee} onValueChange={setWaiveFee} />
            </View>
          )}
          <TextInput style={ui.input} value={reason} onChangeText={setReason} placeholder="Reason (optional)" placeholderTextColor={colors.muted} />
          {error && <Text style={ui.error}>{error}</Text>}
          <View style={[ui.row, { gap: 8 }]}>
            <Button title="Keep it" kind="secondary" onPress={props.onClose} disabled={busy} />
            <Button title={`Cancel layaway${props.level === "PIN" ? " · PIN" : ""}`} kind="danger" onPress={submit} busy={busy} style={{ flex: 1 }} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
