import { Platform, StyleSheet } from "react-native";

/**
 * The register is dark (easy on the eyes at a counter). The back-office
 * website is light, in the style of a modern admin dashboard.
 */
const isWebAdmin = Platform.OS === "web" && typeof globalThis.location !== "undefined" && !new URLSearchParams(globalThis.location.search).has("register");
export const theme: "light" | "dark" = isWebAdmin ? "light" : "dark";

const dark = {
  bg: "#0d0f14",
  panel: "#161a22",
  panelAlt: "#1e2430",
  border: "#2a3140",
  text: "#eef1f6",
  muted: "#8a93a6",
  /** Selected backgrounds (chips, tabs). */
  accent: "#5b8cff",
  /** Primary buttons. */
  primary: "#5b8cff",
  onPrimary: "#ffffff",
  /** Link-style text. */
  link: "#5b8cff",
  good: "#2fbf71",
  warn: "#f2a33a",
  bad: "#ef5350",
  overlay: "#000b",
};

const light: typeof dark = {
  bg: "#f4f4f5",
  panel: "#ffffff",
  panelAlt: "#f4f4f5",
  border: "#e4e4e7",
  text: "#18181b",
  muted: "#71717a",
  accent: "#dbeafe",
  primary: "#18181b",
  onPrimary: "#ffffff",
  link: "#2563eb",
  good: "#16a34a",
  warn: "#d97706",
  bad: "#dc2626",
  overlay: "#00000088",
};

export const colors = theme === "light" ? light : dark;

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  panel: { backgroundColor: colors.panel, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.border },
  h1: { color: colors.text, fontSize: 22, fontWeight: "700" },
  h2: { color: colors.text, fontSize: 17, fontWeight: "600" },
  text: { color: colors.text, fontSize: 15 },
  muted: { color: colors.muted, fontSize: 13 },
  input: {
    backgroundColor: theme === "light" ? "#ffffff" : colors.panelAlt,
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
