import { useCallback, useEffect, useState } from "react";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import { api, ApiError, type Product, type Variant } from "../../api";
import { Button } from "../../components/Button";
import { ProductSearch, variantLabel } from "../../components/ProductSearch";
import { useCan, useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Card, Chips, day, Field, Input, money, Table } from "../ui";

interface Vendor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  active: boolean;
}
interface PoLine {
  variantId: string;
  title: string;
  detail: string;
  quantity: number;
  receivedQty: number;
  unitCostCents: number;
}
interface Po {
  id?: string;
  number?: number;
  status: "DRAFT" | "ORDERED" | "PARTIAL" | "RECEIVED" | "CANCELLED";
  vendorId: string;
  vendor?: Vendor;
  locationId: string;
  reference?: string | null;
  notes?: string | null;
  expectedAt?: string | null;
  lines: PoLine[];
}

const toLines = (po: any): PoLine[] =>
  (po.lines ?? []).map((l: any) => ({
    variantId: l.variantId,
    title: l.variant?.product?.title ?? l.title ?? l.variantId,
    detail: l.variant ? variantLabel(l.variant) : "",
    quantity: l.quantity,
    receivedQty: l.receivedQty ?? 0,
    unitCostCents: l.unitCostCents,
  }));

/** Vendors and purchase orders: build, order, receive. */
export function Purchasing() {
  const { location } = useSession();
  const can = useCan();
  const [view, setView] = useState<"orders" | "vendors">("orders");
  const [showAll, setShowAll] = useState(false);
  const [orders, setOrders] = useState<any[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [editing, setEditing] = useState<Po | null>(null);

  const load = useCallback(async () => {
    setOrders(await api("GET", `/purchase-orders?${showAll ? "" : "open=true"}`));
    setVendors(await api("GET", "/vendors"));
  }, [showAll]);
  useEffect(() => {
    load();
  }, [load]);

  if (editing) {
    return (
      <PoEditor
        key={editing.id ?? "new"}
        initial={editing}
        vendors={vendors.filter((v) => v.active || v.id === editing.vendorId)}
        onDone={() => {
          setEditing(null);
          load();
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Chips options={[["orders", "Purchase orders"], ["vendors", "Vendors"]]} value={view} onChange={(v) => setView(v as never)} />
      </View>
      {view === "orders" ? (
        <Card
          title="Purchase orders"
          right={
            <View style={[ui.row, { gap: 8 }]}>
              <Text style={ui.muted}>All</Text>
              <Switch value={showAll} onValueChange={setShowAll} />
              {can("MANAGE_PURCHASING") !== "DENY" && <Button title="+ New" kind="good" onPress={() => setEditing({ status: "DRAFT", vendorId: vendors.find((v) => v.active)?.id ?? "", locationId: location.id, lines: [] })} style={{ minHeight: 36, paddingVertical: 6 }} />}
            </View>
          }
        >
          <Table
            rows={orders}
            keyOf={(o) => o.id}
            onPress={(o) => setEditing({ ...o, lines: toLines(o) })}
            columns={[
              { key: "n", label: "PO #", render: (o) => `#${o.number}`, width: 70 },
              { key: "v", label: "Vendor", render: (o) => o.vendor?.name ?? "", width: 180 },
              { key: "s", label: "Status", render: (o) => <Text style={[ui.text, { color: o.status === "RECEIVED" ? colors.good : o.status === "CANCELLED" ? colors.muted : colors.warn }]}>{o.status.toLowerCase()}</Text>, width: 100 },
              { key: "l", label: "Lines", render: (o) => o.lines.length, width: 60, align: "right" },
              { key: "t", label: "Total", render: (o) => money(o.lines.reduce((a: number, l: any) => a + l.quantity * l.unitCostCents, 0)), width: 100, align: "right" },
              { key: "e", label: "Expected", render: (o) => (o.expectedAt ? day(o.expectedAt) : ""), width: 110 },
            ]}
            empty={showAll ? "No purchase orders yet." : "No open purchase orders."}
          />
        </Card>
      ) : (
        <Vendors vendors={vendors} onChanged={load} />
      )}
    </ScrollView>
  );
}

function PoEditor({ initial, vendors, onDone }: { initial: Po; vendors: Vendor[]; onDone: () => void }) {
  const { location } = useSession();
  const can = useCan();
  const [po, setPo] = useState<Po>(initial);
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState<Record<string, string> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const draft = po.status === "DRAFT";
  const receivable = po.status === "ORDERED" || po.status === "PARTIAL";
  const total = po.lines.reduce((a, l) => a + l.quantity * l.unitCostCents, 0);

  const run = async (fn: () => Promise<unknown>, done = false) => {
    setMessage(null);
    try {
      await fn();
      if (done) onDone();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  };
  const body = () => ({
    vendorId: po.vendorId,
    locationId: po.locationId,
    reference: po.reference || undefined,
    notes: po.notes || undefined,
    expectedAt: po.expectedAt || undefined,
    lines: po.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitCostCents: l.unitCostCents })),
  });
  const save = async (): Promise<string> => {
    if (po.id) {
      await api("PUT", `/purchase-orders/${po.id}`, draft ? body() : { notes: po.notes || undefined, expectedAt: po.expectedAt || undefined });
      return po.id;
    }
    const created = await api<{ id: string }>("POST", "/purchase-orders", body());
    setPo((p) => ({ ...p, id: created.id }));
    return created.id;
  };
  const addLine = (p: Product, v: Variant) => {
    setPo((x) => (x.lines.some((l) => l.variantId === v.id) ? x : { ...x, lines: [...x.lines, { variantId: v.id, title: p.title, detail: variantLabel(v), quantity: 1, receivedQty: 0, unitCostCents: v.costCents ?? 0 }] }));
  };
  const setLine = (variantId: string, patch: Partial<PoLine>) => setPo((x) => ({ ...x, lines: x.lines.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)) }));

  if (adding) {
    return (
      <View style={{ flex: 1, padding: 12, gap: 8 }}>
        <Button title="Done adding" onPress={() => setAdding(false)} />
        <ProductSearch onPick={addLine} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card title={po.number ? `PO #${po.number} · ${po.status.toLowerCase()}` : "New purchase order"} right={<Button title="Back" kind="secondary" onPress={onDone} style={{ minHeight: 36, paddingVertical: 6 }} />}>
        <Text style={ui.muted}>Vendor</Text>
        {draft ? <Chips options={vendors.map((v) => [v.id, v.name])} value={po.vendorId} onChange={(vendorId) => setPo({ ...po, vendorId })} /> : <Text style={ui.text}>{po.vendor?.name}</Text>}
        {vendors.length === 0 && <Text style={[ui.muted, { color: colors.warn }]}>Add a vendor first (Vendors tab).</Text>}
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Field label="Vendor reference / invoice #"><Input value={po.reference ?? ""} onChange={(reference) => setPo({ ...po, reference })} /></Field>
          <Field label="Expected (YYYY-MM-DD)"><Input value={po.expectedAt ? po.expectedAt.slice(0, 10) : ""} onChange={(t) => setPo({ ...po, expectedAt: t ? `${t}T00:00:00` : null })} /></Field>
        </View>
        <Field label="Notes"><Input value={po.notes ?? ""} onChange={(notes) => setPo({ ...po, notes })} multiline /></Field>
        <Text style={ui.muted}>Deliver to {location.name}</Text>
      </Card>

      <Card
        title={`Items · ${money(total)}`}
        right={
          draft ? (
            <View style={[ui.row, { gap: 6 }]}>
              <Button title="Suggest reorders" kind="secondary" style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => run(async () => {
                const s = await api<{ variantId: string; title: string; sku: string; suggestedQty: number; lastCostCents: number | null }[]>("GET", `/purchase-orders/reorder?locationId=${location.id}`);
                if (s.length === 0) return setMessage("Nothing is below its low-stock level.");
                setPo((x) => ({ ...x, lines: [...x.lines, ...s.filter((r) => !x.lines.some((l) => l.variantId === r.variantId)).map((r) => ({ variantId: r.variantId, title: r.title, detail: r.sku, quantity: r.suggestedQty, receivedQty: 0, unitCostCents: r.lastCostCents ?? 0 }))] }));
              })} />
              <Button title="+ Add items" style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => setAdding(true)} />
            </View>
          ) : undefined
        }
      >
        {po.lines.length === 0 && <Text style={ui.muted}>No items yet.</Text>}
        {po.lines.map((l) => (
          <View key={l.variantId} style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <Text style={ui.text}>{l.title}</Text>
            <Text style={ui.muted}>{l.detail}</Text>
            <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "center" }]}>
              <Text style={ui.muted}>Qty</Text>
              <TextInput style={[ui.input, { width: 70, paddingVertical: 6 }]} editable={draft} keyboardType="number-pad" defaultValue={String(l.quantity)} onEndEditing={(e) => setLine(l.variantId, { quantity: Math.max(1, Number(e.nativeEvent.text) || 1) })} />
              <Text style={ui.muted}>@ $</Text>
              <TextInput style={[ui.input, { width: 90, paddingVertical: 6 }]} editable={draft} keyboardType="decimal-pad" defaultValue={(l.unitCostCents / 100).toFixed(2)} onEndEditing={(e) => setLine(l.variantId, { unitCostCents: Math.max(0, Math.round(Number(e.nativeEvent.text) * 100) || 0) })} />
              <Text style={ui.text}>= {money(l.quantity * l.unitCostCents)}</Text>
              {!draft && <Text style={ui.muted}>· received {l.receivedQty}/{l.quantity}</Text>}
              {receiving && l.quantity - l.receivedQty > 0 && (
                <>
                  <Text style={[ui.muted, { color: colors.good }]}>Receive now</Text>
                  <TextInput style={[ui.input, { width: 70, paddingVertical: 6, borderColor: colors.good }]} keyboardType="number-pad" value={receiving[l.variantId] ?? ""} onChangeText={(t) => setReceiving({ ...receiving, [l.variantId]: t })} />
                </>
              )}
              {draft && <Button title="✕" kind="secondary" style={{ minHeight: 32, paddingVertical: 4 }} onPress={() => setPo((x) => ({ ...x, lines: x.lines.filter((y) => y.variantId !== l.variantId) }))} />}
            </View>
          </View>
        ))}
      </Card>

      {message && <Text style={ui.text}>{message}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        {draft && can("MANAGE_PURCHASING") !== "DENY" && (
          <>
            <Button title="Save draft" kind="secondary" onPress={() => run(save, true)} disabled={!po.vendorId} />
            <Button title="Mark as ordered" kind="good" onPress={() => run(async () => api("POST", `/purchase-orders/${await save()}/order`), true)} disabled={!po.vendorId || po.lines.length === 0} />
            {po.id && <Button title="Cancel order" kind="danger" onPress={() => run(() => api("POST", `/purchase-orders/${po.id}/cancel`), true)} />}
          </>
        )}
        {!draft && can("MANAGE_PURCHASING") !== "DENY" && po.status !== "CANCELLED" && <Button title="Save notes" kind="secondary" onPress={() => run(save, true)} />}
        {receivable && can("RECEIVE_STOCK") !== "DENY" && !receiving && (
          <Button title="Receive items" kind="good" onPress={() => setReceiving(Object.fromEntries(po.lines.filter((l) => l.quantity > l.receivedQty).map((l) => [l.variantId, String(l.quantity - l.receivedQty)])))} />
        )}
        {receiving && (
          <>
            <Button title="Confirm received" kind="good" onPress={() => run(() => api("POST", `/purchase-orders/${po.id}/receive`, { lines: Object.entries(receiving).map(([variantId, q]) => ({ variantId, quantity: Number(q) || 0 })).filter((l) => l.quantity > 0) }), true)} />
            <Button title="Back" kind="secondary" onPress={() => setReceiving(null)} />
          </>
        )}
      </View>
    </ScrollView>
  );
}

function Vendors({ vendors, onChanged }: { vendors: Vendor[]; onChanged: () => void }) {
  const can = useCan();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title="Vendors">
      <Table rows={vendors} keyOf={(v) => v.id} columns={[{ key: "n", label: "Name", render: (v) => v.name, width: 200 }, { key: "e", label: "Email", render: (v) => v.email ?? "", width: 200 }, { key: "p", label: "Phone", render: (v) => v.phone ?? "", width: 140 }, { key: "a", label: "Active", render: (v) => <Switch value={v.active} disabled={can("MANAGE_PURCHASING") === "DENY"} onValueChange={(active) => api("PATCH", `/vendors/${v.id}`, { active }).then(onChanged)} />, width: 80 }]} empty="No vendors yet." />
      {can("MANAGE_PURCHASING") !== "DENY" && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
          <Field label="New vendor"><Input value={name} onChange={setName} placeholder="Name" /></Field>
          <Field label="Email"><Input value={email} onChange={setEmail} keyboard="email-address" /></Field>
          <Field label="Phone"><Input value={phone} onChange={setPhone} /></Field>
          <Button title="Add" disabled={!name.trim()} onPress={async () => {
            setError(null);
            try {
              await api("POST", "/vendors", { name: name.trim(), email: email.trim() || undefined, phone: phone.trim() || undefined });
              setName(""); setEmail(""); setPhone("");
              onChanged();
            } catch (e) {
              setError(e instanceof ApiError ? e.message : String(e));
            }
          }} />
        </View>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
    </Card>
  );
}
