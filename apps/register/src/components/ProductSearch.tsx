import { CameraView, useCameraPermissions } from "expo-camera";
import { formatCents } from "@mypos/shared";
import { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { api, ApiError, type Product, type Variant } from "../api";
import { useSession } from "../session";
import { colors, ui } from "../theme";
import { Button } from "./Button";

export function variantLabel(v: Variant): string {
  return [v.condition, v.finish && v.finish !== "NONFOIL" ? v.finish : null, v.size && `Sz ${v.size}`, v.colorway, v.itemCondition]
    .filter(Boolean)
    .join(" · ");
}

/** Search by name, set code, collector #, style code, SKU, or scanned barcode. */
export function ProductSearch({ onPick }: { onPick: (p: Product, v: Variant) => void }) {
  const { location } = useSession();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  async function search(term: string) {
    if (!term.trim()) return;
    setError(null);
    try {
      const r = await api<{ results: Product[] }>("GET", `/catalog/search?q=${encodeURIComponent(term.trim())}&locationId=${location.id}`);
      setResults(r.results);
      // A barcode/SKU hit with one variant goes straight to the cart.
      const only = r.results.length === 1 && r.results[0]!.variants.length === 1 ? r.results[0]! : null;
      if (only && (only.variants[0]!.sku === term.trim() || term.trim().match(/^\d{8,14}$/))) {
        onPick(only, only.variants[0]!);
        setQ("");
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function openScanner() {
    if (!permission?.granted && !(await requestPermission()).granted) return;
    setScanning(true);
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={[ui.row, { gap: 8 }]}>
        <TextInput
          style={[ui.input, { flex: 1 }]}
          placeholder="Search card, set, style code, SKU…"
          placeholderTextColor={colors.muted}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={() => search(q)}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        <Button title="Scan" kind="secondary" onPress={openScanner} />
      </View>
      {error && <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text>}
      <FlatList
        style={{ marginTop: 12 }}
        data={results.flatMap((p) => p.variants.map((v) => ({ p, v })))}
        keyExtractor={({ v }) => v.id}
        renderItem={({ item: { p, v } }) => {
          const onHand = v.inventory?.find((i) => i.locationId === location.id)?.onHand ?? 0;
          return (
            <Pressable onPress={() => onPick(p, v)} style={({ pressed }) => [styles.result, pressed && { backgroundColor: colors.panelAlt }]}>
              <View style={{ flex: 1 }}>
                <Text style={ui.text} numberOfLines={1}>
                  {p.title}
                </Text>
                <Text style={ui.muted}>
                  {[p.setName && `${p.setName}${p.collectorNumber ? ` #${p.collectorNumber}` : ""}`, p.brand, variantLabel(v)].filter(Boolean).join(" · ")}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={ui.h2}>{formatCents(v.priceCents)}</Text>
                <Text style={[ui.muted, onHand <= 0 && { color: colors.bad }]}>{onHand} in stock</Text>
              </View>
            </Pressable>
          );
        }}
      />
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <CameraView
          style={{ flex: 1 }}
          barcodeScannerSettings={{ barcodeTypes: ["ean13", "upc_a", "upc_e", "code128", "qr"] }}
          onBarcodeScanned={({ data }) => {
            setScanning(false);
            setQ(data);
            search(data);
          }}
        />
        <Button title="Cancel" kind="secondary" onPress={() => setScanning(false)} style={{ margin: 16 }} />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  result: { flexDirection: "row", gap: 12, paddingVertical: 12, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
});
