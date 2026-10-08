import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { api, type Location, type Product, type Variant, type Vendor } from "../../../api";
import { useGuard } from "../../../approval";
import { Button } from "../../../components/Button";
import { imageOf, ProductSearch, variantLabel } from "../../../components/ProductSearch";
import { Thumb } from "../../../components/Thumb";
import { useLayout } from "../../../layout";
import { useCan } from "../../../session";
import { colors, ui } from "../../../theme";
import { Card, day, Field, Input, isoDay, money, openDocument, Picker, when } from "../../ui";
import { CellInput, dollars, fromServer, type Po, type PoLine, qtyOf, ReadField, small, StatusBadge, subtotalOf, toCents, toInt, type VendorItem } from "./common";

interface ReorderRow {
  variantId: string;
  sku: string;
  title: string;
  suggestedQty: number;
  lastCostCents: number | null;
  vendorId: string | null;
  vendor: string | null;
  vendors: { vendorId: string; name: string; vendorSku: string | null; costCents: number | null; preferred: boolean }[];
}
/** What's being received right now, per line: quantity and the invoice price. */
interface Receiving {
  reference: string;
  lines: Record<string, { qty: string; cost: string }>;
}
interface Msg {
  text: string;
  error?: boolean;
}

const remaining = (l: PoLine) => l.quantity - l.receivedQty;
const lineStyle = [ui.row, { gap: 8, flexWrap: "wrap" as const, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }];

/** Build, order and receive one purchase order. */
export function PoEditor({ initial, vendors, locations, onDone }: { initial: Po; vendors: Vendor[]; locations: Location[]; onDone: () => void }) {
  const can = useCan();
  const guard = useGuard();
  const { narrow } = useLayout();
  const [po, setPo] = useState<Po>(initial);
  // Line boxes commit on blur, which can land in the same tick as a button press.
  const poRef = useRef(po);
  poRef.current = po;
  const [loading, setLoading] = useState(!!initial.id);
  const [expected, setExpected] = useState(isoDay(initial.expectedAt));
  const [shipping, setShipping] = useState(initial.shippingCents ? dollars(initial.shippingCents) : "");
  const [adding, setAdding] = useState(false);
  const [onlyVendor, setOnlyVendor] = useState(false);
  const [vendorItems, setVendorItems] = useState<Map<string, { vendorSku: string | null; costCents: number | null }>>(new Map());
  const [receiving, setReceiving] = useState<Receiving | null>(null);
  const [openReceipt, setOpenReceipt] = useState<string | null>(null);
  const [message, setMessage] = useState<Msg | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const canManage = can("MANAGE_PURCHASING") !== "DENY";
  const canReceive = can("RECEIVE_STOCK") !== "DENY";
  const draft = po.status === "DRAFT";
  const receivable = po.status === "ORDERED" || po.status === "PARTIAL";
  /** Vendor, location and lines change on drafts only. */
  const editable = draft && canManage;
  /** Reference, dates, shipping and notes can change until it's received. */
  const headerEditable = (draft || receivable) && canManage;
  const vendor = vendors.find((v) => v.id === po.vendorId) ?? po.vendor;
  const locationName = locations.find((l) => l.id === po.locationId)?.name ?? po.location?.name ?? "";
  const vendorOptions = vendors.filter((v) => v.active || v.id === po.vendorId).map((v): [string, string] => [v.id, v.name]);
  const skuOf = (l: PoLine) => l.vendorSku ?? vendorItems.get(l.variantId)?.vendorSku ?? null;
  const shippingCents = headerEditable ? toCents(shipping) : (po.shippingCents ?? 0);
  const subtotal = subtotalOf(po.lines);
  const receipts = [...(po.receipts ?? [])].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

  const fail = useCallback((e: unknown) => setMessage({ text: e instanceof Error ? e.message : String(e), error: true }), []);
  /** Run an action; a returned string is shown as confirmation. */
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

  // The list carries bare lines; the full order has titles, photos and deliveries.
  useEffect(() => {
    if (!initial.id) return;
    api("GET", `/purchase-orders/${initial.id}`)
      .then((full) => setPo((p) => ({ ...fromServer(full), receipts: full.receipts ?? p.receipts ?? [] })))
      .catch(fail)
      .finally(() => setLoading(false));
  }, [initial.id, fail]);

  // What this vendor supplies: their item numbers and prices for the lines.
  useEffect(() => {
    if (!po.vendorId) return;
    let live = true;
    api<VendorItem[]>("GET", `/vendors/${po.vendorId}/products`)
      .then((rows) => {
        if (!live) return;
        const m = new Map<string, { vendorSku: string | null; costCents: number | null }>();
        for (const r of rows) for (const v of r.product.variants) m.set(v.id, { vendorSku: r.vendorSku, costCents: r.costCents });
        setVendorItems(m);
        setOnlyVendor(rows.length > 0);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [po.vendorId]);

  const expectedAtOf = () => {
    const t = expected.trim();
    if (!t) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(new Date(`${t}T00:00:00`).getTime())) throw new Error("Expected date must be YYYY-MM-DD");
    return `${t}T00:00:00`;
  };
  const headerFields = () => {
    const p = poRef.current;
    return { reference: p.reference?.trim() ?? "", notes: p.notes?.trim() ?? "", expectedAt: expectedAtOf(), shippingCents: toCents(shipping) };
  };
  const body = () => {
    const p = poRef.current;
    return { vendorId: p.vendorId, locationId: p.locationId, ...headerFields(), lines: p.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitCostCents: l.unitCostCents })) };
  };
  const apply = (saved: any): Po => {
    const next = fromServer(saved);
    setPo(next);
    return next;
  };
  const save = async (): Promise<Po> => {
    const p = poRef.current;
    if (!p.vendorId) throw new Error("Choose a vendor");
    if (!p.locationId) throw new Error("Choose a location");
    return apply(p.id ? await api("PUT", `/purchase-orders/${p.id}`, draft ? body() : headerFields()) : await api("POST", "/purchase-orders", body()));
  };

  const setLine = (variantId: string, patch: Partial<PoLine>) => setPo((x) => ({ ...x, lines: x.lines.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)) }));
  const removeLine = (variantId: string) => setPo((x) => ({ ...x, lines: x.lines.filter((l) => l.variantId !== variantId) }));
  /** Scanning an item already on the order adds one more. */
  const addLine = (p: Product, v: Variant) => {
    const link = p.vendors?.find((x) => x.vendorId === poRef.current.vendorId);
    const known = vendorItems.get(v.id);
    setPo((x) => {
      if (x.lines.some((l) => l.variantId === v.id)) return { ...x, lines: x.lines.map((l) => (l.variantId === v.id ? { ...l, quantity: l.quantity + 1 } : l)) };
      const line: PoLine = {
        variantId: v.id,
        title: p.title,
        detail: variantLabel(v),
        sku: v.sku,
        vendorSku: link?.vendorSku ?? known?.vendorSku ?? null,
        imageUrl: imageOf(p, v),
        quantity: 1,
        receivedQty: 0,
        unitCostCents: link?.costCents ?? known?.costCents ?? v.costCents ?? 0,
      };
      return { ...x, lines: [...x.lines, line] };
    });
  };
  const suggest = () =>
    run("suggest", async () => {
      const p = poRef.current;
      const rows = await api<ReorderRow[]>("GET", `/purchase-orders/reorder?locationId=${p.locationId}&vendorId=${p.vendorId}`);
      const fresh = rows.filter((r) => (r.vendorId === p.vendorId || !r.vendorId) && !p.lines.some((l) => l.variantId === r.variantId));
      if (fresh.length === 0) return rows.length ? "Everything below its low-stock level is already on this order." : "Nothing is below its low-stock level.";
      const lines = fresh.map(
        (r): PoLine => ({
          variantId: r.variantId,
          title: r.title,
          detail: "",
          sku: r.sku,
          vendorSku: r.vendors.find((v) => v.vendorId === p.vendorId)?.vendorSku ?? null,
          quantity: r.suggestedQty,
          receivedQty: 0,
          unitCostCents: r.lastCostCents ?? 0,
        }),
      );
      setPo((x) => ({ ...x, lines: [...x.lines, ...lines] }));
      return `Added ${lines.length} suggested item${lines.length === 1 ? "" : "s"}`;
    });

  const startReceiving = () => setReceiving({ reference: "", lines: Object.fromEntries(po.lines.filter((l) => remaining(l) > 0).map((l) => [l.variantId, { qty: String(remaining(l)), cost: dollars(l.unitCostCents) }])) });
  const receiveAll = () => setReceiving((r) => r && { ...r, lines: Object.fromEntries(po.lines.filter((l) => remaining(l) > 0).map((l) => [l.variantId, { qty: String(remaining(l)), cost: r.lines[l.variantId]?.cost ?? dollars(l.unitCostCents) }])) });
  const setReceiveLine = (variantId: string, patch: Partial<{ qty: string; cost: string }>) => setReceiving((r) => r && { ...r, lines: { ...r.lines, [variantId]: { ...(r.lines[variantId] ?? { qty: "", cost: "" }), ...patch } } });
  const confirmReceive = () =>
    run("receive", async () => {
      const r = receiving;
      if (!r || !po.id) return;
      const lines = Object.entries(r.lines)
        .map(([variantId, x]) => ({ variantId, quantity: toInt(x.qty), unitCostCents: x.cost.trim() === "" ? undefined : toCents(x.cost) }))
        .filter((l) => l.quantity > 0);
      if (lines.length === 0) throw new Error("Enter a quantity for at least one item");
      const result = await guard("RECEIVE_STOCK", (token) => api("POST", `/purchase-orders/${po.id}/receive`, { reference: r.reference.trim() || undefined, lines }, { approvalToken: token }));
      if (!result) return;
      apply(result);
      setReceiving(null);
      return "Delivery received";
    });

  if (adding) {
    return (
      <View style={{ flex: 1, padding: 12, gap: 8 }}>
        <View style={[ui.row, { gap: 12, flexWrap: "wrap", justifyContent: "space-between" }]}>
          <Button title="Done adding" onPress={() => setAdding(false)} />
          <View style={[ui.row, { gap: 8 }]}>
            <Text style={ui.muted}>Only {vendor?.name ?? "this vendor"}'s items</Text>
            <Switch value={onlyVendor} onValueChange={setOnlyVendor} />
          </View>
          <Text style={ui.muted}>
            {po.lines.length} item{po.lines.length === 1 ? "" : "s"} on the order
          </Text>
        </View>
        <ProductSearch onPick={addLine} extraQuery={onlyVendor && po.vendorId ? `vendorId=${po.vendorId}` : undefined} placeholder={onlyVendor && vendor ? `Search ${vendor.name} items…` : undefined} />
      </View>
    );
  }

  const lineOf = (variantId: string) => po.lines.find((l) => l.variantId === variantId);
  const fullyReceived = po.lines.filter((l) => remaining(l) <= 0).length;

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card
        title={po.number ? `Purchase order #${po.number}` : "New purchase order"}
        right={
          <View style={[ui.row, { gap: 8 }]}>
            {!narrow && <StatusBadge status={po.status} />}
            <Button title="Back" kind="secondary" onPress={onDone} style={small} />
          </View>
        }
      >
        {narrow && <StatusBadge status={po.status} />}
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          {editable ? <Picker label="Vendor" options={vendorOptions} value={po.vendorId} onChange={(vendorId) => setPo((x) => ({ ...x, vendorId }))} allowNone={false} placeholder="Choose a vendor" /> : <ReadField label="Vendor" value={vendor?.name} />}
          {editable ? <Picker label="Deliver to" options={locations.map((l): [string, string] => [l.id, l.name])} value={po.locationId} onChange={(locationId) => setPo((x) => ({ ...x, locationId }))} allowNone={false} placeholder="Choose a location" /> : <ReadField label="Deliver to" value={locationName} />}
        </View>
        {editable && vendorOptions.length === 0 && <Text style={[ui.muted, { color: colors.warn }]}>Add a vendor first (Vendors tab).</Text>}
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          {headerEditable ? (
            <Field label="Vendor reference / invoice #">
              <Input value={po.reference ?? ""} onChange={(reference) => setPo((x) => ({ ...x, reference }))} />
            </Field>
          ) : (
            <ReadField label="Reference" value={po.reference} />
          )}
          {headerEditable ? (
            <Field label="Expected (YYYY-MM-DD)">
              <Input value={expected} onChange={setExpected} placeholder="YYYY-MM-DD" />
            </Field>
          ) : (
            <ReadField label="Expected" value={po.expectedAt ? day(po.expectedAt) : ""} />
          )}
          {headerEditable ? (
            <Field label="Shipping ($)">
              <Input value={shipping} onChange={setShipping} keyboard="decimal-pad" placeholder="0.00" />
            </Field>
          ) : (
            <ReadField label="Shipping" value={money(po.shippingCents ?? 0)} />
          )}
        </View>
        {headerEditable ? (
          <Field label="Notes">
            <Input value={po.notes ?? ""} onChange={(notes) => setPo((x) => ({ ...x, notes }))} multiline />
          </Field>
        ) : po.notes ? (
          <ReadField label="Notes" value={po.notes} />
        ) : null}
        {po.createdAt && <Text style={ui.muted}>{[`Created ${when(po.createdAt)}`, po.orderedAt && `ordered ${when(po.orderedAt)}`, po.receivedAt && `received ${when(po.receivedAt)}`].filter(Boolean).join(" · ")}</Text>}
      </Card>

      {receiving ? (
        <Card title="Receive delivery" right={<Button title={narrow ? "Receive all" : "Receive all remaining"} kind="secondary" style={small} onPress={receiveAll} />}>
          <Field label="Delivery reference (packing slip / invoice #)">
            <Input value={receiving.reference} onChange={(reference) => setReceiving({ ...receiving, reference })} />
          </Field>
          {po.lines
            .filter((l) => remaining(l) > 0)
            .map((l) => {
              const r = receiving.lines[l.variantId] ?? { qty: "", cost: "" };
              return (
                <View key={l.variantId} style={lineStyle}>
                  <LineTitle line={l} vendorSku={skuOf(l)} />
                  <Text style={ui.muted}>
                    ordered {l.quantity} · received {l.receivedQty}
                  </Text>
                  <Text style={[ui.muted, { color: colors.good }]}>Receive now</Text>
                  <TextInput style={[ui.input, { width: 70, paddingVertical: 6, paddingHorizontal: 10, borderColor: colors.good }]} keyboardType="number-pad" value={r.qty} onChangeText={(qty) => setReceiveLine(l.variantId, { qty })} />
                  <Text style={ui.muted}>@ $</Text>
                  <TextInput style={[ui.input, { width: 90, paddingVertical: 6, paddingHorizontal: 10 }]} keyboardType="decimal-pad" value={r.cost} onChangeText={(cost) => setReceiveLine(l.variantId, { cost })} placeholder={dollars(l.unitCostCents)} placeholderTextColor={colors.muted} />
                  <Text style={ui.muted}>= {money(toInt(r.qty) * (r.cost.trim() === "" ? l.unitCostCents : toCents(r.cost)))}</Text>
                </View>
              );
            })}
          {fullyReceived > 0 && (
            <Text style={ui.muted}>
              {fullyReceived} item{fullyReceived === 1 ? " is" : "s are"} already fully received.
            </Text>
          )}
          <Text style={ui.muted}>Unit cost is what the invoice says for this delivery; leave it as the PO price if it matches.</Text>
          {message && <Text style={message.error ? ui.error : [ui.text, { color: colors.good }]}>{message.text}</Text>}
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button title="Confirm" kind="good" busy={busy === "receive"} onPress={confirmReceive} />
            <Button title="Back" kind="secondary" onPress={() => setReceiving(null)} />
          </View>
        </Card>
      ) : (
        <Card
          title={`Items · ${po.lines.length}`}
          right={
            editable ? (
              <View style={[ui.row, { gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }]}>
                <Button title="Suggest reorders" kind="secondary" style={small} busy={busy === "suggest"} disabled={!po.vendorId || !po.locationId} onPress={suggest} />
                <Button title="+ Add items" style={small} onPress={() => setAdding(true)} />
              </View>
            ) : undefined
          }
        >
          {loading ? (
            <Text style={ui.muted}>Loading…</Text>
          ) : po.lines.length === 0 ? (
            <Text style={ui.muted}>No items yet.</Text>
          ) : (
            po.lines.map((l) => (
              <View key={l.variantId} style={lineStyle}>
                <LineTitle line={l} vendorSku={skuOf(l)} />
                <Text style={ui.muted}>Qty</Text>
                {editable ? <CellInput value={String(l.quantity)} keyboard="number-pad" width={70} onCommit={(t) => setLine(l.variantId, { quantity: toInt(t, 1) })} /> : <Text style={ui.text}>{l.quantity}</Text>}
                <Text style={ui.muted}>@ $</Text>
                {editable ? <CellInput value={dollars(l.unitCostCents)} keyboard="decimal-pad" width={90} onCommit={(t) => setLine(l.variantId, { unitCostCents: toCents(t) })} /> : <Text style={ui.text}>{dollars(l.unitCostCents)}</Text>}
                <Text style={[ui.text, { minWidth: 80, textAlign: "right" }]}>{money(l.quantity * l.unitCostCents)}</Text>
                {!draft && (
                  <Text style={[ui.muted, remaining(l) <= 0 && { color: colors.good }]}>
                    received {l.receivedQty}/{l.quantity}
                  </Text>
                )}
                {editable && <Button title="✕" kind="secondary" style={{ minHeight: 32, paddingVertical: 4, paddingHorizontal: 10 }} onPress={() => removeLine(l.variantId)} />}
              </View>
            ))
          )}
          <View style={{ alignItems: "flex-end", gap: 2 }}>
            <Text style={ui.muted}>
              {qtyOf(po.lines)} units · subtotal {money(subtotal)}
            </Text>
            <Text style={ui.muted}>Shipping {money(shippingCents)}</Text>
            <Text style={ui.h2}>Total {money(subtotal + shippingCents)}</Text>
          </View>
        </Card>
      )}

      {po.id && (
        <Card title={`Deliveries · ${receipts.length}`}>
          {receipts.length === 0 && <Text style={ui.muted}>Nothing received yet.</Text>}
          {receipts.length > 0 && !narrow && (
            <View style={[ui.row, { gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 6 }]}>
              <Text style={[ui.muted, { width: 170, fontWeight: "600" }]}>Date</Text>
              <Text style={[ui.muted, { width: 160, fontWeight: "600" }]}>Reference</Text>
              <Text style={[ui.muted, { fontWeight: "600" }]}>Items · qty · cost</Text>
            </View>
          )}
          {receipts.map((r) => {
            const open = openReceipt === r.id;
            return (
              <View key={r.id} style={{ borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 8, gap: 6 }}>
                <Pressable onPress={() => setOpenReceipt(open ? null : r.id)} disabled={!r.lines} style={[ui.row, { gap: 12, flexWrap: "wrap" }]}>
                  <Text style={[ui.text, !narrow && { width: 170 }]}>{when(r.receivedAt)}</Text>
                  <Text style={[ui.muted, !narrow && { width: 160 }]}>{r.reference || "no reference"}</Text>
                  {r.lines && (
                    <Text style={ui.muted}>
                      {r.lines.length} item{r.lines.length === 1 ? "" : "s"} · {qtyOf(r.lines)} units · {money(subtotalOf(r.lines))} {open ? "▾" : "▸"}
                    </Text>
                  )}
                </Pressable>
                {open &&
                  r.lines?.map((x) => {
                    const l = lineOf(x.variantId);
                    return (
                      <View key={x.variantId} style={[ui.row, { gap: 8, paddingLeft: 12, flexWrap: "wrap" }]}>
                        <Text style={[ui.text, { flex: 1, minWidth: 160 }]}>{l ? [l.title, l.detail].filter(Boolean).join(" · ") : x.variantId}</Text>
                        <Text style={ui.muted}>
                          {x.quantity} × {money(x.unitCostCents)} = {money(x.quantity * x.unitCostCents)}
                        </Text>
                      </View>
                    );
                  })}
              </View>
            );
          })}
        </Card>
      )}

      {!receiving && message && <Text style={message.error ? ui.error : [ui.text, { color: colors.good }]}>{message.text}</Text>}
      {!receiving && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          {editable && (
            <Button
              title="Save draft"
              kind="secondary"
              busy={busy === "save"}
              disabled={!po.vendorId}
              onPress={() =>
                run("save", async () => {
                  await save();
                  return "Draft saved";
                })
              }
            />
          )}
          {editable && (
            <Button
              title="Mark as ordered"
              kind="good"
              busy={busy === "order"}
              disabled={!po.vendorId || po.lines.length === 0}
              onPress={() =>
                run("order", async () => {
                  const s = await save();
                  apply(await api("POST", `/purchase-orders/${s.id}/order`));
                  return `PO #${s.number} marked as ordered`;
                })
              }
            />
          )}
          {editable && po.id && (
            <Button
              title="Cancel order"
              kind="danger"
              busy={busy === "cancel"}
              onPress={() =>
                run("cancel", async () => {
                  apply(await api("POST", `/purchase-orders/${po.id}/cancel`));
                  return "Order cancelled";
                })
              }
            />
          )}
          {receivable && canManage && (
            <Button
              title="Save changes"
              kind="secondary"
              busy={busy === "save"}
              onPress={() =>
                run("save", async () => {
                  await save();
                  return "Saved";
                })
              }
            />
          )}
          {receivable && canReceive && <Button title="Receive delivery" kind="good" onPress={startReceiving} />}
          {po.id && (
            <Button
              title="Print"
              kind="secondary"
              busy={busy === "print"}
              onPress={() =>
                run("print", async () => {
                  // A draft prints what's on screen, so it's saved first.
                  const id = editable ? (await save()).id : po.id;
                  await openDocument(`/purchase-orders/${id}/print`);
                })
              }
            />
          )}
        </View>
      )}
    </ScrollView>
  );
}

function LineTitle({ line, vendorSku }: { line: PoLine; vendorSku?: string | null }) {
  return (
    <View style={[ui.row, { gap: 8, flex: 1, minWidth: 180 }]}>
      <Thumb uri={line.imageUrl} title={line.title} size={28} />
      <View style={{ flex: 1 }}>
        <Text style={ui.text} numberOfLines={2}>
          {line.title}
        </Text>
        <Text style={ui.muted}>{[line.detail, line.sku && `SKU ${line.sku}`, vendorSku && `Vendor # ${vendorSku}`].filter(Boolean).join(" · ")}</Text>
      </View>
    </View>
  );
}
