import { formatCents, PromotionTypes, type PromotionType } from "@mypos/shared";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { api, ApiError, type Product } from "../api";
import { Button } from "../components/Button";
import { ProductSearch } from "../components/ProductSearch";
import { useLayout } from "../layout";
import { colors, ui } from "../theme";

interface Category {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  productCount: number;
}

interface Deal {
  id?: string;
  name: string;
  description?: string;
  active: boolean;
  type: PromotionType;
  priority: number;
  stackable: boolean;
  targetAll: boolean;
  productIds: string[];
  variantIds: string[];
  categoryIds: string[];
  excludeProductIds: string[];
  excludeCategoryIds: string[];
  getProductIds: string[];
  getVariantIds: string[];
  getCategoryIds: string[];
  percentBps?: number | null;
  amountCents?: number | null;
  priceCents?: number | null;
  buyQty?: number | null;
  getQty?: number | null;
  getDiscountBps?: number | null;
  minQty?: number | null;
  minSubtotalCents?: number | null;
  maxApplications?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  dates: string[];
  daysOfWeek: number[];
  startTime?: string | null;
  endTime?: string | null;
  channels: ("POS" | "STOREFRONT")[];
}

const TYPE_LABELS: Record<PromotionType, string> = {
  PERCENT_OFF: "% off",
  AMOUNT_OFF: "$ off each",
  SALE_PRICE: "Sale price",
  BUY_X_GET_Y: "Buy X get Y",
  MULTI_BUY: "X for $Y",
  ORDER_DISCOUNT: "Spend & save",
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const blank = (): Deal => ({
  name: "",
  active: true,
  type: "BUY_X_GET_Y",
  priority: 100,
  stackable: false,
  targetAll: false,
  productIds: [],
  variantIds: [],
  categoryIds: [],
  excludeProductIds: [],
  excludeCategoryIds: [],
  getProductIds: [],
  getVariantIds: [],
  getCategoryIds: [],
  buyQty: 1,
  getQty: 1,
  getDiscountBps: 10_000,
  dates: [],
  daysOfWeek: [],
  channels: ["POS", "STOREFRONT"],
});

/** One-line description of a deal for the list. */
function summary(d: Deal): string {
  const what = (() => {
    switch (d.type) {
      case "PERCENT_OFF":
        return `${(d.percentBps ?? 0) / 100}% off`;
      case "AMOUNT_OFF":
        return `${formatCents(d.amountCents ?? 0)} off each`;
      case "SALE_PRICE":
        return `${formatCents(d.priceCents ?? 0)} each`;
      case "BUY_X_GET_Y":
        return `Buy ${d.buyQty} get ${d.getQty} ${d.getDiscountBps === 10_000 || d.getDiscountBps == null ? "free" : `${(d.getDiscountBps ?? 0) / 100}% off`}`;
      case "MULTI_BUY":
        return `${d.buyQty} for ${formatCents(d.priceCents ?? 0)}`;
      case "ORDER_DISCOUNT":
        return `Spend ${formatCents(d.minSubtotalCents ?? 0)}, save ${d.percentBps ? `${d.percentBps / 100}%` : formatCents(d.amountCents ?? 0)}`;
    }
  })();
  const when = [
    d.daysOfWeek.length ? d.daysOfWeek.map((n) => DAYS[n]).join("/") : null,
    d.startTime && d.endTime ? `${d.startTime}–${d.endTime}` : null,
    d.dates.length ? `${d.dates.length} date(s)` : null,
    d.endsAt ? `until ${d.endsAt.slice(0, 10)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return [what, when || "always"].join(" · ");
}

/** Back office: automated deals and the category tree they target. */
export function DealsScreen() {
  const { compact } = useLayout();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<Deal | null>(null);
  const [view, setView] = useState<"deals" | "categories">("deals");

  const load = useCallback(async () => {
    setDeals(await api<Deal[]>("GET", "/promotions"));
    setCategories(await api<Category[]>("GET", "/categories"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const list = (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={[ui.row, { gap: 8 }]}>
        <Button title="Deals" kind={view === "deals" ? "primary" : "secondary"} onPress={() => setView("deals")} style={{ flex: 1 }} />
        <Button title="Categories" kind={view === "categories" ? "primary" : "secondary"} onPress={() => setView("categories")} style={{ flex: 1 }} />
      </View>
      {view === "deals" ? (
        <>
          <Button title="+ New deal" kind="good" onPress={() => setEditing(blank())} />
          <FlatList
            data={deals}
            keyExtractor={(d) => d.id!}
            ListEmptyComponent={<Text style={ui.muted}>No deals yet.</Text>}
            renderItem={({ item: d }) => (
              <Pressable
                onPress={() => setEditing(d)}
                style={[ui.row, { gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, opacity: d.active ? 1 : 0.5 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={ui.text}>{d.name}</Text>
                  <Text style={ui.muted}>{summary(d)}</Text>
                </View>
                <Switch
                  value={d.active}
                  onValueChange={async (active) => {
                    await api("PATCH", `/promotions/${d.id}`, { active });
                    load();
                  }}
                />
              </Pressable>
            )}
          />
        </>
      ) : (
        <CategoryManager categories={categories} onChanged={load} />
      )}
    </View>
  );

  const form = editing ? (
    <DealForm
      key={editing.id ?? "new"}
      initial={editing}
      categories={categories}
      onDone={() => {
        setEditing(null);
        load();
      }}
    />
  ) : (
    <Text style={ui.muted}>Pick a deal to edit, or create one. Deals apply automatically at the register and online.</Text>
  );

  if (compact) return <View style={[ui.panel, { flex: 1, margin: 8 }]}>{editing ? form : list}</View>;
  return (
    <View style={{ flex: 1, flexDirection: "row", gap: 16, padding: 16 }}>
      <View style={[ui.panel, { flex: 2 }]}>{list}</View>
      <View style={[ui.panel, { flex: 3 }]}>{form}</View>
    </View>
  );
}

// ── Deal editor ──────────────────────────────────────────────────

function DealForm({ initial, categories, onDone }: { initial: Deal; categories: Category[]; onDone: () => void }) {
  const [d, setD] = useState<Deal>(initial);
  // Dates are edited as text and converted on save, so half-typed dates are harmless.
  const [startDate, setStartDate] = useState(initial.startsAt ? localDate(new Date(initial.startsAt)) : "");
  const [endDate, setEndDate] = useState(initial.endsAt ? localDate(new Date(new Date(initial.endsAt).getTime() - 1)) : "");
  const [products, setProducts] = useState<{ id: string; title: string }[]>([]);
  const [pickingProducts, setPickingProducts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Deal>) => setD((x) => ({ ...x, ...patch }));
  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  useEffect(() => {
    // Names for products already in the deal.
    Promise.all(d.productIds.map((id) => api<{ id: string; title: string }>("GET", `/catalog/products/${id}`).catch(() => ({ id, title: id })))).then(setProducts);
  }, []);

  async function save() {
    setError(null);
    const isDate = (t: string) => /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(new Date(`${t}T00:00:00`).getTime());
    if ((startDate && !isDate(startDate)) || (endDate && !isDate(endDate))) return setError("Dates must look like 2026-11-27");
    const bad = d.dates.find((x) => !isDate(x));
    if (bad) return setError(`"${bad}" isn't a date like 2026-11-27`);
    const body = {
      ...d,
      // Start at local midnight; "ends after" a date means through the end of that day.
      startsAt: startDate ? new Date(`${startDate}T00:00:00`).toISOString() : null,
      endsAt: endDate ? new Date(new Date(`${endDate}T00:00:00`).getTime() + 86_400_000).toISOString() : null,
      startTime: d.startTime || null,
      endTime: d.endTime || null,
    };
    delete body.id;
    // The API treats missing optional fields as "not set".
    for (const k of Object.keys(body) as (keyof typeof body)[]) if (body[k] === null) delete body[k];
    try {
      if (d.id) await api("PUT", `/promotions/${d.id}`, body);
      else await api("POST", "/promotions", body);
      onDone();
    } catch (e) {
      const details = e instanceof ApiError ? (e.details as { fieldErrors?: Record<string, string[]> } | undefined) : undefined;
      const first = details?.fieldErrors ? Object.values(details.fieldErrors).flat()[0] : undefined;
      setError(first ?? (e instanceof ApiError ? e.message : String(e)));
    }
  }

  async function remove() {
    if (d.id) await api("PATCH", `/promotions/${d.id}`, { active: false });
    onDone();
  }

  if (pickingProducts) {
    return (
      <View style={{ flex: 1, gap: 8 }}>
        <ProductSearch
          onPick={(p: Product) => {
            if (!d.productIds.includes(p.id)) {
              set({ productIds: [...d.productIds, p.id] });
              setProducts((x) => [...x, { id: p.id, title: p.title }]);
            }
          }}
        />
        <Button title="Done adding products" onPress={() => setPickingProducts(false)} />
      </View>
    );
  }

  const num = (v: number | null | undefined, scale = 1) => (v == null ? "" : String(v / scale));
  const setNum = (field: keyof Deal, scale = 1) => (t: string) => set({ [field]: t.trim() === "" ? null : Math.round(Number(t) * scale) } as Partial<Deal>);

  return (
    <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: 24 }}>
      <Text style={ui.h1}>{d.id ? "Edit deal" : "New deal"}</Text>
      <Field label="Name (shown on receipts and the customer display)">
        <TextInput style={ui.input} value={d.name} onChangeText={(name) => set({ name })} placeholder="e.g. Sealed BOGO 50% Fridays" placeholderTextColor={colors.muted} />
      </Field>

      <Field label="Type">
        <Chips options={PromotionTypes.map((t) => [t, TYPE_LABELS[t]])} selected={[d.type]} onToggle={(type) => set({ type: type as PromotionType })} />
      </Field>

      {d.type === "PERCENT_OFF" && <NumberField label="% off" value={num(d.percentBps, 100)} onChange={setNum("percentBps", 100)} />}
      {d.type === "AMOUNT_OFF" && <NumberField label="$ off each item" value={num(d.amountCents, 100)} onChange={setNum("amountCents", 100)} />}
      {d.type === "SALE_PRICE" && <NumberField label="Sale price each ($)" value={num(d.priceCents, 100)} onChange={setNum("priceCents", 100)} />}
      {d.type === "BUY_X_GET_Y" && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <NumberField label="Buy" value={num(d.buyQty)} onChange={setNum("buyQty")} />
          <NumberField label="Get" value={num(d.getQty)} onChange={setNum("getQty")} />
          <NumberField label="% off what they get (100 = free)" value={num(d.getDiscountBps, 100)} onChange={setNum("getDiscountBps", 100)} />
        </View>
      )}
      {d.type === "MULTI_BUY" && (
        <View style={[ui.row, { gap: 8 }]}>
          <NumberField label="How many" value={num(d.buyQty)} onChange={setNum("buyQty")} />
          <NumberField label="For ($)" value={num(d.priceCents, 100)} onChange={setNum("priceCents", 100)} />
        </View>
      )}
      {d.type === "ORDER_DISCOUNT" && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <NumberField label="When they spend ($)" value={num(d.minSubtotalCents, 100)} onChange={setNum("minSubtotalCents", 100)} />
          <NumberField label="% off" value={num(d.percentBps, 100)} onChange={setNum("percentBps", 100)} />
          <NumberField label="or $ off" value={num(d.amountCents, 100)} onChange={setNum("amountCents", 100)} />
        </View>
      )}

      <Field label="Applies to">
        <View style={[ui.row, { justifyContent: "space-between" }]}>
          <Text style={ui.text}>Everything in the store</Text>
          <Switch value={d.targetAll} onValueChange={(targetAll) => set({ targetAll })} />
        </View>
        {!d.targetAll && (
          <>
            <Text style={ui.muted}>Categories (includes their subcategories)</Text>
            <Chips options={categories.map((c) => [c.id, c.path])} selected={d.categoryIds} onToggle={(id) => set({ categoryIds: toggle(d.categoryIds, id) })} />
            <Text style={ui.muted}>Products</Text>
            <Chips options={products.map((p) => [p.id, `${p.title} ✕`])} selected={d.productIds} onToggle={(id) => set({ productIds: toggle(d.productIds, id) })} />
            <Button title="+ Add products" kind="secondary" onPress={() => setPickingProducts(true)} />
          </>
        )}
        <Text style={ui.muted}>Never applies to</Text>
        <Chips
          options={categories.map((c) => [c.id, c.path])}
          selected={d.excludeCategoryIds}
          onToggle={(id) => set({ excludeCategoryIds: toggle(d.excludeCategoryIds, id) })}
        />
      </Field>

      {d.type === "BUY_X_GET_Y" && (
        <Field label="What they get (leave empty for the same items; the free one is of equal or lesser value)">
          <Chips options={categories.map((c) => [c.id, c.path])} selected={d.getCategoryIds} onToggle={(id) => set({ getCategoryIds: toggle(d.getCategoryIds, id) })} />
        </Field>
      )}

      <Field label="When (all optional; leave empty to run any time)">
        <View style={[ui.row, { gap: 8 }]}>
          <TextField label="Starts (YYYY-MM-DD)" value={startDate} onChange={setStartDate} />
          <TextField label="Ends after (YYYY-MM-DD)" value={endDate} onChange={setEndDate} />
        </View>
        <Text style={ui.muted}>Days of the week</Text>
        <Chips options={DAYS.map((name, i) => [String(i), name])} selected={d.daysOfWeek.map(String)} onToggle={(i) => set({ daysOfWeek: toggle(d.daysOfWeek, Number(i)).sort() })} />
        <View style={[ui.row, { gap: 8 }]}>
          <TextField label="From (HH:MM, 24h)" value={d.startTime ?? ""} onChange={(t) => set({ startTime: t || null })} />
          <TextField label="Until (HH:MM)" value={d.endTime ?? ""} onChange={(t) => set({ endTime: t || null })} />
        </View>
        <TextField
          label="Only on these dates (YYYY-MM-DD, comma separated)"
          value={d.dates.join(", ")}
          onChange={(t) => set({ dates: t.split(",").map((x) => x.trim()).filter(Boolean) })}
          placeholder="2026-11-27, 2026-12-26"
        />
      </Field>

      <Field label="Where">
        <Chips
          options={[
            ["POS", "In store"],
            ["STOREFRONT", "Online"],
          ]}
          selected={d.channels}
          onToggle={(c) => set({ channels: toggle(d.channels, c as "POS" | "STOREFRONT") })}
        />
      </Field>

      <Field label="Rules">
        <View style={[ui.row, { justifyContent: "space-between" }]}>
          <Text style={[ui.text, { flex: 1 }]}>Can combine with other deals</Text>
          <Switch value={d.stackable} onValueChange={(stackable) => set({ stackable })} />
        </View>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <NumberField label="Priority (lower runs first)" value={String(d.priority)} onChange={(t) => set({ priority: Number(t) || 0 })} />
          <NumberField label="Max uses per sale" value={num(d.maxApplications)} onChange={setNum("maxApplications")} />
          <NumberField label="Min items" value={num(d.minQty)} onChange={setNum("minQty")} />
        </View>
      </Field>

      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8 }]}>
        <Button title="Cancel" kind="secondary" onPress={onDone} />
        {d.id && <Button title="Turn off" kind="danger" onPress={remove} />}
        <Button title="Save deal" kind="good" onPress={save} disabled={!d.name || d.channels.length === 0} style={{ flex: 1 }} />
      </View>
    </ScrollView>
  );
}

// ── Categories ───────────────────────────────────────────────────

function CategoryManager({ categories, onChanged }: { categories: Category[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<Category | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (assigning) {
    return (
      <View style={{ flex: 1, gap: 8 }}>
        <Text style={ui.h2}>Add products to {assigning.path}</Text>
        {message && <Text style={[ui.muted, { color: colors.good }]}>{message}</Text>}
        <ProductSearch
          onPick={async (p: Product) => {
            await api("POST", "/categories/assign", { categoryId: assigning.id, productIds: [p.id] });
            setMessage(`Added ${p.title}`);
          }}
        />
        <Button
          title="Done"
          onPress={() => {
            setAssigning(null);
            setMessage(null);
            onChanged();
          }}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <FlatList
        data={categories}
        keyExtractor={(c) => c.id}
        ListEmptyComponent={<Text style={ui.muted}>No categories yet. Start with games or brands, e.g. Pokémon, then Pokémon › Sealed.</Text>}
        renderItem={({ item: c }) => (
          <View style={[ui.row, { gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={ui.text}>{c.path}</Text>
              <Text style={ui.muted}>{c.productCount} products</Text>
            </View>
            <Button title="+ Products" kind="secondary" onPress={() => setAssigning(c)} />
          </View>
        )}
      />
      <TextInput style={ui.input} value={name} onChangeText={setName} placeholder="New category name" placeholderTextColor={colors.muted} />
      <Text style={ui.muted}>Inside (optional)</Text>
      <Chips options={categories.map((c) => [c.id, c.path])} selected={parentId ? [parentId] : []} onToggle={(id) => setParentId(parentId === id ? null : id)} />
      {message && <Text style={ui.error}>{message}</Text>}
      <Button
        title="Add category"
        disabled={!name.trim()}
        onPress={async () => {
          try {
            await api("POST", "/categories", { name: name.trim(), parentId });
            setName("");
            setParentId(null);
            setMessage(null);
            onChanged();
          } catch (e) {
            setMessage(e instanceof ApiError ? e.message : String(e));
          }
        }}
      />
    </View>
  );
}

// ── Small form pieces ────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[ui.muted, { fontWeight: "600" }]}>{label}</Text>
      {children}
    </View>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (t: string) => void }) {
  return (
    <View style={{ gap: 4, minWidth: 110, flexGrow: 1 }}>
      <Text style={ui.muted}>{label}</Text>
      <TextInput style={ui.input} keyboardType="decimal-pad" defaultValue={value} onChangeText={onChange} />
    </View>
  );
}

function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (t: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  return (
    <View style={{ gap: 4, flex: 1 }}>
      <Text style={ui.muted}>{label}</Text>
      <TextInput
        style={ui.input}
        value={text}
        onChangeText={(t) => {
          setText(t);
          onChange(t.trim());
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

/** YYYY-MM-DD in the device's local time. */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function Chips({ options, selected, onToggle }: { options: [string, string][]; selected: string[]; onToggle: (v: string) => void }) {
  return (
    <View style={[ui.row, { flexWrap: "wrap", gap: 8 }]}>
      {options.map(([v, label]) => (
        <Pressable
          key={v}
          onPress={() => onToggle(v)}
          style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: selected.includes(v) ? colors.accent : colors.panelAlt }}
        >
          <Text style={ui.text}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
