import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, type Location, type Product, type Variant } from "../../api";
import { useGuard } from "../../approval";
import { Button } from "../../components/Button";
import { ProductSearch, variantLabel } from "../../components/ProductSearch";
import { useLayout } from "../../layout";
import { useCan, useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Badge, Card, Chips, day, Field, Input, isoDay, money, openDocument, Picker, Table, when } from "../ui";

type Status = "DRAFT" | "SENT" | "RECEIVED" | "CANCELLED";

interface Line {
  variantId: string;
  title: string;
  detail: string;
  quantity: number;
  receivedQty: number;
  priceCents: number;
}
interface Transfer {
  id?: string;
  number?: number;
  status: Status;
  fromLocationId: string;
  toLocationId: string;
  reference?: string | null;
  notes?: string | null;
  expectedAt?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  lines: Line[];
}
/** A row of GET /transfers: locations and priced lines, without product details. */
interface Row {
  id: string;
  number: number;
  status: Status;
  reference: string | null;
  fromLocation: Location;
  toLocation: Location;
  createdAt: string;
  sentAt: string | null;
  expectedAt: string | null;
  lines: { quantity: number; receivedQty: number; variant: { priceCents: number; costCents: number | null } }[];
}

const STATUS: Record<Status, { text: string; tone: "good" | "warn" | "muted" }> = {
  DRAFT: { text: "open", tone: "muted" },
  SENT: { text: "sent", tone: "warn" },
  RECEIVED: { text: "received", tone: "good" },
  CANCELLED: { text: "cancelled", tone: "muted" },
};
const StatusBadge = ({ status }: { status: Status }) => <Badge text={STATUS[status].text} tone={STATUS[status].tone} />;

const toLines = (t: any): Line[] => (t.lines ?? []).map((l: any) => ({ variantId: l.variantId, title: l.variant?.product?.title ?? l.variantId, detail: l.variant ? variantLabel(l.variant) : "", quantity: l.quantity, receivedQty: l.receivedQty ?? 0, priceCents: l.variant?.priceCents ?? 0 }));
const units = (lines: { quantity: number }[]) => lines.reduce((a, l) => a + l.quantity, 0);
const received = (lines: { receivedQty: number }[]) => lines.reduce((a, l) => a + l.receivedQty, 0);

/** Move stock between locations. */
export function Transfers() {
  const { location } = useSession();
  const can = useCan();
  const [list, setList] = useState<Row[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transfer | null>(null);

  const load = useCallback(async () => {
    const qs = [status !== "ALL" && `status=${status}`, q.trim() && `q=${encodeURIComponent(q.trim())}`, from && `fromLocationId=${from}`, to && `toLocationId=${to}`].filter(Boolean).join("&");
    try {
      setList(await api("GET", `/transfers${qs ? `?${qs}` : ""}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [status, q, from, to]);
  useEffect(() => {
    const timer = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);
  useEffect(() => {
    api<Location[]>("GET", "/locations").then(setLocations).catch(() => undefined);
  }, []);

  // The list leaves out product details; the editor needs them.
  const open = async (id: string) => {
    try {
      const t = await api("GET", `/transfers/${id}`);
      setEditing({ ...t, lines: toLines(t) });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (editing) return <TransferEditor key={editing.id ?? "new"} initial={editing} locations={locations} onDone={() => (setEditing(null), load())} />;

  const value = (t: Row) => t.lines.reduce((a, l) => a + l.quantity * l.variant.priceCents, 0);
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card
        title="Transfers"
        right={can("MANAGE_TRANSFERS") !== "DENY" && locations.length > 1 ? <Button title="+ New" kind="good" style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => setEditing({ status: "DRAFT", fromLocationId: location.id, toLocationId: locations.find((l) => l.id !== location.id)!.id, lines: [] })} /> : undefined}
      >
        {locations.length < 2 && <Text style={ui.muted}>Transfers need at least two locations. Add one under Store.</Text>}
        <Chips options={[["DRAFT", "Open"], ["SENT", "Sent"], ["RECEIVED", "Received"], ["CANCELLED", "Cancelled"], ["ALL", "All"]]} value={status} onChange={setStatus} />
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
          <Field label="Search"><Input value={q} onChange={setQ} placeholder="Transfer # or reference" /></Field>
          <Picker label="From" options={locations.map((l) => [l.id, l.name])} value={from} onChange={setFrom} noneLabel="Any location" />
          <Picker label="To" options={locations.map((l) => [l.id, l.name])} value={to} onChange={setTo} noneLabel="Any location" />
        </View>
        {error && <Text style={ui.error}>{error}</Text>}
        <Table<Row>
          rows={list}
          keyOf={(t) => t.id}
          onPress={(t) => open(t.id)}
          columns={[
            { key: "n", label: "Transfer #", render: (t) => `#${t.number}`, width: 90 },
            { key: "r", label: "Reference", render: (t) => t.reference ?? "", width: 140 },
            { key: "s", label: "Status", render: (t) => <StatusBadge status={t.status} />, width: 100 },
            { key: "f", label: "From", render: (t) => t.fromLocation.name, width: 130 },
            { key: "t", label: "To", render: (t) => t.toLocation.name, width: 130 },
            { key: "c", label: "Created", render: (t) => day(t.createdAt), width: 100 },
            { key: "d", label: "Sent date", render: (t) => (t.sentAt ? day(t.sentAt) : ""), width: 100 },
            { key: "e", label: "Expected", render: (t) => (t.expectedAt ? day(t.expectedAt) : ""), width: 100 },
            { key: "i", label: "Items", render: (t) => t.lines.length, width: 60, align: "right" },
            { key: "u", label: "Total sent", render: (t) => units(t.lines), width: 80, align: "right" },
            { key: "v", label: "Value", render: (t) => money(value(t)), width: 100, align: "right" },
            { key: "g", label: "Received", render: (t) => (t.status === "RECEIVED" ? received(t.lines) : ""), width: 80, align: "right" },
          ]}
          empty="No transfers match."
        />
      </Card>
    </ScrollView>
  );
}

function TransferEditor({ initial, locations, onDone }: { initial: Transfer; locations: Location[]; onDone: () => void }) {
  const can = useCan();
  const guard = useGuard();
  const { narrow } = useLayout();
  const [t, setT] = useState<Transfer>(initial);
  const [expected, setExpected] = useState(isoDay(initial.expectedAt));
  const [qty, setQty] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState<Record<string, string> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const draft = t.status === "DRAFT";
  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? id;
  const value = t.lines.reduce((a, l) => a + l.quantity * l.priceCents, 0);

  /** Run an action; `done` returns to the list unless the PIN prompt was cancelled (guard resolves undefined). */
  const run = async (what: string, fn: () => Promise<unknown>, done = false) => {
    setMessage(null);
    setBusy(what);
    try {
      const r = await fn();
      if (done && r !== undefined) onDone();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const body = () => {
    if (expected && !/^\d{4}-\d{2}-\d{2}$/.test(expected)) throw new Error("Expected date must be YYYY-MM-DD");
    return { fromLocationId: t.fromLocationId, toLocationId: t.toLocationId, reference: t.reference?.trim() || undefined, notes: t.notes || undefined, expectedAt: expected ? `${expected}T00:00:00` : undefined, lines: t.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) };
  };
  // Approval tokens are single-use, so each request goes through the guard on its own.
  const save = async (): Promise<string | undefined> => {
    const b = body();
    if (t.id) {
      const id = t.id;
      const r = await guard("MANAGE_TRANSFERS", (token) => api("PUT", `/transfers/${id}`, b, { approvalToken: token }));
      return r ? id : undefined;
    }
    const c = await guard("MANAGE_TRANSFERS", (token) => api<{ id: string; number: number }>("POST", "/transfers", b, { approvalToken: token }));
    if (c) setT((x) => ({ ...x, id: c.id, number: c.number }));
    return c?.id;
  };
  const send = async () => {
    const id = await save();
    if (!id) return undefined;
    return guard("MANAGE_TRANSFERS", (token) => api("POST", `/transfers/${id}/send`, undefined, { approvalToken: token }));
  };
  const cancel = () => guard("MANAGE_TRANSFERS", (token) => api("POST", `/transfers/${t.id}/cancel`, undefined, { approvalToken: token }));
  const receive = () => {
    const bad = t.lines.find((l) => {
      const n = Number(receiving?.[l.variantId]);
      return !Number.isInteger(n) || n < 0 || n > l.quantity;
    });
    if (bad) throw new Error(`Received quantity for ${bad.title} must be between 0 and ${bad.quantity}`);
    const lines = t.lines.map((l) => ({ variantId: l.variantId, quantity: Number(receiving?.[l.variantId]) }));
    return guard("RECEIVE_STOCK", (token) => api("POST", `/transfers/${t.id}/receive`, { lines }, { approvalToken: token }));
  };
  const setLineQty = (variantId: string, text: string) => setT((x) => ({ ...x, lines: x.lines.map((y) => (y.variantId === variantId ? { ...y, quantity: Math.max(1, Math.floor(Number(text)) || 1) } : y)) }));

  if (adding) {
    return (
      <View style={{ flex: 1, padding: 12, gap: 8 }}>
        <Button title="Done adding" onPress={() => setAdding(false)} />
        <ProductSearch placeholder="Find items to send" onPick={(p: Product, v: Variant) => setT((x) => (x.lines.some((l) => l.variantId === v.id) ? x : { ...x, lines: [...x.lines, { variantId: v.id, title: p.title, detail: variantLabel(v), quantity: 1, receivedQty: 0, priceCents: v.priceCents }] }))} />
      </View>
    );
  }

  const timeline = [t.sentAt && `Sent ${when(t.sentAt)}`, t.receivedAt && `Received ${when(t.receivedAt)}`].filter(Boolean).join(" · ");
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card
        title={t.number ? `Transfer #${t.number}` : "New transfer"}
        right={
          <View style={[ui.row, { gap: 8 }]}>
            <StatusBadge status={t.status} />
            <Button title="Back" kind="secondary" onPress={onDone} style={{ minHeight: 36, paddingVertical: 6 }} />
          </View>
        }
      >
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
          {draft ? (
            <>
              <Picker label="From" options={locations.map((l) => [l.id, l.name])} value={t.fromLocationId} onChange={(fromLocationId) => setT({ ...t, fromLocationId, toLocationId: t.toLocationId === fromLocationId ? (locations.find((l) => l.id !== fromLocationId)?.id ?? "") : t.toLocationId })} allowNone={false} />
              <Picker label="To" options={locations.filter((l) => l.id !== t.fromLocationId).map((l) => [l.id, l.name])} value={t.toLocationId} onChange={(toLocationId) => setT({ ...t, toLocationId })} allowNone={false} placeholder="Pick a destination" />
            </>
          ) : (
            <>
              <Field label="From"><Text style={ui.text}>{name(t.fromLocationId)}</Text></Field>
              <Field label="To"><Text style={ui.text}>{name(t.toLocationId)}</Text></Field>
            </>
          )}
        </View>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
          <Field label="Reference">{draft ? <Input value={t.reference ?? ""} onChange={(reference) => setT({ ...t, reference })} placeholder="Box, carrier, or ticket #" /> : <Text style={ui.text}>{t.reference || "—"}</Text>}</Field>
          <Field label="Expected (YYYY-MM-DD)">{draft ? <Input value={expected} onChange={setExpected} placeholder="2026-10-15" /> : <Text style={ui.text}>{t.expectedAt ? day(t.expectedAt) : "—"}</Text>}</Field>
        </View>
        <Field label="Notes">{draft ? <Input value={t.notes ?? ""} onChange={(notes) => setT({ ...t, notes })} multiline /> : <Text style={ui.text}>{t.notes || "—"}</Text>}</Field>
        {timeline !== "" && <Text style={ui.muted}>{timeline}</Text>}
      </Card>
      <Card title={`Items · ${units(t.lines)} units · ${money(value)}`} right={draft ? <Button title="+ Add items" style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => setAdding(true)} /> : undefined}>
        {t.lines.length === 0 && <Text style={ui.muted}>No items yet.</Text>}
        {t.lines.map((l) => {
          const short = t.status === "RECEIVED" && l.receivedQty < l.quantity;
          return (
            <View key={l.variantId} style={[narrow ? { gap: 6 } : [ui.row, { gap: 12 }], { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
              <View style={{ flex: narrow ? undefined : 1, minWidth: 160 }}>
                <Text style={ui.text}>{l.title}</Text>
                <Text style={ui.muted}>{[l.detail, l.priceCents ? money(l.priceCents) : ""].filter(Boolean).join(" · ")}</Text>
              </View>
              <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
                {draft ? (
                  <>
                    <Text style={ui.muted}>Qty</Text>
                    <TextInput
                      style={[ui.input, { width: 70, paddingVertical: 6 }]}
                      keyboardType="number-pad"
                      value={qty[l.variantId] ?? String(l.quantity)}
                      onChangeText={(v) => setQty({ ...qty, [l.variantId]: v })}
                      onBlur={() => (setLineQty(l.variantId, qty[l.variantId] ?? String(l.quantity)), setQty(({ [l.variantId]: _, ...rest }) => rest))}
                    />
                    <Button title="✕" kind="secondary" style={{ minHeight: 32, paddingVertical: 4 }} onPress={() => setT((x) => ({ ...x, lines: x.lines.filter((y) => y.variantId !== l.variantId) }))} />
                  </>
                ) : (
                  <Text style={ui.text}>Sent {l.quantity}</Text>
                )}
                {t.status === "RECEIVED" && <Text style={[ui.text, short && { color: colors.bad, fontWeight: "600" }]}>{`Received ${l.receivedQty}${short ? ` · short ${l.quantity - l.receivedQty}` : ""}`}</Text>}
                {receiving && (
                  <>
                    <Text style={[ui.muted, { color: colors.good }]}>Arrived</Text>
                    <TextInput style={[ui.input, { width: 70, paddingVertical: 6, borderColor: colors.good }]} keyboardType="number-pad" value={receiving[l.variantId] ?? ""} onChangeText={(v) => setReceiving({ ...receiving, [l.variantId]: v })} />
                  </>
                )}
              </View>
            </View>
          );
        })}
        {receiving && <Text style={ui.muted}>Receiving fewer than sent records a shortage in the activity log; the missing units stay out of stock.</Text>}
      </Card>
      {message && <Text style={ui.error}>{message}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        {draft && can("MANAGE_TRANSFERS") !== "DENY" && (
          <>
            <Button title="Save draft" kind="secondary" busy={busy === "save"} disabled={!!busy} onPress={() => run("save", save, true)} />
            <Button title="Send" kind="good" busy={busy === "send"} disabled={!!busy || t.lines.length === 0 || !t.toLocationId} onPress={() => run("send", send, true)} />
            {t.id && <Button title="Cancel transfer" kind="danger" busy={busy === "cancel"} disabled={!!busy} onPress={() => run("cancel", cancel, true)} />}
          </>
        )}
        {t.status === "SENT" && can("RECEIVE_STOCK") !== "DENY" && !receiving && <Button title="Receive" kind="good" onPress={() => setReceiving(Object.fromEntries(t.lines.map((l) => [l.variantId, String(l.quantity)])))} />}
        {receiving && (
          <>
            <Button title="Confirm receipt" kind="good" busy={busy === "receive"} disabled={!!busy} onPress={() => run("receive", receive, true)} />
            <Button title="Back" kind="secondary" onPress={() => setReceiving(null)} />
          </>
        )}
        {t.id && (t.status === "SENT" || t.status === "RECEIVED") && (
          <>
            <Button title="Print" kind="secondary" busy={busy === "print"} disabled={!!busy} onPress={() => run("print", () => openDocument(`/transfers/${t.id}/print`))} />
            <Button title="Labels" kind="secondary" busy={busy === "labels"} disabled={!!busy} onPress={() => run("labels", () => openDocument(`/transfers/${t.id}/labels`))} />
          </>
        )}
      </View>
    </ScrollView>
  );
}
