import { formatCents } from "@mypos/shared";
import { useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { api } from "../api";
import { MarketBadge } from "../components/MarketBadge";
import { Thumb } from "../components/Thumb";
import { TerminalPicker, useTerminal } from "../components/TerminalPicker";
import { displayChannel, type DisplayState } from "../display";
import { useLayout } from "../layout";
import { useSession } from "../session";
import { colors, ui } from "../theme";

/**
 * Customer-facing screen: run on a second tablet facing the customer, paired
 * to a register by its card terminal. Shows cash and card prices side by side.
 * Long-press the store name to leave display mode.
 */
export function CustomerDisplayScreen({ onExit }: { onExit: () => void }) {
  const { location } = useSession();
  const { terminal, terminals, select } = useTerminal();
  const { compact } = useLayout();
  const channel = displayChannel(location.id, terminal?.id);
  const [d, setD] = useState<DisplayState>({ state: "IDLE", storeName: location.name });

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const next = await api<DisplayState>("GET", `/displays/${encodeURIComponent(channel)}`);
        if (live) setD("storeName" in next ? next : { state: "IDLE", storeName: location.name });
      } catch {
        // Keep showing the last state through brief network blips.
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [channel, location.name]);

  // Several registers here: pair this display with one of them.
  if (terminals && terminals.length > 1 && !terminal) {
    return (
      <View style={ui.screen}>
        <TerminalPicker terminals={terminals} onSelect={select} onClose={onExit} />
      </View>
    );
  }

  const header = (
    <Pressable onLongPress={onExit} delayLongPress={1500}>
      <Text style={[ui.h1, { fontSize: 28, textAlign: "center", padding: 20 }]}>{d.storeName}</Text>
    </Pressable>
  );

  if (d.state === "IDLE") {
    return (
      <View style={[ui.screen, { justifyContent: "center" }]}>
        {header}
        <Text style={[ui.muted, { fontSize: 22, textAlign: "center" }]}>Welcome!</Text>
      </View>
    );
  }

  if (d.state === "DONE") {
    return (
      <View style={[ui.screen, { justifyContent: "center", alignItems: "center", gap: 16 }]}>
        {header}
        <Text style={[ui.h1, { fontSize: 44 }]}>Thank you!</Text>
        <Text style={[ui.text, { fontSize: 24 }]}>Paid {formatCents(d.totalCents)}</Text>
        {d.changeCents > 0 && <Text style={[ui.h1, { color: colors.good, fontSize: 36 }]}>Your change: {formatCents(d.changeCents)}</Text>}
      </View>
    );
  }

  const dual = d.cardPercent !== null;
  return (
    <View style={[ui.screen, { flexDirection: compact ? "column" : "row", padding: compact ? 12 : 24, gap: compact ? 12 : 24 }]}>
      <View style={[ui.panel, { flex: 3 }]}>
        <View style={[ui.row, { paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
          <Text style={[ui.muted, { flex: 1, fontSize: 16 }]}>Item</Text>
          <Text style={[ui.muted, { width: 130, textAlign: "right", fontSize: 16 }]}>{dual ? "Cash" : "Price"}</Text>
          {dual && <Text style={[ui.muted, { width: 130, textAlign: "right", fontSize: 16 }]}>Card</Text>}
        </View>
        <FlatList
          data={d.lines}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item: l }) => (
            <View style={[ui.row, { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 12 }]}>
              <Thumb uri={l.imageUrl} title={l.title} size={compact ? 40 : 56} />
              <View style={{ flex: 1 }}>
                <Text style={[ui.text, { fontSize: 20 }]} numberOfLines={1}>
                  {l.quantity > 1 ? `${l.quantity} × ` : ""}
                  {l.title}
                </Text>
                {!!l.detail && <Text style={[ui.muted, { fontSize: 15 }]}>{l.detail}</Text>}
                <MarketBadge market={l.market} size={15} />
              </View>
              <Text style={[ui.text, { width: 130, textAlign: "right", fontSize: 20 }]}>{formatCents(l.cashCents)}</Text>
              {dual && <Text style={[ui.text, { width: 130, textAlign: "right", fontSize: 20 }]}>{formatCents(l.cardCents)}</Text>}
            </View>
          )}
        />
      </View>

      <View style={{ flex: compact ? 0 : 2, gap: compact ? 8 : 16 }}>
        {d.customer && (
          <View style={ui.panel}>
            <Text style={[ui.text, { fontSize: 20 }]}>Hi, {d.customer.name.split(" ")[0]}!</Text>
            {!!d.customer.points && <Text style={ui.muted}>{d.customer.points.toLocaleString()} points</Text>}
            {!!d.customer.rewardsCents && <Text style={ui.muted}>{formatCents(d.customer.rewardsCents)} in rewards</Text>}
            {d.earn && <Text style={[ui.text, { color: colors.good }]}>This purchase earns {d.earn}</Text>}
          </View>
        )}
        <View style={[ui.panel, { gap: 6 }]}>
          <Pair label="Subtotal" cash={d.cash.subtotalCents} card={d.card.subtotalCents} dual={dual} />
          {d.cash.discountCents > 0 && <Pair label="You save" cash={-d.cash.discountCents} card={-d.card.discountCents} dual={dual} />}
          {d.promotions?.map((p, i) => (
            <Text key={i} style={[ui.text, { color: colors.good, fontSize: 16 }]}>
              ✓ {p.name}
            </Text>
          ))}
          <Pair label="Tax" cash={d.cash.taxCents} card={d.card.taxCents} dual={dual} />
        </View>
        {dual ? (
          <View style={{ flexDirection: "row", gap: 16 }}>
            <Big label="Pay with cash" cents={d.due ? d.due.cashCents : d.cash.totalCents} color={colors.good} />
            <Big label="Pay with card" cents={d.due ? d.due.cardCents : d.card.totalCents} color={colors.accent} />
          </View>
        ) : (
          <Big label={d.due ? "Amount due" : "Total"} cents={d.due ? d.due.cashCents : d.cash.totalCents} color={colors.accent} />
        )}
        {dual && <Text style={[ui.muted, { textAlign: "center", fontSize: 15 }]}>Card prices are {d.cardPercent} higher than cash prices.</Text>}
        {d.state === "PAYING" && <Text style={[ui.h2, { textAlign: "center" }]}>Please follow the prompts on the card reader.</Text>}
      </View>
    </View>
  );
}

function Pair({ label, cash, card, dual }: { label: string; cash: number; card: number; dual: boolean }) {
  return (
    <View style={ui.row}>
      <Text style={[ui.muted, { flex: 1, fontSize: 17 }]}>{label}</Text>
      <Text style={[ui.text, { width: 110, textAlign: "right", fontSize: 17 }]}>{formatCents(cash)}</Text>
      {dual && <Text style={[ui.text, { width: 110, textAlign: "right", fontSize: 17 }]}>{formatCents(card)}</Text>}
    </View>
  );
}

function Big({ label, cents, color }: { label: string; cents: number; color: string }) {
  return (
    <View style={[ui.panel, { flex: 1, alignItems: "center", borderColor: color, borderWidth: 2 }]}>
      <Text style={[ui.muted, { fontSize: 17 }]}>{label}</Text>
      <Text style={[ui.h1, { fontSize: 40, color }]}>{formatCents(cents)}</Text>
    </View>
  );
}
