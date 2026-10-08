import { formatCents, formatTrend, type MarketTrend } from "@mypos/shared";
import { Text } from "react-native";
import { colors, ui } from "../theme";

/** "Market $101.08 ▲ 3.2% 7d" for items with a price feed; nothing otherwise. */
export function MarketBadge({ market, size = 13 }: { market?: MarketTrend | null; size?: number }) {
  if (!market || market.marketCents == null) return null;
  const color = market.changeBps == null || market.changeBps === 0 ? colors.muted : market.changeBps > 0 ? colors.good : colors.bad;
  return (
    <Text style={[ui.muted, { fontSize: size }]}>
      Market {formatCents(market.marketCents)}
      {market.changeBps != null && <Text style={{ color, fontWeight: "600" }}> {formatTrend(market.changeBps)} {market.days}d</Text>}
    </Text>
  );
}
