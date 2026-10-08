import { CameraView, useCameraPermissions } from "expo-camera";
import { formatCents, gradeLabel, isNewItem, ITEM_CONDITION_LABELS, type ItemCondition } from "@mypos/shared";
import * as SecureStore from "../storage";
import { useEffect, useRef, useState } from "react";
import { FlatList, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { api, ApiError, type Product, type Variant } from "../api";
import { useSession } from "../session";
import { colors, ui } from "../theme";
import { Button } from "./Button";
import { MarketBadge } from "./MarketBadge";
import { EMPTY_FILTERS, filterParams, hasFilters, SearchFilters, type Filters } from "./SearchFilters";
import { Thumb } from "./Thumb";

/** "PSA 10 #12345678 · HOLO", "NM · FOIL", "Sz 10 · Chicago · New". */
export function variantLabel(v: Variant): string {
  const graded = gradeLabel(v.gradingCompany, v.grade);
  return [
    graded ? `${graded}${v.certNumber ? ` #${v.certNumber}` : ""}` : v.condition,
    v.finish && v.finish !== "NONFOIL" ? v.finish : null,
    v.size && `Sz ${v.size}`,
    v.colorway,
    v.itemCondition ? (isNewItem(v.itemCondition) ? "New" : ITEM_CONDITION_LABELS[v.itemCondition as ItemCondition]) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export const imageOf = (p: Product, v: Variant) => v.imageUrl ?? p.imageUrl ?? null;

/**
 * Search by name, set code, collector #, style code, SKU, vendor SKU, or
 * scanned barcode. `extraQuery` narrows every search (e.g. `vendorId=…` when
 * building a purchase order); `placeholder` labels the box.
 */
export function ProductSearch({ onPick, extraQuery, placeholder }: { onPick: (p: Product, v: Variant) => void; extraQuery?: string; placeholder?: string }) {
  const { location } = useSession();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const input = useRef<TextInput>(null);
  // Devices with a built-in or USB/Bluetooth scanner "type" the barcode and
  // press Enter. Scanner mode keeps the box focused without the on-screen
  // keyboard covering the screen (Android; iPads hide it for hardware keyboards).
  const [scannerMode, setScannerMode] = useState(false);
  useEffect(() => {
    SecureStore.getItem("scannerMode").then((v) => setScannerMode(v === "1"));
  }, []);
  const toggleScanner = () => {
    const next = !scannerMode;
    setScannerMode(next);
    SecureStore.setItem("scannerMode", next ? "1" : "0");
    setTimeout(() => input.current?.focus(), 50);
  };

  async function search(term: string, f: Filters = filters) {
    if (!term.trim() && !hasFilters(f) && !extraQuery) return;
    setError(null);
    try {
      const r = await api<{ results: Product[] }>("GET", `/catalog/search?q=${encodeURIComponent(term.trim())}&locationId=${location.id}${filterParams(f)}${extraQuery ? `&${extraQuery}` : ""}`);
      setResults(r.results);
      // A barcode/SKU hit with one variant goes straight to the cart.
      const only = r.results.length === 1 && r.results[0]!.variants.length === 1 ? r.results[0]! : null;
      if (only && !hasFilters(f) && (only.variants[0]!.sku === term.trim() || term.trim().match(/^\d{8,14}$/))) {
        onPick(only, only.variants[0]!);
        setQ("");
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      // Ready for the next scan.
      input.current?.focus();
    }
  }

  // A narrowed search (one vendor's items) lists everything right away.
  useEffect(() => {
    if (extraQuery) search(q, filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraQuery]);

  // Changing a filter re-runs the search right away (filters alone are a valid search).
  const changeFilters = (f: Filters) => {
    setFilters(f);
    if (hasFilters(f) || q.trim()) search(q, f);
    else setResults([]);
  };

  async function openScanner() {
    if (!permission?.granted && !(await requestPermission()).granted) return;
    setScanning(true);
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={[ui.row, { gap: 8 }]}>
        <TextInput
          ref={input}
          style={[ui.input, { flex: 1, minWidth: 0 }]}
          placeholder={placeholder ?? (scannerMode ? "Scan or type…" : "Search card, set, style code, brand, SKU…")}
          autoFocus
          blurOnSubmit={false}
          showSoftInputOnFocus={!scannerMode}
          placeholderTextColor={colors.muted}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={() => search(q)}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        <Button title="Camera" kind="secondary" onPress={openScanner} />
        <Button title={hasFilters(filters) ? "Filters ●" : "Filters"} kind={showFilters ? "primary" : "secondary"} onPress={() => setShowFilters((x) => !x)} />
        {Platform.OS === "android" && <Button title={scannerMode ? "⌨ Off" : "⌨ On"} kind="secondary" onPress={toggleScanner} />}
      </View>
      {showFilters && <SearchFilters value={filters} onChange={changeFilters} locationId={location.id} />}
      {error && <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text>}
      <FlatList
        style={{ marginTop: 12 }}
        data={results.flatMap((p) => p.variants.map((v) => ({ p, v })))}
        keyExtractor={({ v }) => v.id}
        renderItem={({ item: { p, v } }) => {
          const onHand = v.inventory?.find((i) => i.locationId === location.id)?.onHand ?? 0;
          return (
            <Pressable onPress={() => onPick(p, v)} style={({ pressed }) => [styles.result, pressed && { backgroundColor: colors.panelAlt }]}>
              <Thumb uri={imageOf(p, v)} title={p.title} size={36} />
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
                <MarketBadge market={v.market} />
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
