import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useLayout } from "../layout";
import { colors, ui } from "../theme";

/**
 * Search on the left, working panel (cart, ticket, queue) on the right.
 * On small screens the two become tabs so each gets the full screen.
 */
export function SplitPane(props: { left: ReactNode; right: ReactNode; leftLabel?: string; rightLabel: string; showRight?: boolean; onToggle?: (right: boolean) => void }) {
  const { compact } = useLayout();
  const [rightLocal, setRightLocal] = useState(false);
  const right = props.showRight ?? rightLocal;
  const setRight = (r: boolean) => (props.onToggle ? props.onToggle(r) : setRightLocal(r));

  if (!compact) {
    return (
      <View style={{ flex: 1, flexDirection: "row", gap: 16, padding: 16 }}>
        <View style={[ui.panel, { flex: 3 }]}>{props.left}</View>
        <View style={[ui.panel, { flex: 2, gap: 12 }]}>{props.right}</View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, padding: 8, gap: 8 }}>
      <View style={[ui.row, { gap: 8 }]}>
        {[false, true].map((r) => (
          <Pressable
            key={String(r)}
            onPress={() => setRight(r)}
            style={{ flex: 1, padding: 12, borderRadius: 8, alignItems: "center", backgroundColor: right === r ? colors.accent : colors.panel }}
          >
            <Text style={[ui.text, { fontWeight: "600" }]}>{r ? props.rightLabel : (props.leftLabel ?? "Search")}</Text>
          </Pressable>
        ))}
      </View>
      {/* Both stay mounted so search results and inputs survive switching. */}
      <View style={[ui.panel, { flex: 1, padding: 12, display: right ? "none" : "flex" }]}>{props.left}</View>
      <View style={[ui.panel, { flex: 1, padding: 12, gap: 10, display: right ? "flex" : "none" }]}>{props.right}</View>
    </View>
  );
}
