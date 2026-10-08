import { buylistOffer, formatCents } from "@mypos/shared";
import { useState } from "react";
import { FlatList, Text, TextInput, View } from "react-native";
import { api, ApiError, type Customer, type Product, type Variant } from "../api";
import { Button } from "../components/Button";
import { CustomerPicker } from "../components/CustomerPicker";
import { SplitPane } from "../components/SplitPane";
import { ProductSearch, variantLabel } from "../components/ProductSearch";
import { isManager, useSession } from "../session";
import { colors, ui } from "../theme";

interface BuyLine {
  product: Product;
  variant: Variant;
  quantity: number;
  marketCents: number;
}

/** Trade-in counter: price what the customer brought, show cash vs credit, pay out. */
export function BuylistScreen() {
  const { location, staff } = useSession();
  const [lines, setLines] = useState<BuyLine[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const offers = lines.map((l) => buylistOffer(l.marketCents));
  const cash = lines.reduce((a, l, i) => a + offers[i]!.cashCents * l.quantity, 0);
  const credit = lines.reduce((a, l, i) => a + offers[i]!.creditCents * l.quantity, 0);

  function add(product: Product, variant: Variant) {
    setLines((prev) => [...prev, { product, variant, quantity: 1, marketCents: variant.marketCents ?? variant.priceCents }]);
  }

  async function payout(kind: "CASH" | "STORE_CREDIT") {
    setBusy(true);
    setMessage(null);
    try {
      const ticket = await api<{ id: string; number: number }>("POST", "/buylist/quote", {
        locationId: location.id,
        customerId: customer?.id,
        lines: lines.map((l) => ({ variantId: l.variant.id, quantity: l.quantity, marketCents: l.marketCents })),
      });
      const done = await api<{ paidCents: number }>("POST", `/buylist/${ticket.id}/accept`, { payout: kind, customerId: customer?.id });
      setMessage(`Buylist #${ticket.number}: paid ${formatCents(done.paidCents)} ${kind === "CASH" ? "cash" : "store credit"}`);
      setLines([]);
      setCustomer(null);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SplitPane
      rightLabel={`Ticket (${lines.length})`}
      left={<ProductSearch onPick={add} />}
      right={
        <>
          <CustomerPicker customer={customer} onChange={setCustomer} />
          <FlatList
            style={{ flex: 1 }}
            data={lines}
            keyExtractor={(_, i) => String(i)}
            ListEmptyComponent={<Text style={[ui.muted, { textAlign: "center", marginTop: 40 }]}>Add what the customer is selling</Text>}
            renderItem={({ item: l, index }) => (
              <View style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 4 }}>
                <Text style={ui.text} numberOfLines={1}>
                  {l.quantity}× {l.product.title}
                </Text>
                <Text style={ui.muted}>{variantLabel(l.variant)}</Text>
                <View style={[ui.row, { gap: 8 }]}>
                  <Text style={ui.muted}>Market $</Text>
                  <TextInput
                    style={[ui.input, { width: 100, paddingVertical: 6 }]}
                    keyboardType="decimal-pad"
                    defaultValue={(l.marketCents / 100).toFixed(2)}
                    onEndEditing={(e) => {
                      const cents = Math.round(Number(e.nativeEvent.text) * 100);
                      if (Number.isFinite(cents)) setLines((prev) => prev.map((x, j) => (j === index ? { ...x, marketCents: cents } : x)));
                    }}
                  />
                  <Text style={ui.muted}>
                    {offers[index]!.accepted
                      ? `${formatCents(offers[index]!.cashCents)} cash / ${formatCents(offers[index]!.creditCents)} credit`
                      : "Below buy minimum"}
                  </Text>
                </View>
              </View>
            )}
          />
          {message && <Text style={ui.text}>{message}</Text>}
          {!isManager(staff) && lines.length > 0 && <Text style={ui.muted}>A manager must approve payouts.</Text>}
          <View style={[ui.row, { gap: 8 }]}>
            <Button
              title={`Cash ${formatCents(cash)}`}
              onPress={() => payout("CASH")}
              disabled={!lines.length || !isManager(staff)}
              busy={busy}
              style={{ flex: 1 }}
            />
            <Button
              title={`Credit ${formatCents(credit)}`}
              kind="good"
              onPress={() => payout("STORE_CREDIT")}
              disabled={!lines.length || !customer || !isManager(staff)}
              busy={busy}
              style={{ flex: 1 }}
            />
          </View>
        </>
      }
    />
  );
}
