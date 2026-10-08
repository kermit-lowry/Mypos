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
/** Layaway terms a location carries; optional for the same reason. */
interface LayawaySettings {
  layawayEnabled?: boolean;
  layawayMinDepositBps?: number;
  layawayTermDays?: number;
  layawayCancelFeeCents?: number;
  layawayCancelFeeBps?: number;
}
/** Whole cents or bps from a decimal field; null when blank or not a number. */
const hundredths = (s: string) => {
  if (!s.trim()) return null;
  const n = Math.round(Number(s) * 100);
  return Number.isFinite(n) ? n : null;
};

/** Owner-only store settings: dual pricing, cash drawer rules, label printer, receipt text. */
export function StoreSettingsScreen({ onSaved }: { onSaved: (l: Location) => void }) {
  const { location } = useSession();
  const can = useCan();
  const drawer = location as Location & DrawerSettings & LayawaySettings;
  const [requireDrawer, setRequireDrawer] = useState(drawer.requireDrawerSession ?? false);
  const [blindCount, setBlindCount] = useState(drawer.blindCashCount ?? true);
  const [varianceAlert, setVarianceAlert] = useState(((drawer.cashVarianceAlertCents ?? 500) / 100).toFixed(2));
  const [layaway, setLayaway] = useState(drawer.layawayEnabled ?? true);
  const [minDeposit, setMinDeposit] = useState(String((drawer.layawayMinDepositBps ?? 2000) / 100));
  const [termDays, setTermDays] = useState(String(drawer.layawayTermDays ?? 30));
  const [cancelFee, setCancelFee] = useState(((drawer.layawayCancelFeeCents ?? 0) / 100).toFixed(2));
  const [cancelFeePct, setCancelFeePct] = useState(String((drawer.layawayCancelFeeBps ?? 0) / 100));
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
  const depositBps = hundredths(minDeposit);
  const days = Math.round(Number(termDays));
  const feeCents = hundredths(cancelFee);
  const feeBps = hundredths(cancelFeePct);
  const depositValid = depositBps != null && depositBps >= 0 && depositBps <= 10000;
  const daysValid = termDays.trim() !== "" && Number.isFinite(days) && days >= 1 && days <= 365;
  const feeValid = feeCents != null && feeCents >= 0 && feeBps != null && feeBps >= 0 && feeBps <= 10000;
  const layawayValid = !layaway || (depositValid && daysValid && feeValid);
  const valid = (!dual || (Number.isFinite(bps) && bps > 0 && bps <= 1000)) && alertValid && layawayValid;

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
        layawayEnabled: layaway,
        // Terms are kept even while layaway is off, so turning it back on restores them; invalid fields are left as they were.
        ...(depositValid ? { layawayMinDepositBps: depositBps } : {}),
        ...(daysValid ? { layawayTermDays: days } : {}),
        ...(feeValid ? { layawayCancelFeeCents: feeCents, layawayCancelFeeBps: feeBps } : {}),
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

      <View style={[ui.panel, { gap: 12 }]}>
        <View style={[ui.row, { justifyContent: "space-between" }]}>
          <Text style={ui.h2}>Layaway</Text>
          <Switch value={layaway} onValueChange={setLayaway} />
        </View>
        <Text style={ui.muted}>Hold items for a customer against a deposit and let them pay the rest over time. Prices, deals and tax lock when it opens; the stock stays reserved until pickup or cancellation.</Text>
        {layaway && (
          <>
            <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
              <Text style={ui.text}>Minimum deposit</Text>
              <TextInput style={[ui.input, { width: 90 }]} keyboardType="decimal-pad" value={minDeposit} onChangeText={setMinDeposit} />
              <Text style={ui.text}>% of the total</Text>
            </View>
            {depositValid ? <Text style={ui.muted}>{depositBps === 0 ? "No minimum: any amount opens a layaway." : `A ${formatCents(10000)} layaway needs at least ${formatCents(Math.round((10000 * depositBps) / 10000))} down.`}</Text> : <Text style={ui.error}>Enter a percentage between 0 and 100.</Text>}
            <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
              <Text style={ui.text}>Must be paid off within</Text>
              <TextInput style={[ui.input, { width: 80 }]} keyboardType="number-pad" value={termDays} onChangeText={setTermDays} />
              <Text style={ui.text}>days</Text>
            </View>
            {daysValid ? <Text style={ui.muted}>The due date is set when the layaway opens; a manager can extend it from the back office.</Text> : <Text style={ui.error}>Enter a number of days from 1 to 365.</Text>}
            <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
              <Text style={ui.text}>Cancellation fee $</Text>
              <TextInput style={[ui.input, { width: 90 }]} keyboardType="decimal-pad" value={cancelFee} onChangeText={setCancelFee} />
              <Text style={ui.text}>plus</Text>
              <TextInput style={[ui.input, { width: 80 }]} keyboardType="decimal-pad" value={cancelFeePct} onChangeText={setCancelFeePct} />
              <Text style={ui.text}>% of the total</Text>
            </View>
            {feeValid ? (
              <Text style={ui.muted}>
                {feeCents === 0 && feeBps === 0 ? "No fee: cancelling refunds everything paid." : `Kept from the payments when a layaway is cancelled (never more than was paid). On a ${formatCents(10000)} layaway: ${formatCents(Math.min(10000, feeCents + Math.round((10000 * feeBps) / 10000)))}.`} A manager can waive it.
              </Text>
            ) : (
              <Text style={ui.error}>Enter a dollar amount and a percentage from 0 to 100.</Text>
            )}
          </>
        )}
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
