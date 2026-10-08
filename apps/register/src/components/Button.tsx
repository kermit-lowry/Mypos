import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { colors } from "../theme";

interface Props {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger" | "good";
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}

export function Button({ title, onPress, kind = "primary", disabled, busy, style }: Props) {
  const bg = { primary: colors.accent, secondary: colors.panelAlt, danger: colors.bad, good: colors.good }[kind];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [styles.btn, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 }, style]}
    >
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.label}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { borderRadius: 10, paddingVertical: 14, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", minHeight: 50 },
  label: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
