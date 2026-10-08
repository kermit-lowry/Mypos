import { cartTotals, formatCents, type TenderInput } from "@mypos/shared";
import * as Crypto from "expo-crypto";
import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, type Customer, type LoyaltyProgram, type LoyaltyQuote, type Product, type Variant } from "../api";
import { Button } from "../components/Button";
import { CustomerPicker } from "../components/CustomerPicker";
import { ProductSearch, variantLabel } from "../components/ProductSearch";
import { RewardsPicker } from "../components/RewardsPicker";
import { isManager, useSession } from "../session";
import { colors, ui } from "../theme";

interface Line {
  product: Product;
  variant: Variant;
  quantity: number;
  discountCents: number;
}

/** Card-present terminal id for this register; empty uses the dev mock token. */
const TERMINAL_ID = process.env.EXPO_PUBLIC_TERMINAL_ID ?? "";

export function SellScreen() {
  const { location, staff } = useSession();
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [tendering, setTendering] = useState(false);
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [rewardIds, setRewardIds] = useState<string[]>([]);
  const [pickingRewards, setPickingRewards] = useState(false);
  const [quote, setQuote] = useState<LoyaltyQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  useEffect(() => {
    api<LoyaltyProgram>("GET", "/loyalty/program").then(setProgram).catch(() => setProgram(null));
  }, []);

  const localTotals = useMemo(
    () =>
      cartTotals(
        lines.map((l) => ({ unitPriceCents: l.variant.priceCents, quantity: l.quantity, discountCents: l.discountCents, taxable: l.variant.taxable })),
        location.taxRateBps,
      ),
    [lines, location.taxRateBps],
  );

  // With a customer attached, the server prices rewards and previews what the sale earns.
  const loyaltyOn = !!program?.enabled && !!customer;
  useEffect(() => {
    if (!loyaltyOn || lines.length === 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let live = true;
    api<LoyaltyQuote>("POST", "/loyalty/quote", {
      locationId: location.id,
      customerId: customer!.id,
      lines: lines.map((l) => ({ variantId: l.variant.id, quantity: l.quantity, discountCents: l.discountCents })),
      rewardIds,
    })
      .then((q) => live && (setQuote(q), setQuoteError(null)))
      .catch((e) => live && (setQuote(null), setQuoteError(e instanceof ApiError ? e.message : String(e))));
    return () => {
      live = false;
    };
  }, [loyaltyOn, lines, rewardIds, customer, location.id]);

  const totals = quote ?? localTotals;
  const quoteReady = rewardIds.length === 0 || (!!quote && !quoteError);

  function add(product: Product, variant: Variant) {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.variant.id === variant.id);
      if (i >= 0 && !variant.serialized) return prev.map((l, j) => (j === i ? { ...l, quantity: l.quantity + 1 } : l));
      if (i >= 0) return prev;
      return [...prev, { product, variant, quantity: 1, discountCents: 0 }];
    });
  }

  const setQty = (id: string, q: number) =>
    setLines((prev) => (q <= 0 ? prev.filter((l) => l.variant.id !== id) : prev.map((l) => (l.variant.id === id ? { ...l, quantity: q } : l))));

  function discount(line: Line) {
    Alert.prompt?.(
      "Line discount",
      `Dollars off ${line.product.title}`,
      (v) => {
        const cents = Math.round(Number(v) * 100);
        if (Number.isFinite(cents) && cents >= 0) setLines((prev) => prev.map((l) => (l === line ? { ...l, discountCents: cents } : l)));
      },
      "plain-text",
      "",
      "decimal-pad",
    );
  }

  function reset() {
    setLines([]);
    setCustomer(null);
    setRewardIds([]);
    setTendering(false);
  }

  return (
    <View style={{ flex: 1, flexDirection: "row", gap: 16, padding: 16 }}>
      <View style={[ui.panel, { flex: 3 }]}>
        <ProductSearch onPick={add} />
      </View>

      <View style={[ui.panel, { flex: 2, gap: 12 }]}>
        <CustomerPicker
          customer={customer}
          onChange={(c) => {
            setCustomer(c);
            setRewardIds([]);
          }}
        />
        {loyaltyOn && program!.type === "POINTS" && (
          <Button
            title={rewardIds.length ? `${rewardIds.length} reward(s) applied` : "Redeem points"}
            kind="secondary"
            onPress={() => setPickingRewards(true)}
          />
        )}
        <FlatList
          style={{ flex: 1 }}
          data={lines}
          keyExtractor={(l) => l.variant.id}
          ListEmptyComponent={<Text style={[ui.muted, { textAlign: "center", marginTop: 40 }]}>Scan or search to add items</Text>}
          renderItem={({ item: l }) => (
            <View style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <View style={[ui.row, { justifyContent: "space-between" }]}>
                <Text style={[ui.text, { flex: 1 }]} numberOfLines={1}>
                  {l.product.title}
                </Text>
                <Text style={ui.text}>{formatCents(l.variant.priceCents * l.quantity - l.discountCents)}</Text>
              </View>
              <Text style={ui.muted}>{variantLabel(l.variant)}</Text>
              <View style={[ui.row, { gap: 8, marginTop: 6 }]}>
                <Button title="−" kind="secondary" onPress={() => setQty(l.variant.id, l.quantity - 1)} style={{ minHeight: 36, paddingVertical: 6 }} />
                <Text style={ui.text}>{l.quantity}</Text>
                <Button
                  title="+"
                  kind="secondary"
                  disabled={l.variant.serialized}
                  onPress={() => setQty(l.variant.id, l.quantity + 1)}
                  style={{ minHeight: 36, paddingVertical: 6 }}
                />
                <Pressable onPress={() => discount(l)}>
                  <Text style={[ui.muted, { marginLeft: 8 }]}>{l.discountCents ? `−${formatCents(l.discountCents)}` : "Discount"}</Text>
                </Pressable>
              </View>
            </View>
          )}
        />
        <View style={{ gap: 4 }}>
          <Row label="Subtotal" value={totals.subtotalCents} />
          {totals.discountCents > 0 && <Row label={rewardIds.length ? "Discounts & rewards" : "Discounts"} value={-totals.discountCents} />}
          <Row label={`Tax (${(location.taxRateBps / 100).toFixed(2)}%)`} value={totals.taxCents} />
          <Row label="Total" value={totals.totalCents} big />
          {quote?.earn && quote.earn.amount > 0 && (
            <Text style={[ui.muted, { color: colors.good }]}>
              Earns {quote.earn.unit === "POINTS" ? `${quote.earn.amount.toLocaleString()} pts` : `${formatCents(quote.earn.amount)} rewards`}
            </Text>
          )}
          {quoteError && <Text style={ui.error}>{quoteError}</Text>}
        </View>
        <View style={[ui.row, { gap: 8 }]}>
          <Button title="Clear" kind="secondary" onPress={reset} disabled={!lines.length} />
          <Button title={`Charge ${formatCents(totals.totalCents)}`} kind="good" onPress={() => setTendering(true)} disabled={!lines.length || !quoteReady} style={{ flex: 1 }} />
        </View>
        {!isManager(staff) && <Text style={ui.muted}>Price overrides and refunds need a manager.</Text>}
      </View>

      {pickingRewards && customer && (
        <RewardsPicker points={customer.loyalty?.points ?? 0} selected={rewardIds} onChange={setRewardIds} onClose={() => setPickingRewards(false)} />
      )}

      {tendering && (
        <TenderSheet
          totalCents={totals.totalCents}
          customer={customer}
          onCancel={() => setTendering(false)}
          submit={(tenders, idempotencyKey) =>
            api("POST", "/orders/checkout", {
              locationId: location.id,
              customerId: customer?.id,
              lines: lines.map((l) => ({ variantId: l.variant.id, quantity: l.quantity, discountCents: l.discountCents })),
              tenders,
              idempotencyKey,
              rewardIds,
            })
          }
          onDone={reset}
        />
      )}
    </View>
  );
}

function Row({ label, value, big }: { label: string; value: number; big?: boolean }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between" }]}>
      <Text style={big ? ui.h1 : ui.muted}>{label}</Text>
      <Text style={big ? ui.h1 : ui.text}>{formatCents(value)}</Text>
    </View>
  );
}

function TenderSheet(props: {
  totalCents: number;
  customer: Customer | null;
  onCancel: () => void;
  submit: (tenders: TenderInput[], idempotencyKey: string) => Promise<{ order: { number: number }; changeCents: number }>;
  onDone: () => void;
}) {
  // One key per sale attempt: retries reuse it so the card is never double-charged.
  const [idempotencyKey] = useState(() => Crypto.randomUUID());
  const [tenders, setTenders] = useState<TenderInput[]>([]);
  const [cashInput, setCashInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ number: number; changeCents: number } | null>(null);

  const paid = tenders.reduce((a, t) => a + t.amountCents, 0);
  const due = props.totalCents - paid;
  const credit = props.customer?.storeCreditCents ?? 0;
  const creditUsed = tenders.filter((t) => t.type === "STORE_CREDIT").reduce((a, t) => a + t.amountCents, 0);
  const rewards = props.customer?.loyalty?.rewardsCents ?? 0;
  const rewardsUsed = tenders.filter((t) => t.type === "LOYALTY").reduce((a, t) => a + t.amountCents, 0);

  const addCash = (handed: number) => {
    if (handed <= 0 || due <= 0) return;
    setTenders((t) => [...t, { type: "CASH", amountCents: Math.min(handed, due), tenderedCents: handed }]);
    setCashInput("");
  };
  const addCard = () =>
    due > 0 && setTenders((t) => [...t, { type: "CARD", amountCents: due, ...(TERMINAL_ID ? { terminalId: TERMINAL_ID } : { paymentToken: "tok_ok" }) }]);
  const addCredit = () => {
    const amt = Math.min(due, credit - creditUsed);
    if (amt > 0) setTenders((t) => [...t, { type: "STORE_CREDIT", amountCents: amt }]);
  };

  const addRewards = () => {
    const amt = Math.min(due, rewards - rewardsUsed);
    if (amt > 0) setTenders((t) => [...t, { type: "LOYALTY", amountCents: amt }]);
  };

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      const r = await props.submit(tenders, idempotencyKey);
      setReceipt({ number: r.order.number, changeCents: r.changeCents });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={props.onCancel}>
      <View style={{ flex: 1, backgroundColor: "#000b", justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: 560, maxHeight: "90%" }]} contentContainerStyle={{ gap: 12 }}>
          {receipt ? (
            <>
              <Text style={ui.h1}>Sale #{receipt.number} complete</Text>
              {receipt.changeCents > 0 && <Text style={[ui.h1, { color: colors.good, fontSize: 40 }]}>Change {formatCents(receipt.changeCents)}</Text>}
              <Button title="New sale" kind="good" onPress={props.onDone} />
            </>
          ) : (
            <>
              <Text style={ui.h1}>{due > 0 ? `Due ${formatCents(due)}` : "Ready to complete"}</Text>
              {tenders.map((t, i) => (
                <View key={i} style={[ui.row, { justifyContent: "space-between" }]}>
                  <Text style={ui.text}>
                    {t.type === "LOYALTY" ? "REWARDS" : t.type.replace("_", " ")}
                    {t.tenderedCents && t.tenderedCents > t.amountCents ? ` (handed ${formatCents(t.tenderedCents)})` : ""}
                  </Text>
                  <Pressable onPress={() => setTenders((ts) => ts.filter((_, j) => j !== i))}>
                    <Text style={ui.text}>{formatCents(t.amountCents)} ✕</Text>
                  </Pressable>
                </View>
              ))}
              {due > 0 && (
                <>
                  <Text style={ui.muted}>Cash</Text>
                  <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
                    <Button title="Exact" kind="secondary" onPress={() => addCash(due)} />
                    {[2000, 5000, 10000].filter((d) => d >= due).map((d) => (
                      <Button key={d} title={formatCents(d)} kind="secondary" onPress={() => addCash(d)} />
                    ))}
                    <TextInput
                      style={[ui.input, { width: 120 }]}
                      placeholder="Other"
                      placeholderTextColor={colors.muted}
                      keyboardType="decimal-pad"
                      value={cashInput}
                      onChangeText={setCashInput}
                      onSubmitEditing={() => addCash(Math.round(Number(cashInput) * 100))}
                    />
                  </View>
                  <View style={[ui.row, { gap: 8 }]}>
                    <Button title={`Card ${formatCents(due)}`} onPress={addCard} style={{ flex: 1 }} />
                    {credit - creditUsed > 0 && (
                      <Button title={`Store credit (${formatCents(credit - creditUsed)})`} kind="secondary" onPress={addCredit} style={{ flex: 1 }} />
                    )}
                    {rewards - rewardsUsed > 0 && (
                      <Button title={`Rewards (${formatCents(rewards - rewardsUsed)})`} kind="secondary" onPress={addRewards} style={{ flex: 1 }} />
                    )}
                  </View>
                </>
              )}
              {error && <Text style={ui.error}>{error}</Text>}
              <View style={[ui.row, { gap: 8 }]}>
                <Button title="Back" kind="secondary" onPress={props.onCancel} disabled={busy} />
                <Button title="Complete sale" kind="good" onPress={complete} disabled={due !== 0} busy={busy} style={{ flex: 1 }} />
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
