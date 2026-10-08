import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { colors, ui } from "../theme";

/** Big-button PIN entry for touch registers. Shows dots, never digits. */
export function PinPad(props: { onSubmit: (pin: string) => void; busy?: boolean; maxLength?: number; submitLabel?: string }) {
  const [pin, setPin] = useState("");
  const max = props.maxLength ?? 8;
  const press = (k: string) => {
    if (props.busy) return;
    if (k === "⌫") return setPin((p) => p.slice(0, -1));
    if (k === "OK") {
      if (pin.length >= 4) {
        props.onSubmit(pin);
        setPin("");
      }
      return;
    }
    setPin((p) => (p.length < max ? p + k : p));
  };
  return (
    <View style={{ gap: 12, alignItems: "center" }}>
      <View style={[ui.row, { gap: 10, height: 24 }]}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <View key={i} style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: i < pin.length ? colors.text : colors.border }} />
        ))}
      </View>
      {[["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["⌫", "0", "OK"]].map((row) => (
        <View key={row.join()} style={[ui.row, { gap: 10 }]}>
          {row.map((k) => (
            <Pressable
              key={k}
              accessibilityLabel={k === "⌫" ? "Delete" : k === "OK" ? (props.submitLabel ?? "Enter") : k}
              onPress={() => press(k)}
              style={({ pressed }) => ({
                width: 76,
                height: 64,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: k === "OK" ? (pin.length >= 4 ? colors.good : colors.panelAlt) : pressed ? colors.border : colors.panelAlt,
              })}
            >
              <Text style={[ui.h1, { fontSize: k === "OK" ? 18 : 26 }]}>{k === "OK" ? (props.submitLabel ?? "Enter") : k}</Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}
