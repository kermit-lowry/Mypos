import { cardPrice, formatCents } from "@mypos/shared";
import { useState } from "react";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import { api, ApiError, type Location } from "../api";
import { Button } from "../components/Button";
import { useCan, useSession } from "../session";
import { TradeInRules } from "./TradeInRules";
import { colors, ui } from "../theme";

/** Cash drawer rules a location carries; optional so an older server still loads. */
interface DrawerSettings {
  requireDrawerSession?: boolean;
  blindCashCount?: boolean;
  cashVarianceAlertCents?: number;
}

/** Owner-only store settings: dual pricing, cash drawer rules, label printer, receipt text. */
export function StoreSettingsScreen({ onSaved }: { onSaved: (l: Location) => void }) {
  const { location } = useSession();
  const can = useCan();
  const drawer = location as Location & DrawerSettings;
  const [requireDrawer, setRequireDrawer] = useState(drawer.requireDrawerSession ?? false);
  const [blindCount, setBlindCount] = useState(drawer.blindCashCount ?? true);
  const [varianceAlert, setVarianceAlert] = useState(((drawer.cashVarianceAlertCents ?? 500) / 100).toFixed(2));
  const [dual, setDual] = useState(location.cardPriceBps > 0);
  const [percent, setPercent] = useState(location.cardPriceBps > 0 ? String(location.cardPriceBps / 100) : "3.99");
  const [printer, setPrinter] = useState(location.labelPrinterHost ?? "");
  const [header, setHeader] = useState(location.receiptHeader ?? "");
  const [footer, setFooter] = useState(location.receiptFooter ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [cardPriced, setCardPriced] = useState<string[]>(location.cardPricedTenders ?? []);

  const bps = dual ? Math.round(Number(percent) * 100) : 0;
  const alertCents = Math.round(Number(varianceAlert) * 100);
  const alertValid = varianceAlert.trim() !== "" && Number.isFinite(alertCents) && alertCents >= 0;
  const valid = (!dual || (Number.isFinite(bps) && bps > 0 && bps <= 1000)) && alertValid;

  async function save() {
    try {
      const updated = await api<Location>("PATCH", `/locations/${location.id}`, {
        cardPriceBps: bps,
        cardPricedTenders: cardPriced,
        labelPrinterHost: printer.trim() || null,
        receiptHeader: header.trim() || null,
        receiptFooter: footer.trim() || null,
        requireDrawerSession: requireDrawer,
        blindCashCount: blindCount,
        cashVarianceAlertCents: alertCents,
      });
      onSaved(updated);
      setMessage("Saved. Reprint shelf labels so they show the new prices.");
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <ScrollView style={{ flex: 1, padding: 16 }} contentContainerStyle={{ gap: 16, maxWidth: 640 }}>
      <View style={[ui.panel, { gap: 12 }]}>
        <View style={[ui.row, { justifyContent: "space-between" }]}>
          <Text style={ui.h1}>Dual pricing</Text>
          <Switch value={dual} onValueChange={setDual} />
        </View>
        <Text style={ui.muted}>
          Show a cash price and a card price on the customer display, receipts, and shelf labels. Cards always pay the card price and cash always pays
          the cash price. Choose below for everything else.
        </Text>
        {dual && (
          <>
            <View style={[ui.row, { gap: 8 }]}>
              <Text style={ui.text}>Card price is</Text>
              <TextInput style={[ui.input, { width: 100 }]} keyboardType="decimal-pad" value={percent} onChangeText={setPercent} />
              <Text style={ui.text}>% higher than cash</Text>
            </View>
            {valid ? (
              <Text style={[ui.muted, { color: colors.good }]}>
                Example: a {formatCents(1000)} item is {formatCents(1000)} cash, {formatCents(cardPrice(1000, bps))} card.
              </Text>
            ) : (
              <Text style={ui.error}>Enter a percentage between 0.01 and 10.</Text>
            )}
            <Text style={[ui.text, { marginTop: 8 }]}>These pay the card price:</Text>
            {(
              [
                ["GIFT_CARD", "Gift cards"],
                ["STORE_CREDIT", "Store credit"],
                ["CHECK", "Checks"],
                ["LOYALTY", "Rewards dollars"],
              ] as const
            ).map(([tender, label]) => (
              <View key={tender} style={[ui.row, { justifyContent: "space-between" }]}>
                <Text style={ui.text}>{label}</Text>
                <Switch
                  value={cardPriced.includes(tender)}
                  onValueChange={(on) => setCardPriced((x) => (on ? [...x, tender] : x.filter((t) => t !== tender)))}
                />
              </View>
            ))}
            <Text style={ui.muted}>Off means that tender pays the cash price.</Text>
            <Text style={ui.muted}>Check your state's rules and your card processing agreement before turning this on.</Text>
          </>
        )}
      </View>

      <View style={[ui.panel, { gap: 12 }]}>
        <Text style={ui.h2}>Cash drawer</Text>
        <View style={[ui.row, { justifyContent: "space-between", gap: 12 }]}>
          <Text style={[ui.text, { flex: 1 }]}>Cash must go into an open drawer (start a shift before cash sales)</Text>
          <Switch value={requireDrawer} onValueChange={setRequireDrawer} />
        </View>
        <Text style={ui.muted}>Off means cash sales work without a drawer session; on, the register asks for a float first so every dollar is accounted for at close.</Text>
        <View style={[ui.row, { justifyContent: "space-between", gap: 12 }]}>
          <Text style={[ui.text, { flex: 1 }]}>Blind closing count</Text>
          <Switch value={blindCount} onValueChange={setBlindCount} />
        </View>
        <Text style={ui.muted}>The expected amount stays hidden until the cashier has entered their count.</Text>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Text style={ui.text}>Alert when the count is off by more than $</Text>
          <TextInput style={[ui.input, { width: 100 }]} keyboardType="decimal-pad" value={varianceAlert} onChangeText={setVarianceAlert} />
        </View>
        {alertValid ? <Text style={ui.muted}>A bigger variance needs a manager's PIN to close the drawer, and is flagged on the daily close.</Text> : <Text style={ui.error}>Enter a dollar amount (0 flags every variance).</Text>}
      </View>

      <View style={[ui.panel, { gap: 8 }]}>
        <Text style={ui.h2}>Label printer</Text>
        <Text style={ui.muted}>Network Zebra (ZPL) printer address, e.g. 192.168.1.50 or 192.168.1.50:9100</Text>
        <TextInput style={ui.input} value={printer} onChangeText={setPrinter} autoCapitalize="none" autoCorrect={false} placeholder="Not set" placeholderTextColor={colors.muted} />
      </View>

      <View style={[ui.panel, { gap: 8 }]}>
        <Text style={ui.h2}>Receipt</Text>
        <TextInput style={ui.input} value={header} onChangeText={setHeader} placeholder="Header (address, phone)" placeholderTextColor={colors.muted} multiline />
        <TextInput style={ui.input} value={footer} onChangeText={setFooter} placeholder="Footer (return policy, socials)" placeholderTextColor={colors.muted} multiline />
      </View>

      {message && <Text style={ui.text}>{message}</Text>}
      <Button title="Save" kind="good" onPress={save} disabled={!valid} />

      {can("MANAGE_BUYLIST") !== "DENY" && <TradeInRules />}
    </ScrollView>
  );
}
