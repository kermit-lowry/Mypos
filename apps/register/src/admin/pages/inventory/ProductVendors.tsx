import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { api, ApiError, type ProductVendor, type Vendor } from "../../../api";
import { Button } from "../../../components/Button";
import { colors, ui } from "../../../theme";
import { Card, Field, Input, money, Picker, Table, type Column } from "../../ui";

const dollars = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));
const toCents = (s: string) => {
  if (s.trim() === "") return null;
  const c = Math.round(Number(s) * 100);
  if (!Number.isFinite(c) || c < 0) throw new Error("Enter a cost like 12.50");
  return c;
};
const toDays = (s: string) => {
  if (s.trim() === "") return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new Error("Lead days must be a whole number");
  return n;
};

interface Draft {
  vendorSku: string;
  cost: string;
  leadDays: string;
}

const small = { minHeight: 32, paddingVertical: 4, paddingHorizontal: 10 } as const;

/** Who supplies this product, with their item number, price and lead time. One row edits at a time. */
export function ProductVendors({ productId, vendors, onChange, canEdit }: { productId: string; vendors: ProductVendor[]; onChange: (v: ProductVendor[]) => void; canEdit: boolean }) {
  const [all, setAll] = useState<Vendor[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ vendorSku: "", cost: "", leadDays: "" });
  const [adding, setAdding] = useState({ vendorId: "", vendorSku: "", cost: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (canEdit) api<Vendor[]>("GET", "/vendors").then(setAll).catch(() => undefined);
  }, [canEdit]);

  const run = async (fn: () => Promise<ProductVendor[]>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      onChange(await fn());
      setMessage(ok);
      return true;
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const put = (vendorId: string, body: Partial<Omit<ProductVendor, "vendorId" | "vendor">>, ok: string) => run(() => api<ProductVendor[]>("PUT", `/catalog/products/${productId}/vendors/${vendorId}`, body), ok);

  const startEdit = (r: ProductVendor) => {
    setEditing(r.vendorId);
    setDraft({ vendorSku: r.vendorSku ?? "", cost: dollars(r.costCents), leadDays: r.leadDays != null ? String(r.leadDays) : "" });
  };
  const saveEdit = async () => {
    if (!editing) return;
    const ok = await run(async () => api<ProductVendor[]>("PUT", `/catalog/products/${productId}/vendors/${editing}`, { vendorSku: draft.vendorSku.trim() || null, costCents: toCents(draft.cost), leadDays: toDays(draft.leadDays) }), "Vendor saved");
    if (ok) setEditing(null);
  };
  const add = async () => {
    // The first vendor linked is the preferred one until someone says otherwise.
    const ok = await run(async () => api<ProductVendor[]>("PUT", `/catalog/products/${productId}/vendors/${adding.vendorId}`, { vendorSku: adding.vendorSku.trim() || null, costCents: toCents(adding.cost), preferred: vendors.length === 0 }), "Vendor added");
    if (ok) setAdding({ vendorId: "", vendorSku: "", cost: "" });
  };
  const remove = (r: ProductVendor) => run(() => api<ProductVendor[]>("DELETE", `/catalog/products/${productId}/vendors/${r.vendorId}`), "Vendor removed");

  const nameOf = (r: ProductVendor) => r.vendor?.name ?? all.find((v) => v.id === r.vendorId)?.name ?? "Vendor";
  const cell = (key: keyof Draft, keyboard?: "decimal-pad" | "number-pad") => (
    <View style={{ minWidth: 90 }}>
      <Input value={draft[key]} onChange={(t) => setDraft((d) => ({ ...d, [key]: t }))} keyboard={keyboard} />
    </View>
  );
  const columns: Column<ProductVendor>[] = [
    { key: "v", label: "Vendor", render: nameOf, width: 170 },
    { key: "s", label: "Vendor SKU", render: (r) => (editing === r.vendorId ? cell("vendorSku") : r.vendorSku || "—"), width: 150 },
    { key: "c", label: "Cost", render: (r) => (editing === r.vendorId ? cell("cost", "decimal-pad") : money(r.costCents) || "—"), width: 110, align: "right" },
    { key: "l", label: "Lead days", render: (r) => (editing === r.vendorId ? cell("leadDays", "number-pad") : r.leadDays ?? "—"), width: 100, align: "right" },
    {
      key: "p",
      label: "Preferred",
      render: (r) => (
        <Pressable disabled={!canEdit || busy} hitSlop={8} onPress={() => put(r.vendorId, { preferred: !r.preferred }, r.preferred ? "No preferred vendor" : `${nameOf(r)} is now preferred`)} style={{ alignSelf: "flex-start" }}>
          <Text style={{ fontSize: 22, color: r.preferred ? colors.warn : colors.muted }}>{r.preferred ? "★" : "☆"}</Text>
        </Pressable>
      ),
      width: 90,
    },
    ...(canEdit
      ? [
          {
            key: "a",
            label: "",
            render: (r: ProductVendor) =>
              editing === r.vendorId ? (
                <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
                  <Button title="Save" kind="good" busy={busy} onPress={saveEdit} style={small} />
                  <Button title="Cancel" kind="secondary" onPress={() => setEditing(null)} style={small} />
                </View>
              ) : (
                <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
                  <Button title="Edit" kind="secondary" disabled={busy} onPress={() => startEdit(r)} style={small} />
                  <Button title="Remove" kind="danger" disabled={busy} onPress={() => remove(r)} style={small} />
                </View>
              ),
            width: 180,
          },
        ]
      : []),
  ];

  const linked = new Set(vendors.map((v) => v.vendorId));
  const choices = all.filter((v) => v.active && !linked.has(v.id)).map((v) => [v.id, v.name] as [string, string]);

  return (
    <Card title="Vendors" right={vendors.length > 0 ? <Text style={ui.muted}>{vendors.length} linked</Text> : undefined}>
      <Table rows={vendors} columns={columns} keyOf={(r) => r.vendorId} empty="No vendors linked yet." />
      {canEdit && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
          <Picker label="Add vendor" options={choices} value={adding.vendorId} onChange={(vendorId) => setAdding((a) => ({ ...a, vendorId }))} placeholder={choices.length ? "Choose a vendor" : "No other active vendors"} allowNone={false} />
          <Field label="Vendor SKU">
            <Input value={adding.vendorSku} onChange={(vendorSku) => setAdding((a) => ({ ...a, vendorSku }))} placeholder="their item #" />
          </Field>
          <Field label="Cost ($)">
            <Input value={adding.cost} onChange={(cost) => setAdding((a) => ({ ...a, cost }))} keyboard="decimal-pad" placeholder="unknown" />
          </Field>
          <Button title="Add" onPress={add} disabled={!adding.vendorId} busy={busy} />
        </View>
      )}
      <Text style={ui.muted}>Ordering from a vendor links it here automatically, and receiving the order updates its cost.</Text>
      {message && <Text style={ui.text}>{message}</Text>}
    </Card>
  );
}
