import { useState } from "react";
import { Image, Text, View } from "react-native";
import { colors } from "../theme";

/** Item photo (variant's own, else the product's), or a placeholder with the initial. */
export function Thumb({ uri, title, size = 48 }: { uri?: string | null; title: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: Math.round(size * 1.4), borderRadius: 6, backgroundColor: colors.panelAlt };
  if (!uri || failed) {
    return (
      <View style={[box, { alignItems: "center", justifyContent: "center" }]}>
        <Text style={{ color: colors.muted, fontSize: size / 2.4, fontWeight: "700" }}>{title.slice(0, 1).toUpperCase()}</Text>
      </View>
    );
  }
  return <Image source={{ uri }} style={box} resizeMode="contain" onError={() => setFailed(true)} accessibilityLabel={title} />;
}
