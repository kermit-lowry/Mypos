import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, type Location, type Product, type Variant } from "../../api";
import { Button } from "../../components/Button";
import { ProductSearch, variantLabel } from "../../components/ProductSearch";
import { useCan, useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Card, Chips, Field, Input, Table, when } from "../ui";

interface Line {
  variantId: string;
  title: string;
  detail: string;
  quantity: number;
  receivedQty: number;
}
interface Transfer {
  id?: string;
  number?: number;
  status: "DRAFT" | "SENT" | "RECEIVED" | "CANCELLED";
  fromLocationId: string;
  toLocationId: string;
  fromLocation?: Location;
  toLocation?: Location;
  notes?: string | null;
  lines: Line[];
}

const toLines = (t: any): Line[] => (t.lines ?? []).map((l: any) => ({ variantId: l.variantId, title: l.variant?.product?.title ?? l.variantId, detail: l.variant ? variantLabel(l.variant) : "", quantity: l.quantity, receivedQty: l.receivedQty ?? 0 }));

/** Move stock between locations. */
export function Transfers() {
  const { location } = useSession();
  const can = useCan();
  const [list, setList] = useState<any[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [editing, setEditing] = useState<Transfer | null>(null);
  const load = useCallback(async () => {
    setList(await api("GET", "/transfers"));
    setLocations(await api("GET", "/locations"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (editing) return <TransferEditor key={editing.id ?? "new"} initial={editing} locations={locations} onDone={() => (setEditing(null), load())} />;

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card
        title="Transfers"
        right={can("MANAGE_TRANSFERS") !== "DENY" && locations.length > 1 ? <Button title="+ New" kind="good" style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => setEditing({ status: "DRAFT", fromLocationId: location.id, toLocationId: locations.find((l) => l.id !== location.id)!.id, lines: [] })} /> : undefined}
      >
        {locations.length < 2 && <Text style={ui.muted}>Transfers need at least two locations. Add one under Store.</Text>}
        <Table
          rows={list}
          keyOf={(t) => t.id}
          onPress={(t) => setEditing({ ...t, lines: toLines(t) })}
          columns={[
            { key: "n", label: "#", render: (t) => `#${t.number}`, width: 60 },
            { key: "r", label: "Route", render: (t) => `${t.fromLocation.name} → ${t.toLocation.name}`, width: 240 },
            { key: "s", label: "Status", render: (t) => <Text style={[ui.text, { color: t.status === "RECEIVED" ? colors.good : t.status === "SENT" ? colors.warn : colors.muted }]}>{t.status === "SENT" ? "in transit" : t.status.toLowerCase()}</Text>, width: 100 },
            { key: "u", label: "Units", render: (t) => t.lines.reduce((a: number, l: any) => a + l.quantity, 0), width: 60, align: "right" },
            { key: "w", label: "Updated", render: (t) => when(t.updatedAt), width: 170 },
          ]}
          empty="No transfers yet."
        />
      </Card>
    </ScrollView>
  );
}

function TransferEditor({ initial, locations, onDone }: { initial: Transfer; locations: Location[]; onDone: () => void }) {
  const can = useCan();
  const [t, setT] = useState<Transfer>(initial);
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState<Record<string, string> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const draft = t.status === "DRAFT";
  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? id;

  const run = async (fn: () => Promise<unknown>, done = false) => {
    setMessage(null);
    try {
      await fn();
      if (done) onDone();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  };
  const body = () => ({ fromLocationId: t.fromLocationId, toLocationId: t.toLocationId, notes: t.notes || undefined, lines: t.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) });
  const save = async (): Promise<string> => {
    if (t.id) {
      await api("PUT", `/transfers/${t.id}`, body());
      return t.id;
    }
    const c = await api<{ id: string }>("POST", "/transfers", body());
    setT((x) => ({ ...x, id: c.id }));
    return c.id;
  };

  if (adding) {
    return (
      <View style={{ flex: 1, padding: 12, gap: 8 }}>
        <Button title="Done adding" onPress={() => setAdding(false)} />
        <ProductSearch onPick={(p: Product, v: Variant) => setT((x) => (x.lines.some((l) => l.variantId === v.id) ? x : { ...x, lines: [...x.lines, { variantId: v.id, title: p.title, detail: variantLabel(v), quantity: 1, receivedQty: 0 }] }))} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card title={t.number ? `Transfer #${t.number} · ${t.status === "SENT" ? "in transit" : t.status.toLowerCase()}` : "New transfer"} right={<Button title="Back" kind="secondary" onPress={onDone} style={{ minHeight: 36, paddingVertical: 6 }} />}>
        <Text style={ui.muted}>From</Text>
        {draft ? <Chips options={locations.map((l) => [l.id, l.name])} value={t.fromLocationId} onChange={(fromLocationId) => setT({ ...t, fromLocationId })} /> : <Text style={ui.text}>{name(t.fromLocationId)}</Text>}
        <Text style={ui.muted}>To</Text>
        {draft ? <Chips options={locations.filter((l) => l.id !== t.fromLocationId).map((l) => [l.id, l.name])} value={t.toLocationId} onChange={(toLocationId) => setT({ ...t, toLocationId })} /> : <Text style={ui.text}>{name(t.toLocationId)}</Text>}
        <Field label="Notes"><Input value={t.notes ?? ""} onChange={(notes) => setT({ ...t, notes })} multiline /></Field>
      </Card>
      <Card title={`Items · ${t.lines.reduce((a, l) => a + l.quantity, 0)} units`} right={draft ? <Button title="+ Add items" style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => setAdding(true)} /> : undefined}>
        {t.lines.length === 0 && <Text style={ui.muted}>No items yet.</Text>}
        {t.lines.map((l) => (
          <View key={l.variantId} style={[ui.row, { gap: 8, flexWrap: "wrap", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
            <View style={{ flex: 1, minWidth: 160 }}>
              <Text style={ui.text}>{l.title}</Text>
              <Text style={ui.muted}>{l.detail}</Text>
            </View>
            <Text style={ui.muted}>Qty</Text>
            <TextInput style={[ui.input, { width: 70, paddingVertical: 6 }]} editable={draft} keyboardType="number-pad" defaultValue={String(l.quantity)} onEndEditing={(e) => setT((x) => ({ ...x, lines: x.lines.map((y) => (y.variantId === l.variantId ? { ...y, quantity: Math.max(1, Number(e.nativeEvent.text) || 1) } : y)) }))} />
            {t.status === "RECEIVED" && <Text style={ui.muted}>received {l.receivedQty}</Text>}
            {receiving && (
              <>
                <Text style={[ui.muted, { color: colors.good }]}>Arrived</Text>
                <TextInput style={[ui.input, { width: 70, paddingVertical: 6, borderColor: colors.good }]} keyboardType="number-pad" value={receiving[l.variantId] ?? ""} onChangeText={(v) => setReceiving({ ...receiving, [l.variantId]: v })} />
              </>
            )}
            {draft && <Button title="✕" kind="secondary" style={{ minHeight: 32, paddingVertical: 4 }} onPress={() => setT((x) => ({ ...x, lines: x.lines.filter((y) => y.variantId !== l.variantId) }))} />}
          </View>
        ))}
      </Card>
      {message && <Text style={ui.text}>{message}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        {draft && can("MANAGE_TRANSFERS") !== "DENY" && (
          <>
            <Button title="Save draft" kind="secondary" onPress={() => run(save, true)} />
            <Button title="Send" kind="good" onPress={() => run(async () => api("POST", `/transfers/${await save()}/send`), true)} disabled={t.lines.length === 0} />
            {t.id && <Button title="Cancel" kind="danger" onPress={() => run(() => api("POST", `/transfers/${t.id}/cancel`), true)} />}
          </>
        )}
        {t.status === "SENT" && can("RECEIVE_STOCK") !== "DENY" && !receiving && <Button title="Receive at destination" kind="good" onPress={() => setReceiving(Object.fromEntries(t.lines.map((l) => [l.variantId, String(l.quantity)])))} />}
        {receiving && (
          <>
            <Button title="Confirm" kind="good" onPress={() => run(() => api("POST", `/transfers/${t.id}/receive`, { lines: Object.entries(receiving).map(([variantId, q]) => ({ variantId, quantity: Number(q) || 0 })) }), true)} />
            <Button title="Back" kind="secondary" onPress={() => setReceiving(null)} />
          </>
        )}
      </View>
    </ScrollView>
  );
}
