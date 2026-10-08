import { cardPrice, formatCents } from "@mypos/shared";
import * as Print from "expo-print";
import { useState } from "react";
import { FlatList, Text, TextInput, View } from "react-native";
import { api, ApiError, apiText, type Product, type Variant } from "../api";
import { Button } from "../components/Button";
import { ProductSearch, variantLabel } from "../components/ProductSearch";
import { useSession } from "../session";
import { colors, ui } from "../theme";

interface QueuedLabel {
  product: Product;
  variant: Variant;
  copies: number;
}

/** Price labels with cash and card prices, to a Zebra printer or via AirPrint. */
export function LabelsScreen() {
  const { location } = useSession();
  const [queue, setQueue] = useState<QueuedLabel[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const bps = location.cardPriceBps;

  const items = () => queue.map((q) => ({ variantId: q.variant.id, copies: q.copies }));
  const add = (product: Product, variant: Variant) =>
    setQueue((prev) => (prev.some((q) => q.variant.id === variant.id) ? prev : [...prev, { product, variant, copies: 1 }]));

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await fn());
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, flexDirection: "row", gap: 16, padding: 16 }}>
      <View style={[ui.panel, { flex: 3 }]}>
        <ProductSearch onPick={add} />
      </View>
      <View style={[ui.panel, { flex: 2, gap: 12 }]}>
        <Text style={ui.h1}>Labels</Text>
        <FlatList
          style={{ flex: 1 }}
          data={queue}
          keyExtractor={(q) => q.variant.id}
          ListEmptyComponent={<Text style={ui.muted}>Add items to print shelf labels.</Text>}
          renderItem={({ item: q }) => (
            <View style={[ui.row, { gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={ui.text} numberOfLines={1}>
                  {q.product.title}
                </Text>
                <Text style={ui.muted}>
                  {variantLabel(q.variant)} · {bps > 0 ? `Cash ${formatCents(q.variant.priceCents)} · Card ${formatCents(cardPrice(q.variant.priceCents, bps))}` : formatCents(q.variant.priceCents)}
                </Text>
              </View>
              <TextInput
                style={[ui.input, { width: 64, paddingVertical: 6, textAlign: "center" }]}
                keyboardType="number-pad"
                defaultValue={String(q.copies)}
                onChangeText={(t) => {
                  const n = Math.max(1, Math.min(500, Number(t) || 1));
                  setQueue((prev) => prev.map((x) => (x === q ? { ...x, copies: n } : x)));
                }}
              />
              <Button title="✕" kind="secondary" onPress={() => setQueue((prev) => prev.filter((x) => x !== q))} style={{ minHeight: 36, paddingVertical: 6 }} />
            </View>
          )}
        />
        {message && <Text style={ui.text}>{message}</Text>}
        <View style={[ui.row, { gap: 8 }]}>
          <Button
            title="Label printer"
            disabled={!queue.length || !location.labelPrinterHost}
            busy={busy}
            style={{ flex: 1 }}
            onPress={() =>
              run(async () => {
                const r = await api<{ printed: number }>("POST", "/labels/print", { locationId: location.id, items: items() });
                return `Sent ${r.printed} label(s) to the printer`;
              })
            }
          />
          <Button
            title="AirPrint"
            kind="secondary"
            disabled={!queue.length}
            busy={busy}
            style={{ flex: 1 }}
            onPress={() =>
              run(async () => {
                await Print.printAsync({ html: await apiText("POST", "/labels", { locationId: location.id, items: items(), format: "html" }) });
                return "Sent to printer";
              })
            }
          />
        </View>
        {!location.labelPrinterHost && <Text style={ui.muted}>The owner can add a Zebra label printer in Store settings.</Text>}
      </View>
    </View>
  );
}
