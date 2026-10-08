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

const LOOK = {
  primary: { bg: colors.primary, fg: colors.onPrimary },
  secondary: { bg: colors.panelAlt, fg: colors.text },
  danger: { bg: colors.bad, fg: "#ffffff" },
  good: { bg: colors.good, fg: "#ffffff" },
} as const;

export function Button({ title, onPress, kind = "primary", disabled, busy, style }: Props) {
  const look = LOOK[kind];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [styles.btn, { backgroundColor: look.bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 }, kind === "secondary" && styles.outlined, style]}
    >
      {busy ? <ActivityIndicator color={look.fg} /> : <Text style={[styles.label, { color: look.fg }]}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { borderRadius: 10, paddingVertical: 14, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", minHeight: 50 },
  outlined: { borderWidth: 1, borderColor: colors.border },
  label: { fontSize: 16, fontWeight: "600" },
});
