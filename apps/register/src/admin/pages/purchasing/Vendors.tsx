import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { api, type Product, type Vendor } from "../../../api";
import { Button } from "../../../components/Button";
import { ProductSearch } from "../../../components/ProductSearch";
import { useLayout } from "../../../layout";
import { useCan } from "../../../session";
import { colors, ui } from "../../../theme";
import { Card, type Column, day, Field, Input, money, Picker, Table } from "../../ui";
import { CellInput, dollars, fromServer, type Po, ReadField, small, StatusBadge, toCents, toInt, totalOf, type VendorItem } from "./common";

/** The vendor being edited: an existing one, a new one, or none. */
export type VendorPick = Vendor | "new" | null;

interface Category {
  id: string;
  name: string;
  path: string;
}
interface Msg {
  text: string;
  error?: boolean;
}

/** Vendor table with a search box; press a row to edit. */
export function VendorList({ vendors, onSelect, onChanged }: { vendors: Vendor[]; onSelect: (v: VendorPick) => void; onChanged: () => Promise<void> }) {
  const can = useCan();
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canManage = can("MANAGE_PURCHASING") !== "DENY";
  const term = q.trim().toLowerCase();
  const shown = term ? vendors.filter((v) => [v.name, v.contactName, v.email, v.phone, v.accountNumber].some((x) => x?.toLowerCase().includes(term))) : vendors;
  const toggle = (v: Vendor, active: boolean) =>
    api("PATCH", `/vendors/${v.id}`, { active })
      .then(onChanged)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  return (
    <Card title="Vendors" right={canManage ? <Button title="+ New vendor" kind="good" style={small} onPress={() => onSelect("new")} /> : undefined}>
      <Input value={q} onChange={setQ} placeholder="Search name, contact, email, phone, account #…" />
      <Table
        rows={shown}
        keyOf={(v) => v.id}
        onPress={(v) => onSelect(v)}
        columns={[
          { key: "n", label: "Name", render: (v) => <Text style={[ui.text, !v.active && { color: colors.muted }]}>{v.name}</Text>, width: 180 },
          { key: "c", label: "Contact", render: (v) => v.contactName ?? "", width: 140 },
          { key: "p", label: "Phone", render: (v) => v.phone ?? "", width: 120 },
          { key: "e", label: "Email", render: (v) => v.email ?? "", width: 180 },
          { key: "a", label: "Account #", render: (v) => v.accountNumber ?? "", width: 110 },
          { key: "i", label: "Products", render: (v) => v.products ?? 0, width: 80, align: "right" },
          { key: "o", label: "POs", render: (v) => v.purchaseOrders ?? 0, width: 60, align: "right" },
          {
            key: "x",
            label: "Active",
            // On web the checkbox click would bubble up and open the row.
            render: (v) => (
              <Pressable onPress={() => undefined} style={{ alignSelf: "flex-start" }}>
                <Switch value={v.active} disabled={!canManage} onValueChange={(active) => toggle(v, active)} />
              </Pressable>
            ),
            width: 70,
          },
        ]}
        empty={term ? "No vendors match." : "No vendors yet."}
      />
      {error && <Text style={ui.error}>{error}</Text>}
    </Card>
  );
}

interface Form {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  accountNumber: string;
  website: string;
  address: string;
  notes: string;
  defaultCategoryId: string;
  active: boolean;
}
type TextKey = Exclude<keyof Form, "active">;
const toForm = (v: Vendor | null): Form => ({
  name: v?.name ?? "",
  contactName: v?.contactName ?? "",
  email: v?.email ?? "",
  phone: v?.phone ?? "",
  accountNumber: v?.accountNumber ?? "",
  website: v?.website ?? "",
  address: v?.address ?? "",
  notes: v?.notes ?? "",
  defaultCategoryId: v?.defaultCategoryId ?? "",
  active: v?.active ?? true,
});

/** One vendor: contact details, the items they supply, and their orders. */
export function VendorEditor({ initial, onBack, onChanged, onOpenPo, onNewPo }: { initial: Vendor | null; onBack: () => void; onChanged: (saved?: Vendor) => Promise<void>; onOpenPo: (po: Po) => void; onNewPo: (vendorId: string) => void }) {
  const can = useCan();
  const { narrow } = useLayout();
  const canManage = can("MANAGE_PURCHASING") !== "DENY";
  const canCatalog = can("MANAGE_CATALOG") !== "DENY";
  const [id, setId] = useState(initial?.id ?? "");
  const [form, setForm] = useState<Form>(toForm(initial));
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<VendorItem[]>([]);
  const [orders, setOrders] = useState<Po[]>([]);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<Msg | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const fail = useCallback((e: unknown) => setMessage({ text: e instanceof Error ? e.message : String(e), error: true }), []);
  const run = async (label: string, fn: () => Promise<string | void>) => {
    setMessage(null);
    setBusy(label);
    try {
      const m = await fn();
      if (m) setMessage({ text: m });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    api<Category[]>("GET", "/categories").then(setCategories).catch(() => undefined);
  }, []);
  const loadItems = useCallback(async () => {
    if (id) setItems(await api("GET", `/vendors/${id}/products`));
  }, [id]);
  const loadOrders = useCallback(async () => {
    if (id) setOrders((await api<any[]>("GET", `/purchase-orders?vendorId=${id}`)).map(fromServer));
  }, [id]);
  useEffect(() => {
    loadItems().catch(fail);
    loadOrders().catch(fail);
  }, [loadItems, loadOrders, fail]);

  const body = () => {
    const s = (t: string) => t.trim() || null;
    return { name: form.name.trim(), contactName: s(form.contactName), email: s(form.email), phone: s(form.phone), accountNumber: s(form.accountNumber), website: s(form.website), address: s(form.address), notes: s(form.notes), defaultCategoryId: form.defaultCategoryId || null, active: form.active };
  };
  const save = () =>
    run("save", async () => {
      if (!form.name.trim()) throw new Error("Enter the vendor's name");
      const saved = id ? await api<Vendor>("PATCH", `/vendors/${id}`, body()) : await api<Vendor>("POST", "/vendors", body());
      setId(saved.id);
      await onChanged(saved);
      return "Saved";
    });
  const setLink = (productId: string, patch: { vendorSku?: string | null; costCents?: number | null; preferred?: boolean; leadDays?: number | null }) =>
    run("link", async () => {
      await api("PUT", `/catalog/products/${productId}/vendors/${id}`, patch);
      await loadItems();
    });
  const unlink = (item: VendorItem) =>
    run("link", async () => {
      await api("DELETE", `/catalog/products/${item.product.id}/vendors/${id}`);
      await loadItems();
      return `Removed ${item.product.title}`;
    });
  const addItem = (p: Product) =>
    run("link", async () => {
      if (items.some((i) => i.product.id === p.id)) return `${p.title} is already on this vendor`;
      await api("PUT", `/catalog/products/${p.id}/vendors/${id}`, {});
      await loadItems();
      return `Added ${p.title}`;
    });

  const text = (label: string, k: TextKey, opts: { multiline?: boolean; keyboard?: "email-address" } = {}) =>
    canManage ? (
      <Field label={label}>
        <Input value={form[k]} onChange={(t) => set({ [k]: t })} multiline={opts.multiline} keyboard={opts.keyboard} />
      </Field>
    ) : (
      <ReadField label={label} value={form[k]} />
    );
  const note = message && <Text style={message.error ? ui.error : [ui.text, { color: colors.good }]}>{message.text}</Text>;

  if (adding) {
    return (
      <View style={{ flex: 1, padding: 12, gap: 8 }}>
        <View style={[ui.row, { gap: 12, flexWrap: "wrap", justifyContent: "space-between" }]}>
          <Button title="Done" onPress={() => setAdding(false)} />
          <Text style={ui.muted}>
            Pick the items {form.name || "this vendor"} supplies · {items.length} linked
          </Text>
        </View>
        {note}
        <ProductSearch onPick={(p) => addItem(p)} placeholder="Search items to add…" />
      </View>
    );
  }

  const itemColumns: Column<VendorItem>[] = [
    {
      key: "i",
      label: "Item",
      render: (i) => (
        <View>
          <Text style={ui.text}>{i.product.title}</Text>
          {i.product.variants.length > 1 && <Text style={ui.muted}>{i.product.variants.length} variants</Text>}
        </View>
      ),
      width: 220,
    },
    { key: "b", label: "Brand", render: (i) => i.product.brand ?? "", width: 110 },
    { key: "s", label: "Vendor SKU", render: (i) => (canCatalog ? <CellInput value={i.vendorSku ?? ""} width={120} onCommit={(t) => setLink(i.product.id, { vendorSku: t.trim() || null })} /> : (i.vendorSku ?? "")), width: 130 },
    { key: "c", label: "Cost", render: (i) => (canCatalog ? <CellInput value={dollars(i.costCents)} width={90} keyboard="decimal-pad" placeholder="0.00" onCommit={(t) => setLink(i.product.id, { costCents: t.trim() === "" ? null : toCents(t) })} /> : money(i.costCents)), width: 100, align: "right" },
    { key: "p", label: "Preferred", render: (i) => <Switch value={i.preferred} disabled={!canCatalog} onValueChange={(preferred) => setLink(i.product.id, { preferred })} />, width: 80 },
    { key: "l", label: "Lead days", render: (i) => (canCatalog ? <CellInput value={i.leadDays == null ? "" : String(i.leadDays)} width={70} keyboard="number-pad" onCommit={(t) => setLink(i.product.id, { leadDays: t.trim() === "" ? null : toInt(t) })} /> : (i.leadDays ?? "")), width: 90 },
    ...(canCatalog ? [{ key: "x", label: "", render: (i: VendorItem) => <Button title="Remove" kind="secondary" style={small} onPress={() => unlink(i)} />, width: 90 }] : []),
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card
        title={id ? form.name || "Vendor" : "New vendor"}
        right={<Button title="Back" kind="secondary" style={small} onPress={onBack} />}
      >
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          {text("Name", "name")}
          {text("Contact", "contactName")}
          {text("Email", "email", { keyboard: "email-address" })}
          {text("Phone", "phone")}
        </View>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          {text("Account #", "accountNumber")}
          {text("Website", "website")}
          {canManage ? (
            <Picker label="Default category for new items" options={categories.map((c): [string, string] => [c.id, c.path])} value={form.defaultCategoryId} onChange={(defaultCategoryId) => set({ defaultCategoryId })} noneLabel="None" />
          ) : (
            <ReadField label="Default category" value={categories.find((c) => c.id === form.defaultCategoryId)?.path} />
          )}
        </View>
        {text("Address", "address", { multiline: true })}
        {text("Notes", "notes", { multiline: true })}
        <View style={[ui.row, { gap: 8 }]}>
          <Text style={ui.muted}>Active</Text>
          <Switch value={form.active} disabled={!canManage} onValueChange={(active) => set({ active })} />
        </View>
        {note}
        {canManage && (
          <View style={[ui.row, { gap: 8 }]}>
            <Button title={id ? "Save vendor" : "Create vendor"} busy={busy === "save"} onPress={save} />
          </View>
        )}
      </Card>

      <Card title={`${narrow ? "Items" : "Items from this vendor"} · ${items.length}`} right={id && canCatalog ? <Button title="+ Add item" style={small} onPress={() => setAdding(true)} /> : undefined}>
        {id ? <Table rows={items} keyOf={(i) => i.product.id} columns={itemColumns} empty="No items linked yet. Ordering from this vendor links them automatically." /> : <Text style={ui.muted}>Save the vendor first, then add the items they supply.</Text>}
      </Card>

      {id && (
        <Card title={`Purchase orders · ${orders.length}`} right={canManage ? <Button title={narrow ? "+ New PO" : "New PO for this vendor"} kind="good" style={small} onPress={() => onNewPo(id)} /> : undefined}>
          <Table
            rows={orders.slice(0, 20)}
            keyOf={(o) => o.id ?? ""}
            onPress={onOpenPo}
            columns={[
              { key: "n", label: "PO #", render: (o) => `#${o.number}`, width: 70 },
              { key: "s", label: "Status", render: (o) => <StatusBadge status={o.status} />, width: 100 },
              { key: "t", label: "Total", render: (o) => money(totalOf(o)), width: 100, align: "right" },
              { key: "d", label: "Date", render: (o) => (o.createdAt ? day(o.createdAt) : ""), width: 110 },
              { key: "r", label: "Reference", render: (o) => o.reference ?? "", width: 140 },
            ]}
            empty="No purchase orders yet."
          />
          {orders.length > 20 && <Text style={ui.muted}>Showing the latest 20; the Purchase orders page has the rest.</Text>}
        </Card>
      )}
    </ScrollView>
  );
}
