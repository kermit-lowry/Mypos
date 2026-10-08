import { CARD_CONDITION_LABELS, CardConditions, formatCents, type CardCondition } from "@mypos/shared";
import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, type Customer, type Product, type Variant } from "../api";
import { NotPermitted, useGuard } from "../approval";
import { Button } from "../components/Button";
import { CustomerPicker } from "../components/CustomerPicker";
import { MarketBadge } from "../components/MarketBadge";
import { imageOf, variantLabel } from "../components/ProductSearch";
import { SplitPane } from "../components/SplitPane";
import { Thumb } from "../components/Thumb";
import { useCan, useSession } from "../session";
import { colors, ui } from "../theme";

interface ExternalCard {
  source: "scryfall" | "pokemontcg";
  externalId: string;
  game: string;
  title: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  imageUrl: string | null;
  finishes: string[];
  marketByFinish: Record<string, number | undefined>;
}

interface Suggestion {
  accepted: boolean;
  cashCents: number;
  creditCents: number;
  resaleCents: number;
  notes: string[];
}

interface Line {
  key: string;
  variantId?: string;
  title: string;
  detail: string;
  imageUrl: string | null;
  quantity: number;
  /** For items not in the catalog, or to override the catalog's figure. */
  resaleCents?: number;
  /** Offers the employee typed, if they changed the suggestion. */
  cashOfferCents?: number;
  creditOfferCents?: number;
  suggestion?: Suggestion;
}

const cents = (t: string) => {
  const n = Math.round(Number(t) * 100);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * Trade-in / buy counter: find what the customer brought (catalog, or card
 * databases for cards not stocked yet), see the store's suggested offer and
 * why, adjust it, and pay cash or store credit.
 */
export function BuylistScreen() {
  const { location } = useSession();
  const guard = useGuard();
  const can = useCan();
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showTicket, setShowTicket] = useState(false);

  // Suggested offers come from the server (margins, market trend, stock on hand).
  const sig = JSON.stringify(lines.map((l) => [l.variantId, l.title, l.quantity, l.resaleCents]));
  const lastSig = useRef("");
  useEffect(() => {
    if (lines.length === 0 || sig === lastSig.current) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const res = await api<{ suggestion: Suggestion }[]>("POST", "/buylist/suggest", {
          locationId: location.id,
          lines: lines.map((l) => ({ variantId: l.variantId, description: l.variantId ? undefined : l.title, quantity: l.quantity, marketCents: l.resaleCents })),
        });
        if (!live) return;
        lastSig.current = sig;
        setLines((prev) => prev.map((l, i) => ({ ...l, suggestion: res[i]?.suggestion })));
      } catch (e) {
        if (live) setMessage(e instanceof ApiError ? e.message : String(e));
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sig, location.id]);

  const addVariant = (p: Product, v: Variant) =>
    setLines((prev) =>
      prev.some((l) => l.variantId === v.id)
        ? prev.map((l) => (l.variantId === v.id && !v.serialized ? { ...l, quantity: l.quantity + 1 } : l))
        : [...prev, { key: v.id, variantId: v.id, title: p.title, detail: variantLabel(v), imageUrl: imageOf(p, v), quantity: 1 }],
    );
  const addOther = (title: string, resaleCents: number) =>
    setLines((prev) => [...prev, { key: `other-${Date.now()}`, title, detail: "Not in catalog", imageUrl: null, quantity: 1, resaleCents }]);
  const update = (key: string, patch: Partial<Line>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key));

  const offer = (l: Line) => ({ cash: l.cashOfferCents ?? l.suggestion?.cashCents ?? 0, credit: l.creditOfferCents ?? l.suggestion?.creditCents ?? 0 });
  const cashTotal = lines.reduce((a, l) => a + offer(l).cash * l.quantity, 0);
  const creditTotal = lines.reduce((a, l) => a + offer(l).credit * l.quantity, 0);
  const priced = lines.length > 0 && lines.every((l) => l.suggestion);
  const overSuggested = lines.some((l) => l.suggestion && (offer(l).cash > l.suggestion.cashCents || offer(l).credit > l.suggestion.creditCents));

  async function payout(kind: "CASH" | "STORE_CREDIT") {
    setBusy(true);
    setMessage(null);
    try {
      const body = {
        locationId: location.id,
        customerId: customer?.id,
        lines: lines.map((l) => ({
          variantId: l.variantId,
          description: l.variantId ? undefined : l.title,
          quantity: l.quantity,
          marketCents: l.resaleCents,
          cashOfferCents: l.cashOfferCents,
          creditOfferCents: l.creditOfferCents,
        })),
      };
      // Offering more than suggested needs approval; the server checks it too.
      const ticket = overSuggested
        ? await guard("BUYLIST_OVERRIDE", (t) => api<{ id: string; number: number }>("POST", "/buylist/quote", body, { approvalToken: t }))
        : await api<{ id: string; number: number }>("POST", "/buylist/quote", body);
      if (!ticket) return;
      const done = await guard(kind === "CASH" ? "BUYLIST_PAYOUT" : "BUYLIST_CREDIT", (t) =>
        api<{ paidCents: number }>("POST", `/buylist/${ticket.id}/accept`, { payout: kind, customerId: customer?.id }, { approvalToken: t }),
      );
      if (!done) return;
      setMessage(`Trade-in #${ticket.number}: paid ${formatCents(done.paidCents)} ${kind === "CASH" ? "cash" : "store credit"}${customer ? ` to ${customer.name}` : ""}`);
      setLines([]);
      setCustomer(null);
      lastSig.current = "";
    } catch (e) {
      setMessage(e instanceof ApiError || e instanceof NotPermitted ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const payLabel = (perm: "BUYLIST_PAYOUT" | "BUYLIST_CREDIT", label: string) => `${label}${can(perm) === "PIN" ? " · PIN" : ""}`;

  return (
    <SplitPane
      leftLabel="Find items"
      rightLabel={`Ticket (${lines.length})${cashTotal ? ` · ${formatCents(cashTotal)}` : ""}`}
      showRight={showTicket}
      onToggle={setShowTicket}
      left={<TradeInLookup onPickVariant={addVariant} onAddOther={addOther} onMessage={setMessage} />}
      right={
        <>
          <CustomerPicker customer={customer} onChange={setCustomer} />
          <FlatList
            style={{ flex: 1 }}
            data={lines}
            keyExtractor={(l) => l.key}
            ListEmptyComponent={<Text style={[ui.muted, { textAlign: "center", marginTop: 40 }]}>Add what the customer is selling</Text>}
            renderItem={({ item: l }) => <TicketLine line={l} offer={offer(l)} onChange={(patch) => update(l.key, patch)} onRemove={() => remove(l.key)} />}
          />
          {message && <Text style={ui.text}>{message}</Text>}
          {overSuggested && <Text style={[ui.muted, { color: colors.warn }]}>An offer is above the suggestion{can("BUYLIST_OVERRIDE") === "PIN" ? ": needs a manager's PIN" : ""}.</Text>}
          {!customer && lines.length > 0 && <Text style={ui.muted}>Attach the customer for store credit (and to keep a record of who sold what).</Text>}
          <View style={[ui.row, { gap: 8 }]}>
            {can("BUYLIST_PAYOUT") !== "DENY" && (
              <Button title={payLabel("BUYLIST_PAYOUT", `Cash ${formatCents(cashTotal)}`)} onPress={() => payout("CASH")} disabled={!priced || busy} busy={busy} style={{ flex: 1 }} />
            )}
            {can("BUYLIST_CREDIT") !== "DENY" && (
              <Button
                title={payLabel("BUYLIST_CREDIT", `Credit ${formatCents(creditTotal)}`)}
                kind="good"
                onPress={() => payout("STORE_CREDIT")}
                disabled={!priced || !customer || busy}
                busy={busy}
                style={{ flex: 1 }}
              />
            )}
          </View>
          {can("BUYLIST_PAYOUT") === "DENY" && can("BUYLIST_CREDIT") === "DENY" && <Text style={ui.muted}>You can build the ticket; a manager pays it out.</Text>}
        </>
      }
    />
  );
}

/** One item on the ticket: suggested offer with its reasons, editable amounts. */
function TicketLine({ line, offer, onChange, onRemove }: { line: Line; offer: { cash: number; credit: number }; onChange: (p: Partial<Line>) => void; onRemove: () => void }) {
  const [showWhy, setShowWhy] = useState(false);
  const s = line.suggestion;
  const edited = (field: "cash" | "credit") => (field === "cash" ? line.cashOfferCents !== undefined : line.creditOfferCents !== undefined);
  return (
    <View style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 6 }}>
      <View style={[ui.row, { gap: 10 }]}>
        <Thumb uri={line.imageUrl} title={line.title} size={40} />
        <View style={{ flex: 1 }}>
          <Text style={ui.text} numberOfLines={1}>
            {line.quantity > 1 ? `${line.quantity}× ` : ""}
            {line.title}
          </Text>
          <Text style={ui.muted}>{line.detail}</Text>
        </View>
        <Pressable onPress={onRemove} style={{ padding: 6 }}>
          <Text style={ui.muted}>✕</Text>
        </Pressable>
      </View>
      {s ? (
        s.accepted ? (
          <>
            <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
              <OfferField label="Cash" value={offer.cash} suggested={s.cashCents} edited={edited("cash")} onChange={(v) => onChange({ cashOfferCents: v })} />
              <OfferField label="Credit" value={offer.credit} suggested={s.creditCents} edited={edited("credit")} onChange={(v) => onChange({ creditOfferCents: v })} />
              <View style={{ gap: 4, minWidth: 90 }}>
                <Text style={ui.muted}>Resells $</Text>
                <TextInput
                  style={[ui.input, { paddingVertical: 6 }]}
                  keyboardType="decimal-pad"
                  defaultValue={(s.resaleCents / 100).toFixed(2)}
                  onEndEditing={(e) => onChange({ resaleCents: cents(e.nativeEvent.text), cashOfferCents: undefined, creditOfferCents: undefined })}
                />
              </View>
              <View style={{ gap: 4, width: 64 }}>
                <Text style={ui.muted}>Qty</Text>
                <TextInput
                  style={[ui.input, { paddingVertical: 6, textAlign: "center" }]}
                  keyboardType="number-pad"
                  defaultValue={String(line.quantity)}
                  onEndEditing={(e) => onChange({ quantity: Math.max(1, Math.min(999, Number(e.nativeEvent.text) || 1)) })}
                />
              </View>
            </View>
            <Pressable onPress={() => setShowWhy((x) => !x)}>
              <Text style={[ui.muted, { color: colors.link }]}>{showWhy ? "Hide" : "Why this offer?"}</Text>
            </Pressable>
            {showWhy && s.notes.map((n, i) => <Text key={i} style={ui.muted}>• {n}</Text>)}
          </>
        ) : (
          <Text style={[ui.muted, { color: colors.warn }]}>Pass: {s.notes[s.notes.length - 1]}</Text>
        )
      ) : (
        <Text style={ui.muted}>Working out an offer…</Text>
      )}
    </View>
  );
}

function OfferField({ label, value, suggested, edited, onChange }: { label: string; value: number; suggested: number; edited: boolean; onChange: (v: number | undefined) => void }) {
  const over = value > suggested;
  return (
    <View style={{ gap: 4, minWidth: 100 }}>
      <Text style={ui.muted}>
        {label}
        {edited ? ` (suggested ${formatCents(suggested)})` : ""}
      </Text>
      <TextInput
        key={suggested}
        style={[ui.input, { paddingVertical: 6, borderColor: over ? colors.warn : edited ? colors.accent : colors.border }]}
        keyboardType="decimal-pad"
        defaultValue={(value / 100).toFixed(2)}
        onEndEditing={(e) => {
          const c = cents(e.nativeEvent.text);
          onChange(c === undefined || c === suggested ? undefined : c);
        }}
      />
    </View>
  );
}

/** Catalog + outside card databases, and a way to add anything else by hand. */
function TradeInLookup({ onPickVariant, onAddOther, onMessage }: { onPickVariant: (p: Product, v: Variant) => void; onAddOther: (title: string, resaleCents: number) => void; onMessage: (m: string) => void }) {
  const { location } = useSession();
  const [q, setQ] = useState("");
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [external, setExternal] = useState<ExternalCard[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<ExternalCard | null>(null);
  const [otherTitle, setOtherTitle] = useState("");
  const [otherResale, setOtherResale] = useState("");
  const input = useRef<TextInput>(null);

  async function search() {
    if (q.trim().length < 2) return;
    setSearching(true);
    try {
      const r = await api<{ catalog: Product[]; external: ExternalCard[]; errors: string[] }>("GET", `/buylist/lookup?q=${encodeURIComponent(q.trim())}&locationId=${location.id}`);
      setCatalog(r.catalog);
      setExternal(r.external);
      setErrors(r.errors);
    } catch (e) {
      onMessage(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSearching(false);
      input.current?.focus();
    }
  }

  async function importCard(card: ExternalCard, condition: CardCondition, finish: string) {
    try {
      const r = await api<{ product: Product; variant: Variant }>("POST", "/catalog/import-card", { source: card.source, externalId: card.externalId, condition, finish });
      onPickVariant({ ...r.product, variants: [r.variant] }, r.variant);
      setAdding(null);
      // Now stocked: show it from the catalog next time.
      setExternal((x) => x.filter((c) => c.externalId !== card.externalId));
    } catch (e) {
      onMessage(e instanceof ApiError ? e.message : String(e));
    }
  }

  const rows: ({ kind: "catalog"; p: Product; v: Variant } | { kind: "external"; c: ExternalCard })[] = [
    ...catalog.flatMap((p) => p.variants.map((v) => ({ kind: "catalog" as const, p, v }))),
    ...external.map((c) => ({ kind: "external" as const, c })),
  ];

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={[ui.row, { gap: 8 }]}>
        <TextInput
          ref={input}
          style={[ui.input, { flex: 1, minWidth: 0 }]}
          placeholder="Card name, set, style code, SKU, cert #…"
          placeholderTextColor={colors.muted}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={search}
          autoFocus
          blurOnSubmit={false}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        <Button title="Find" onPress={search} busy={searching} />
      </View>
      {errors.map((e) => (
        <Text key={e} style={[ui.muted, { color: colors.warn }]}>Card database unavailable: {e}</Text>
      ))}
      <FlatList
        style={{ flex: 1 }}
        data={rows}
        keyExtractor={(r) => (r.kind === "catalog" ? r.v.id : `ext-${r.c.source}-${r.c.externalId}`)}
        ListEmptyComponent={<Text style={ui.muted}>{q ? "Nothing found. Add it below if it's not a card." : "Search your catalog and card databases."}</Text>}
        renderItem={({ item: r }) => {
          if (r.kind === "catalog") {
            const onHand = r.v.inventory?.find((i) => i.locationId === location.id)?.onHand ?? 0;
            return (
              <Pressable onPress={() => onPickVariant(r.p, r.v)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.panelAlt }]}>
                <Thumb uri={imageOf(r.p, r.v)} title={r.p.title} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={ui.text} numberOfLines={1}>
                    {r.p.title}
                  </Text>
                  <Text style={ui.muted}>{[r.p.setName, r.p.brand, variantLabel(r.v)].filter(Boolean).join(" · ")}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={ui.text}>Sells {formatCents(r.v.priceCents)}</Text>
                  <MarketBadge market={r.v.market} />
                  <Text style={ui.muted}>{onHand} in stock</Text>
                </View>
              </Pressable>
            );
          }
          const c = r.c;
          const nm = c.marketByFinish[c.finishes[0] ?? "NONFOIL"];
          return (
            <Pressable onPress={() => setAdding(adding?.externalId === c.externalId ? null : c)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.panelAlt }]}>
              <Thumb uri={c.imageUrl} title={c.title} size={36} />
              <View style={{ flex: 1 }}>
                <Text style={ui.text} numberOfLines={1}>
                  {c.title}
                </Text>
                <Text style={ui.muted}>
                  {c.setName} #{c.collectorNumber} · not stocked yet ({c.source === "scryfall" ? "Scryfall" : "Pokémon TCG"})
                </Text>
                {adding?.externalId === c.externalId && (
                  <View style={{ gap: 6, marginTop: 6 }}>
                    <Text style={ui.muted}>Add as:</Text>
                    {c.finishes.map((f) => (
                      <View key={f} style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
                        {c.finishes.length > 1 && <Text style={[ui.muted, { width: 90 }]}>{f.replace("_", " ")}</Text>}
                        {CardConditions.map((cond) => (
                          <Pressable key={cond} onPress={() => importCard(c, cond, f)} style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 14, backgroundColor: colors.panelAlt }}>
                            <Text style={ui.text}>{cond}</Text>
                          </Pressable>
                        ))}
                      </View>
                    ))}
                    <Text style={ui.muted}>{CardConditions.map((k) => `${k} = ${CARD_CONDITION_LABELS[k]}`).join(" · ")}</Text>
                  </View>
                )}
              </View>
              <View style={{ alignItems: "flex-end" }}>{nm !== undefined && <Text style={ui.text}>Market {formatCents(nm)}</Text>}</View>
            </Pressable>
          );
        }}
      />
      <ScrollView horizontal={false} style={{ flexGrow: 0 }}>
        <Text style={ui.muted}>Something else (shoes, apparel, anything not in the catalog):</Text>
        <View style={[ui.row, { gap: 8, marginTop: 6 }]}>
          <TextInput style={[ui.input, { flex: 2, minWidth: 0 }]} placeholder="Describe it" placeholderTextColor={colors.muted} value={otherTitle} onChangeText={setOtherTitle} />
          <TextInput style={[ui.input, { flex: 1, minWidth: 0 }]} placeholder="Resells for $" placeholderTextColor={colors.muted} keyboardType="decimal-pad" value={otherResale} onChangeText={setOtherResale} />
          <Button
            title="Add"
            kind="secondary"
            disabled={!otherTitle.trim() || !(cents(otherResale) ?? 0)}
            onPress={() => {
              onAddOther(otherTitle.trim(), cents(otherResale)!);
              setOtherTitle("");
              setOtherResale("");
            }}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = { row: { flexDirection: "row" as const, gap: 10, alignItems: "center" as const, paddingVertical: 10, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: colors.border } };
