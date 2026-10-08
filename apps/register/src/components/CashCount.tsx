import { formatCents } from "@mypos/shared";
import { Pressable, Text, TextInput, View } from "react-native";
import type { CashCounts } from "../api";
import { useLayout } from "../layout";
import { colors, ui } from "../theme";

/** Bills and coins, largest first. Keys are cents, matching the stored counts. */
export const DENOMINATIONS = [10000, 5000, 2000, 1000, 500, 100, 25, 10, 5, 1] as const;

const label = (cents: number) => (cents >= 100 ? `$${cents / 100}` : `${cents}¢`);

export const countTotal = (counts: CashCounts) => DENOMINATIONS.reduce((a, d) => a + d * (counts[String(d)] ?? 0), 0);

/** Only the denominations that were counted, for the server. */
export const nonZeroCounts = (counts: CashCounts): CashCounts =>
  Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));

/**
 * Count the drawer by denomination: +/− or a typed count per row, with the
 * running total. Used to count the float in and to blind-count at close.
 */
export function CashCount({ counts, onChange }: { counts: CashCounts; onChange: (c: CashCounts) => void }) {
  const { narrow } = useLayout();
  const set = (d: number, n: number) => onChange({ ...counts, [String(d)]: Math.max(0, Math.min(9999, Math.floor(n) || 0)) });
  const total = countTotal(counts);

  return (
    <View style={{ gap: 6 }}>
      {DENOMINATIONS.map((d) => {
        const n = counts[String(d)] ?? 0;
        return (
          <View key={d} style={[ui.row, { gap: 8 }]}>
            <Text style={[ui.text, { width: narrow ? 44 : 56, fontWeight: "600" }]}>{label(d)}</Text>
            <Step title="−" onPress={() => set(d, n - 1)} />
            <TextInput
              style={[ui.input, { width: 64, textAlign: "center", paddingVertical: 6 }]}
              value={n ? String(n) : ""}
              onChangeText={(t) => set(d, Number(t.replace(/\D/g, "")))}
              keyboardType="number-pad"
              placeholder="0"
              placeholderTextColor={colors.muted}
              selectTextOnFocus
            />
            <Step title="+" onPress={() => set(d, n + 1)} />
            <Text style={[ui.muted, { flex: 1, textAlign: "right" }]}>{n ? formatCents(d * n) : ""}</Text>
          </View>
        );
      })}
      <View style={[ui.row, { justifyContent: "space-between", paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.border }]}>
        <Text style={ui.h2}>Counted</Text>
        <Text style={ui.h2}>{formatCents(total)}</Text>
      </View>
    </View>
  );
}

function Step({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title === "+" ? "Add one" : "Remove one"}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? colors.border : colors.panelAlt,
      })}
    >
      <Text style={[ui.h2, { fontSize: 20 }]}>{title}</Text>
    </Pressable>
  );
}
