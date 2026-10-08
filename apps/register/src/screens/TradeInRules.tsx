import { DEFAULT_BUYLIST_POLICY, ProductKinds, type ProductKind } from "@mypos/shared";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { api, ApiError } from "../api";
import { Button } from "../components/Button";
import { colors, ui } from "../theme";

interface Rule {
  kind: ProductKind | null;
  categoryId: string | null;
  cashMarginBps: number;
  creditBonusBps: number;
  trendWeightBps: number;
  maxTrendUpBps: number;
  overstockQty: number | null;
  overstockCutBps: number;
  minResaleCents: number;
}

const KIND_LABELS: Record<ProductKind, string> = {
  TCG_SINGLE: "Card singles",
  TCG_SEALED: "Sealed product",
  SNEAKER: "Sneakers",
  APPAREL: "Apparel",
  COLLECTIBLE: "Collectibles",
  ACCESSORY: "Accessories",
  EVENT_ENTRY: "Event entries",
};

const fresh = (kind: ProductKind | null, categoryId: string | null): Rule => ({ kind, categoryId, ...DEFAULT_BUYLIST_POLICY });

/** Owner: what the store wants to make on resale, and how market trends change offers. */
export function TradeInRules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [categories, setCategories] = useState<{ id: string; path: string }[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<Rule[]>("GET", "/buylist/policies");
    setRules(r.length ? r : [fresh(null, null)]);
    setCategories(await api<{ id: string; path: string }[]>("GET", "/categories"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const name = (r: Rule) => (r.categoryId ? (categories.find((c) => c.id === r.categoryId)?.path ?? "Category") : r.kind ? KIND_LABELS[r.kind] : "Store default (everything else)");
  const set = (i: number, patch: Partial<Rule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const unusedKinds = ProductKinds.filter((k) => k !== "EVENT_ENTRY" && !rules.some((r) => r.kind === k && !r.categoryId));
  const unusedCategories = categories.filter((c) => !rules.some((r) => r.categoryId === c.id));

  async function save() {
    try {
      await api("PUT", "/buylist/policies", rules);
      setMessage("Saved. New trade-in suggestions use these rules right away.");
      load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <View style={[ui.panel, { gap: 12 }]}>
      <Text style={ui.h1}>Trade-in offers</Text>
      <Text style={ui.muted}>
        Offers work back from what you'll resell an item for. Set the margin you want to keep, how much more store credit is worth than cash, and how much
        a rising or falling market should move the offer. A rule for a category beats one for a product type, which beats the store default.
      </Text>
      {rules.map((r, i) => (
        <View key={`${r.kind}-${r.categoryId}`} style={{ gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}>
          <View style={[ui.row, { justifyContent: "space-between" }]}>
            <Text style={ui.h2}>{name(r)}</Text>
            {(r.kind || r.categoryId) && (
              <Pressable onPress={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
                <Text style={[ui.muted, { color: colors.bad }]}>Remove</Text>
              </Pressable>
            )}
          </View>
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            <Pct label="Margin to keep on resale (cash)" value={r.cashMarginBps} onChange={(v) => set(i, { cashMarginBps: v })} hint={`pay ${(100 - r.cashMarginBps / 100).toFixed(0)}% of resale`} />
            <Pct label="Store credit pays this much more" value={r.creditBonusBps} onChange={(v) => set(i, { creditBonusBps: v })} />
            <Pct label="Follow the 7-day market move by" value={r.trendWeightBps} onChange={(v) => set(i, { trendWeightBps: v })} hint="100% = the full move, 0 = ignore trends" />
            <Pct label="Most a rising market can add" value={r.maxTrendUpBps} onChange={(v) => set(i, { maxTrendUpBps: v })} />
            <Num label="Offer less once this many are in stock" value={r.overstockQty ?? ""} onChange={(t) => set(i, { overstockQty: t ? Math.max(1, Number(t) || 1) : null })} placeholder="off" />
            <Pct label="...by" value={r.overstockCutBps} onChange={(v) => set(i, { overstockCutBps: v })} />
            <Num label="Don't buy below (resale $)" value={(r.minResaleCents / 100).toFixed(2)} onChange={(t) => set(i, { minResaleCents: Math.max(0, Math.round(Number(t) * 100) || 0) })} />
          </View>
        </View>
      ))}
      {(unusedKinds.length > 0 || unusedCategories.length > 0) && (
        <View style={{ gap: 6 }}>
          <Text style={ui.muted}>Add a rule for:</Text>
          <View style={[ui.row, { flexWrap: "wrap", gap: 6 }]}>
            {unusedKinds.map((k) => (
              <Pressable key={k} onPress={() => setRules((rs) => [...rs, fresh(k, null)])} style={styles.chip}>
                <Text style={ui.text}>{KIND_LABELS[k]}</Text>
              </Pressable>
            ))}
            {unusedCategories.map((c) => (
              <Pressable key={c.id} onPress={() => setRules((rs) => [...rs, fresh(null, c.id)])} style={styles.chip}>
                <Text style={ui.text}>{c.path}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {message && <Text style={ui.text}>{message}</Text>}
      <Button title="Save trade-in rules" kind="good" onPress={save} />
    </View>
  );
}

function Pct({ label, value, onChange, hint }: { label: string; value: number; onChange: (bps: number) => void; hint?: string }) {
  return (
    <View style={{ gap: 4, minWidth: 150, flexGrow: 1 }}>
      <Text style={ui.muted}>{label}</Text>
      <View style={[ui.row, { gap: 6 }]}>
        <TextInput
          style={[ui.input, { width: 90 }]}
          keyboardType="decimal-pad"
          defaultValue={String(value / 100)}
          onEndEditing={(e) => onChange(Math.max(0, Math.min(10_000, Math.round(Number(e.nativeEvent.text) * 100) || 0)))}
        />
        <Text style={ui.muted}>%{hint ? ` · ${hint}` : ""}</Text>
      </View>
    </View>
  );
}

function Num({ label, value, onChange, placeholder }: { label: string; value: string | number; onChange: (t: string) => void; placeholder?: string }) {
  return (
    <View style={{ gap: 4, minWidth: 150, flexGrow: 1 }}>
      <Text style={ui.muted}>{label}</Text>
      <TextInput style={[ui.input, { width: 120 }]} keyboardType="decimal-pad" defaultValue={String(value)} placeholder={placeholder} placeholderTextColor={colors.muted} onEndEditing={(e) => onChange(e.nativeEvent.text.trim())} />
    </View>
  );
}

const styles = { chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.panelAlt } };
