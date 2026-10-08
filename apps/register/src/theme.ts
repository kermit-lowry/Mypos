import { StyleSheet } from "react-native";

export const colors = {
  bg: "#0d0f14",
  panel: "#161a22",
  panelAlt: "#1e2430",
  border: "#2a3140",
  text: "#eef1f6",
  muted: "#8a93a6",
  accent: "#5b8cff",
  good: "#2fbf71",
  warn: "#f2a33a",
  bad: "#ef5350",
};

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  panel: { backgroundColor: colors.panel, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.border },
  h1: { color: colors.text, fontSize: 22, fontWeight: "700" },
  h2: { color: colors.text, fontSize: 17, fontWeight: "600" },
  text: { color: colors.text, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 13 },
  input: {
    backgroundColor: colors.panelAlt,
    color: colors.text,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: "row", alignItems: "center" },
  error: { color: colors.bad, fontSize: 14 },
});
