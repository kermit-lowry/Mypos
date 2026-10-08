import { CardConditions, CardFinishes, ItemConditions, ProductKinds, formatCents, type ProductKind } from "@mypos/shared";
import { useEffect, useState } from "react";
import { Platform, ScrollView, Switch, Text, View } from "react-native";
import { api, ApiError, apiText, type Brand, type Product, type ProductVendor, type Variant, type Vendor } from "../../api";
import { NotPermitted, useGuard } from "../../approval";
import { Button } from "../../components/Button";
import { MarketBadge } from "../../components/MarketBadge";
import { imageOf, ProductSearch, variantLabel } from "../../components/ProductSearch";
import { SplitPane } from "../../components/SplitPane";
import { Thumb } from "../../components/Thumb";
import { useCan, useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Badge, Card, Chips, Field, Input, money, Picker, Table, when } from "../ui";
import { BrandInput } from "./inventory/BrandInput";
import { Brands } from "./inventory/Brands";
import { ProductVendors } from "./inventory/ProductVendors";

interface Category {
  id: string;
  path: string;
}

/** Items and stock: find anything, edit prices and details, adjust counts, print labels, add products. */
export function Inventory({ view = "items" }: { view?: "items" | "brands" }) {
  const [picked, setPicked] = useState<{ product: Product; variant: Variant } | null>(null);
  const [adding, setAdding] = useState(false);
  const [showRight, setShowRight] = useState(false);
  // "Find items" on the Brands page: the items view, narrowed to that brand.
  const [brandFilter, setBrandFilter] = useState<Brand | null>(null);
  const can = useCan();
  useEffect(() => setBrandFilter(null), [view]);

  if (view === "brands" && !brandFilter) return <Brands onFind={setBrandFilter} />;
  return (
    <SplitPane
      leftLabel="Find"
      rightLabel={adding ? "New product" : picked ? "Edit" : "Details"}
      showRight={showRight}
      onToggle={setShowRight}
      left={
        <View style={{ flex: 1, gap: 8 }}>
          {brandFilter && (
            <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
              <Badge text={`Brand: ${brandFilter.name}`} />
              <Button title="← Brands" kind="secondary" onPress={() => setBrandFilter(null)} style={{ minHeight: 32, paddingVertical: 4, paddingHorizontal: 10 }} />
            </View>
          )}
          {can("MANAGE_CATALOG") !== "DENY" && <Button title="+ New product" kind="secondary" onPress={() => (setAdding(true), setShowRight(true))} />}
          <ProductSearch
            key={brandFilter?.id ?? "all"}
            extraQuery={brandFilter ? `brands=${encodeURIComponent(brandFilter.id)}` : undefined}
            placeholder={brandFilter ? `Search ${brandFilter.name} items…` : undefined}
            onPick={(product, variant) => {
              setPicked({ product, variant });
              setAdding(false);
              setShowRight(true);
            }}
          />
        </View>
      }
      right={
        adding ? (
          <NewProduct onDone={() => setAdding(false)} />
        ) : picked ? (
          <ItemEditor key={picked.variant.id} product={picked.product} variant={picked.variant} onChanged={(p, v) => setPicked({ product: p, variant: v })} />
        ) : (
          <Text style={ui.muted}>Search for an item to see its stock, price, and history.</Text>
        )
      }
    />
  );
}

const isWear = (kind: string) => kind === "SNEAKER" || kind === "APPAREL";

function ItemEditor({ product, variant, onChanged }: { product: Product; variant: Variant; onChanged: (p: Product, v: Variant) => void }) {
  const { location } = useSession();
  const can = useCan();
  const guard = useGuard();
  const [price, setPrice] = useState((variant.priceCents / 100).toFixed(2));
  const [cost, setCost] = useState(variant.costCents != null ? (variant.costCents / 100).toFixed(2) : "");
  const [barcode, setBarcode] = useState(variant.barcode ?? "");
  const [autoPrice, setAutoPrice] = useState(!!variant.autoPrice);
  const [image, setImage] = useState(variant.imageUrl ?? "");
  const [title, setTitle] = useState(product.title);
  const [brand, setBrand] = useState(product.brand ?? "");
  const [styleCode, setStyleCode] = useState(product.styleCode ?? "");
  const [categoryId, setCategoryId] = useState<string | null>(product.categoryId ?? null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [channels, setChannels] = useState<string[]>(product.channels ?? ["POS"]);
  const [vendors, setVendors] = useState<ProductVendor[]>(product.vendors ?? []);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("RECEIVE");
  const [lowStock, setLowStock] = useState("");
  const [history, setHistory] = useState<{ id: string; delta: number; reason: string; note: string | null; createdAt: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [onHand, setOnHand] = useState(variant.inventory?.find((i) => i.locationId === location.id)?.onHand ?? 0);

  useEffect(() => {
    api<Category[]>("GET", "/categories").then(setCategories).catch(() => undefined);
    api("GET", `/inventory/${variant.id}/history`).then(setHistory).catch(() => undefined);
    api<ProductVendor[]>("GET", `/catalog/products/${product.id}/vendors`).then(setVendors).catch(() => undefined);
  }, [variant.id, product.id]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
    } catch (e) {
      setMessage(e instanceof ApiError || e instanceof NotPermitted ? e.message : String(e));
    }
  };

  const wear = isWear(product.kind);
  const saveDetails = () =>
    run(async () => {
      const cents = Math.round(Number(price) * 100);
      const v = await api<Variant>("PATCH", `/catalog/variants/${variant.id}`, {
        priceCents: Number.isFinite(cents) ? cents : variant.priceCents,
        costCents: cost.trim() === "" ? null : Math.round(Number(cost) * 100),
        barcode: barcode.trim() || undefined,
        autoPrice,
        imageUrl: image.trim() || null,
      });
      const p = await api<Product>("PATCH", `/catalog/products/${product.id}`, {
        title: title.trim(),
        categoryId,
        channels,
        brand: brand.trim() || null,
        ...(wear ? { styleCode: styleCode.trim() || null } : {}),
      });
      onChanged({ ...product, ...p, variants: product.variants }, { ...variant, ...v });
    }, "Saved");

  const vendorsChanged = (list: ProductVendor[]) => {
    setVendors(list);
    onChanged({ ...product, vendors: list }, variant);
  };

  const adjust = () =>
    run(async () => {
      const n = Number(delta);
      if (!Number.isInteger(n) || n === 0) throw new Error("Enter a whole number, e.g. 5 or -2");
      const r = await guard("INVENTORY_ADJUST", (t) => api<{ onHand: number }>("POST", "/inventory/adjust", { variantId: variant.id, locationId: location.id, delta: n, reason }, { approvalToken: t }));
      if (!r) return;
      setOnHand(r.onHand);
      setDelta("");
      setHistory(await api("GET", `/inventory/${variant.id}/history`));
    }, "Stock updated");

  const printLabel = () =>
    run(async () => {
      const html = await apiText("POST", "/labels", { locationId: location.id, items: [{ variantId: variant.id, copies: 1 }], format: "html" });
      if (Platform.OS === "web") {
        const w = window.open("", "_blank");
        if (!w) throw new Error("Allow pop-ups to print labels");
        w.document.write(html);
        w.document.close();
        w.focus();
        w.print();
      }
    }, "Label sent to print");

  const canEdit = can("MANAGE_CATALOG") !== "DENY";
  const supplier = vendors.find((v) => v.preferred) ?? vendors[0];
  return (
    <ScrollView contentContainerStyle={{ gap: 12 }}>
      <View style={[ui.row, { gap: 12 }]}>
        <Thumb uri={imageOf(product, variant)} title={product.title} size={64} />
        <View style={{ flex: 1 }}>
          <Text style={ui.h2}>{product.title}</Text>
          <Text style={ui.muted}>
            {variantLabel(variant)} · {variant.sku}
            {product.brand ? ` · ${product.brand}` : ""}
          </Text>
          <MarketBadge market={variant.market} />
          {supplier && (
            <Text style={ui.muted}>
              {supplier.preferred ? "Preferred vendor: " : "Vendor: "}
              {supplier.vendor?.name ?? "…"}
              {supplier.costCents != null ? ` · ${money(supplier.costCents)}` : ""}
              {vendors.length > 1 ? ` · +${vendors.length - 1} more` : ""}
            </Text>
          )}
          <Text style={[ui.text, { marginTop: 4 }]}>
            {onHand} on hand at {location.name}
          </Text>
        </View>
      </View>

      <Card title="Price & details">
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Field label="Price ($)"><Input value={price} onChange={setPrice} keyboard="decimal-pad" /></Field>
          <Field label="Cost ($)"><Input value={cost} onChange={setCost} keyboard="decimal-pad" placeholder="unknown" /></Field>
          <Field label="Barcode"><Input value={barcode} onChange={setBarcode} /></Field>
        </View>
        {variant.market?.marketCents != null && (
          <View style={[ui.row, { justifyContent: "space-between" }]}>
            <Text style={ui.text}>Follow market price automatically</Text>
            <Switch value={autoPrice} onValueChange={setAutoPrice} />
          </View>
        )}
        <Field label="Product name"><Input value={title} onChange={setTitle} /></Field>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
          <BrandInput value={brand} onChange={setBrand} />
          {wear && <Field label="Style code"><Input value={styleCode} onChange={setStyleCode} placeholder="e.g. DD1391-100" /></Field>}
        </View>
        <Field label="Photo URL (this item)"><Input value={image} onChange={setImage} placeholder="https://…" /></Field>
        <Text style={ui.muted}>Category</Text>
        <Chips options={[["", "None"], ...categories.map((c) => [c.id, c.path] as [string, string])]} value={categoryId ?? ""} onChange={(v) => setCategoryId(v || null)} />
        <Text style={ui.muted}>Sold on</Text>
        <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
          {(["POS", "STOREFRONT", "SHOPIFY", "EBAY"] as const).map((c) => (
            <Button key={c} title={c === "POS" ? "In store" : c === "STOREFRONT" ? "Web store" : c[0] + c.slice(1).toLowerCase()} kind={channels.includes(c) ? "primary" : "secondary"} onPress={() => setChannels((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]))} style={{ minHeight: 36, paddingVertical: 6 }} />
          ))}
        </View>
        {canEdit ? <Button title="Save" kind="good" onPress={saveDetails} /> : <Text style={ui.muted}>You can't edit items.</Text>}
      </Card>

      <ProductVendors productId={product.id} vendors={vendors} onChange={vendorsChanged} canEdit={canEdit} />

      <Card title="Stock">
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
          <Field label="Change (+ / −)"><Input value={delta} onChange={setDelta} keyboard="default" placeholder="e.g. 12 or -1" /></Field>
          <View style={{ flexGrow: 2 }}>
            <Text style={ui.muted}>Reason</Text>
            <Chips options={[["RECEIVE", "Received"], ["COUNT", "Count"], ["DAMAGE", "Damaged"], ["THEFT", "Theft/loss"], ["OTHER", "Other"]]} value={reason} onChange={setReason} />
          </View>
          <Button title="Apply" onPress={adjust} disabled={can("INVENTORY_ADJUST") === "DENY" || !delta} />
        </View>
        <View style={[ui.row, { gap: 8, alignItems: "flex-end" }]}>
          <Field label="Flag as low stock at or below"><Input value={lowStock} onChange={setLowStock} keyboard="number-pad" placeholder="off" /></Field>
          <Button title="Set" kind="secondary" onPress={() => run(() => api("PUT", `/inventory/${variant.id}/low-stock`, { locationId: location.id, lowStockQty: lowStock.trim() === "" ? null : Number(lowStock) }), "Low-stock level saved")} disabled={can("INVENTORY_ADJUST") === "DENY"} />
          <Button title="Print label" kind="secondary" onPress={printLabel} />
        </View>
        {message && <Text style={ui.text}>{message}</Text>}
      </Card>

      <Card title="History">
        <Table rows={history} keyOf={(h) => h.id} columns={[{ key: "w", label: "When", render: (h) => when(h.createdAt), width: 170 }, { key: "d", label: "Change", render: (h) => (h.delta > 0 ? `+${h.delta}` : String(h.delta)), width: 70, align: "right" }, { key: "r", label: "Reason", render: (h) => `${h.reason}${h.note ? ` · ${h.note}` : ""}`, width: 240 }]} empty="No movements yet." />
      </Card>
    </ScrollView>
  );
}

function NewProduct({ onDone }: { onDone: () => void }) {
  const { location } = useSession();
  const [kind, setKind] = useState<ProductKind>("TCG_SINGLE");
  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [styleCode, setStyleCode] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [qty, setQty] = useState("");
  const [size, setSize] = useState("");
  const [condition, setCondition] = useState("NM");
  const [finish, setFinish] = useState("NONFOIL");
  const [itemCondition, setItemCondition] = useState("DS");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [vendorSku, setVendorSku] = useState("");
  const [vendorCost, setVendorCost] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Category[]>("GET", "/categories").then(setCategories).catch(() => undefined);
    api<Vendor[]>("GET", "/vendors").then((v) => setVendors(v.filter((x) => x.active))).catch(() => undefined);
  }, []);

  const card = kind === "TCG_SINGLE";
  const wear = isWear(kind);

  async function save() {
    setError(null);
    try {
      const p = await api<Product>("POST", "/catalog/products", {
        kind,
        title: title.trim(),
        brand: brand.trim() || undefined,
        styleCode: wear && styleCode.trim() ? styleCode.trim() : undefined,
        categoryId,
        channels: ["POS", "STOREFRONT"],
        variants: [
          {
            sku: sku.trim(),
            priceCents: Math.round(Number(price) * 100),
            costCents: cost.trim() ? Math.round(Number(cost) * 100) : undefined,
            ...(card ? { condition, finish } : {}),
            ...(wear ? { size: size.trim() || undefined, itemCondition } : {}),
          },
        ],
        vendors: vendorId ? [{ vendorId, vendorSku: vendorSku.trim() || undefined, costCents: vendorCost.trim() ? Math.round(Number(vendorCost) * 100) : undefined, preferred: true }] : undefined,
      });
      const n = Number(qty);
      if (Number.isInteger(n) && n > 0) await api("POST", "/inventory/adjust", { variantId: p.variants[0]!.id, locationId: location.id, delta: n, reason: "RECEIVE" });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 10 }}>
      <Text style={ui.h2}>New product</Text>
      <Text style={ui.muted}>For cards, the trade-in screen can import from Scryfall/Pokémon TCG with prices and photos; this form is for everything else.</Text>
      <Chips options={ProductKinds.filter((k) => k !== "EVENT_ENTRY").map((k) => [k, k.replace("TCG_", "").replace("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())])} value={kind} onChange={(k) => setKind(k as ProductKind)} />
      <Field label="Name"><Input value={title} onChange={setTitle} /></Field>
      <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
        <BrandInput value={brand} onChange={setBrand} />
        <Field label="SKU"><Input value={sku} onChange={setSku} /></Field>
        {wear && <Field label="Style code"><Input value={styleCode} onChange={setStyleCode} placeholder="optional" /></Field>}
      </View>
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Field label="Price ($)"><Input value={price} onChange={setPrice} keyboard="decimal-pad" /></Field>
        <Field label="Cost ($)"><Input value={cost} onChange={setCost} keyboard="decimal-pad" /></Field>
        <Field label={`Starting stock at ${location.name}`}><Input value={qty} onChange={setQty} keyboard="number-pad" /></Field>
      </View>
      {card && (
        <>
          <Text style={ui.muted}>Condition</Text>
          <Chips options={CardConditions.map((c) => [c, c])} value={condition} onChange={setCondition} />
          <Text style={ui.muted}>Finish</Text>
          <Chips options={CardFinishes.map((f) => [f, f.replace("_", " ").toLowerCase()])} value={finish} onChange={setFinish} />
        </>
      )}
      {wear && (
        <>
          <Field label="Size"><Input value={size} onChange={setSize} /></Field>
          <Text style={ui.muted}>Condition</Text>
          <Chips options={ItemConditions.map((c) => [c, c === "DS" ? "New (DS)" : c])} value={itemCondition} onChange={setItemCondition} />
        </>
      )}
      <Text style={ui.muted}>Category</Text>
      <Chips options={[["", "None"], ...categories.map((c) => [c.id, c.path] as [string, string])]} value={categoryId ?? ""} onChange={(v) => setCategoryId(v || null)} />
      {vendors.length > 0 && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Picker label="Vendor" options={vendors.map((v) => [v.id, v.name] as [string, string])} value={vendorId} onChange={setVendorId} noneLabel="None" placeholder="None" />
          {vendorId ? (
            <>
              <Field label="Vendor SKU"><Input value={vendorSku} onChange={setVendorSku} placeholder="their item #" /></Field>
              <Field label="Vendor cost ($)"><Input value={vendorCost} onChange={setVendorCost} keyboard="decimal-pad" placeholder="unknown" /></Field>
            </>
          ) : null}
        </View>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8 }]}>
        <Button title="Cancel" kind="secondary" onPress={onDone} />
        <Button title="Add product" kind="good" onPress={save} disabled={!title.trim() || !sku.trim() || !(Number(price) >= 0 && price.trim())} style={{ flex: 1 }} />
      </View>
    </ScrollView>
  );
}

export const unitLabel = (v: Variant, p: Product) => `${p.title} · ${variantLabel(v)} · ${formatCents(v.priceCents)}`;
export const dim = colors.muted;
export const m = money;
