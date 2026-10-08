import { cardAmountDue, cardPrice, formatCents, isCardPriced, PERMISSIONS, type DualTotals, type Permission, type TenderInput } from "@mypos/shared";
import * as Crypto from "expo-crypto";
import { useEffect, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, type Customer } from "../api";
import { useLayout } from "../layout";
import { useCan } from "../session";
import { colors, ui } from "../theme";
import { Button } from "./Button";
import { NumberPrompt } from "./NumberPrompt";
import { TerminalPicker, useTerminal } from "./TerminalPicker";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What's still owed, at each price (for the customer display). */
export interface Due {
  cashCents: number;
  cardCents: number;
}

/** Totals for a plain amount (a deposit, a payment on a balance): the card price on top, no tax breakdown. */
export function amountTotals(cents: number, bps: number): DualTotals {
  const cash = { subtotalCents: cents, discountCents: 0, taxCents: 0, totalCents: cents };
  return { cash, card: bps > 0 ? { ...cash, totalCents: cardPrice(cents, bps) } : cash };
}

/** The server refused for a permission this employee doesn't have: say which. */
export function deniedMessage(e: ApiError): string {
  const p = (e.details as { permission?: Permission } | undefined)?.permission;
  const what = p && PERMISSIONS[p] ? PERMISSIONS[p].label.toLowerCase() : "do that";
  return `You don't have permission to ${what}. Ask a manager, or change the sale.`;
}

/** Change owed on the cash handed over. */
export const changeFor = (tenders: TenderInput[]) =>
  tenders.reduce((a, t) => a + (t.type === "CASH" && t.tenderedCents ? Math.max(0, t.tenderedCents - t.amountCents) : 0), 0);

/**
 * Collects tenders for an amount due (cash with change, card on the terminal,
 * check, gift card, store credit, rewards) and sends them under one idempotency
 * key. What happens after is the caller's: `onPaid` fires once, and `done` is
 * then shown in place of the controls (the receipt) until the sheet is closed.
 */
export function TenderSheet<R>(props: {
  /** What's due, at the cash and card prices. */
  dual: DualTotals;
  bps: number;
  cardPricedTenders: string[];
  terminalState: ReturnType<typeof useTerminal>;
  customer: Customer | null;
  /** Shown above the amount due, e.g. "Deposit on layaway". */
  heading?: string;
  /** The button that sends the payment; "Complete sale" by default. */
  submitLabel?: string;
  /** Tenders that can't be used here (e.g. rewards toward a layaway). */
  exclude?: TenderInput["type"][];
  /** Mirrors what's still due to the customer display. */
  onDue?: (due: Due) => void;
  onCancel: () => void;
  submit: (tenders: TenderInput[], idempotencyKey: string) => Promise<R>;
  /** Fires once when the payment went through. */
  onPaid: (result: R, tenders: TenderInput[]) => void;
  /** Shown in place of the payment controls once paid. */
  done?: ReactNode;
}) {
  // One key per attempt: network retries reuse it so the card is never
  // double-charged. A new key is only minted after a definite failure.
  const [idempotencyKey, setIdempotencyKey] = useState(() => Crypto.randomUUID());
  const { terminals, terminal, select } = props.terminalState;
  const { dialog } = useLayout();
  const [pickingTerminal, setPickingTerminal] = useState(false);
  const [waitingOnCard, setWaitingOnCard] = useState(false);
  const [tenders, setTenders] = useState<TenderInput[]>([]);
  const [cashInput, setCashInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);

  // Dual pricing: cash-priced tenders pay down the cash total; a card covers
  // whatever is left at the card price.
  // Which tenders pay the card price is a store setting (cards always do).
  const priced = (type: TenderInput["type"]) => isCardPriced(type, props.cardPricedTenders);
  const allowed = (type: TenderInput["type"]) => !props.exclude?.includes(type);
  const cashPricedPaid = tenders.filter((t) => !priced(t.type)).reduce((a, t) => a + t.amountCents, 0);
  const cardPaid = tenders.filter((t) => priced(t.type)).reduce((a, t) => a + t.amountCents, 0);
  // Once something pays at the card price, the rest must too (cash-priced tenders go first).
  const hasCard = tenders.some((t) => priced(t.type));
  const cashDue = hasCard ? 0 : Math.max(0, props.dual.cash.totalCents - cashPricedPaid);
  const cardDue = cardAmountDue(props.dual, cashPricedPaid);
  const cardRemaining = Math.max(0, cardDue - cardPaid);
  const dueFor = (type: TenderInput["type"]) => (priced(type) ? cardRemaining : cashDue);
  const due = cashDue;
  const ready = hasCard ? cardPaid === cardDue : cashDue === 0;
  const [prompt, setPrompt] = useState<null | "CHECK" | "GIFT_CARD">(null);
  const can = useCan();
  const creditLevel = can("TENDER_STORE_CREDIT");

  useEffect(() => {
    if (!paid) props.onDue?.({ cashCents: cashDue, cardCents: hasCard ? 0 : cardDue });
  }, [cashDue, cardDue, hasCard, paid]);
  const credit = props.customer?.storeCreditCents ?? 0;
  const creditUsed = tenders.filter((t) => t.type === "STORE_CREDIT").reduce((a, t) => a + t.amountCents, 0);
  const rewards = allowed("LOYALTY") ? (props.customer?.loyalty?.rewardsCents ?? 0) : 0;
  const rewardsUsed = tenders.filter((t) => t.type === "LOYALTY").reduce((a, t) => a + t.amountCents, 0);

  const addCash = (handed: number) => {
    if (handed <= 0 || due <= 0) return;
    setTenders((t) => [...t, { type: "CASH", amountCents: Math.min(handed, due), tenderedCents: handed }]);
    setCashInput("");
  };
  const addCard = () => {
    if (due <= 0) return;
    if (terminal) return setTenders((t) => [...t, { type: "CARD", amountCents: cardRemaining, terminalId: terminal.id }]);
    // Development without a terminal: the API's mock processor approves this token.
    if (__DEV__ && terminals?.length === 0) return setTenders((t) => [...t, { type: "CARD", amountCents: cardRemaining, paymentToken: "tok_ok" }]);
    setPickingTerminal(true);
  };
  const addCredit = () => {
    const amt = Math.min(dueFor("STORE_CREDIT"), credit - creditUsed);
    if (amt > 0) setTenders((t) => [...t, { type: "STORE_CREDIT", amountCents: amt }]);
  };

  const addCheck = (reference: string) => {
    const amt = dueFor("CHECK");
    if (amt > 0) setTenders((t) => [...t, { type: "CHECK", amountCents: amt, reference }]);
  };
  const addGiftCard = async (code: string) => {
    try {
      const g = await api<{ code: string; balanceCents: number }>("GET", `/gift-cards/${encodeURIComponent(code)}`);
      const used = tenders.filter((t) => t.giftCardCode === g.code).reduce((a, t) => a + t.amountCents, 0);
      const amt = Math.min(dueFor("GIFT_CARD"), g.balanceCents - used);
      if (amt <= 0) return setError(`Gift card ${g.code} has no balance left`);
      setTenders((t) => [...t, { type: "GIFT_CARD", amountCents: amt, giftCardCode: g.code }]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  const addRewards = () => {
    const amt = Math.min(dueFor("LOYALTY"), rewards - rewardsUsed);
    if (amt > 0) setTenders((t) => [...t, { type: "LOYALTY", amountCents: amt }]);
  };

  async function complete() {
    setBusy(true);
    setError(null);
    setWaitingOnCard(tenders.some((t) => t.type === "CARD" && t.terminalId));
    try {
      // The server holds the request open while the customer pays on the
      // terminal. If our connection drops and we resubmit, it tells us the
      // first attempt is still running, so we wait instead of charging again.
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await props.submit(tenders, idempotencyKey);
          setPaid(true);
          props.onPaid(r, tenders);
          return;
        } catch (e) {
          if (e instanceof ApiError && e.code === "SALE_IN_PROGRESS" && attempt < 80) {
            await sleep(3000);
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.code === "PERMISSION_DENIED"
            ? deniedMessage(e)
            : e.code === "DRAWER_CLOSED"
              ? "Start a shift (Shift tab) before taking cash"
              : e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
      // Declines, unknown outcomes, and validation errors closed out this attempt;
      // only a network failure leaves it open to retry with the same key.
      if (!(e instanceof ApiError && e.code === "NETWORK")) setIdempotencyKey(Crypto.randomUUID());
    } finally {
      setBusy(false);
      setWaitingOnCard(false);
    }
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={props.onCancel}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: dialog(560), maxHeight: "90%", flexGrow: 0 }]} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
          {paid ? (
            props.done
          ) : (
            <>
              {props.heading && <Text style={ui.muted}>{props.heading}</Text>}
              <Text style={ui.h1}>
                {ready
                  ? "Ready to complete"
                  : props.bps > 0
                    ? `Due ${formatCents(cashDue)} cash · ${formatCents(cardDue)} card`
                    : `Due ${formatCents(cashDue)}`}
              </Text>
              {tenders.map((t, i) => (
                <View key={i} style={[ui.row, { justifyContent: "space-between" }]}>
                  <Text style={ui.text}>
                    {t.type === "LOYALTY" ? "REWARDS" : t.type.replace("_", " ")}
                    {t.type === "CHECK" && t.reference ? ` #${t.reference}` : ""}
                    {t.type === "GIFT_CARD" && t.giftCardCode ? ` ${t.giftCardCode}` : ""}
                    {t.tenderedCents && t.tenderedCents > t.amountCents ? ` (handed ${formatCents(t.tenderedCents)})` : ""}
                  </Text>
                  <Pressable onPress={() => setTenders((ts) => ts.filter((_, j) => j !== i))}>
                    <Text style={ui.text}>{formatCents(t.amountCents)} ✕</Text>
                  </Pressable>
                </View>
              ))}
              {!ready && (
                <>
                  {!hasCard && allowed("CASH") && (
                    <>
                      <Text style={ui.muted}>Cash</Text>
                      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
                        <Button title="Exact" kind="secondary" onPress={() => addCash(due)} />
                        {[2000, 5000, 10000]
                          .filter((d) => d >= due)
                          .map((d) => (
                            <Button key={d} title={formatCents(d)} kind="secondary" onPress={() => addCash(d)} />
                          ))}
                        <TextInput
                          style={[ui.input, { width: 120 }]}
                          placeholder="Other"
                          placeholderTextColor={colors.muted}
                          keyboardType="decimal-pad"
                          value={cashInput}
                          onChangeText={setCashInput}
                          onSubmitEditing={() => addCash(Math.round(Number(cashInput) * 100))}
                        />
                      </View>
                    </>
                  )}
                  <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
                    {allowed("CARD") && <Button title={`Card ${formatCents(cardRemaining)}`} onPress={addCard} style={{ flexGrow: 1 }} />}
                    {allowed("CHECK") && dueFor("CHECK") > 0 && (
                      <Button title="Check" kind="secondary" onPress={() => setPrompt("CHECK")} style={{ flexGrow: 1 }} />
                    )}
                    {allowed("GIFT_CARD") && dueFor("GIFT_CARD") > 0 && (
                      <Button title="Gift card" kind="secondary" onPress={() => setPrompt("GIFT_CARD")} style={{ flexGrow: 1 }} />
                    )}
                    {allowed("STORE_CREDIT") && creditLevel !== "DENY" && credit - creditUsed > 0 && dueFor("STORE_CREDIT") > 0 && (
                      <Button
                        title={`Store credit (${formatCents(credit - creditUsed)})${creditLevel === "PIN" ? " · PIN" : ""}`}
                        kind="secondary"
                        onPress={addCredit}
                        style={{ flexGrow: 1 }}
                      />
                    )}
                    {rewards - rewardsUsed > 0 && dueFor("LOYALTY") > 0 && (
                      <Button
                        title={`Rewards (${formatCents(rewards - rewardsUsed)})`}
                        kind="secondary"
                        onPress={addRewards}
                        style={{ flexGrow: 1 }}
                      />
                    )}
                  </View>
                  {hasCard && props.bps > 0 && <Text style={ui.muted}>The rest is at the card price. Remove card-priced payments to take cash.</Text>}
                </>
              )}
              {waitingOnCard && (
                <Text style={[ui.h2, { color: colors.link, textAlign: "center" }]}>
                  Tap, insert, or swipe on {terminal?.name ?? "the terminal"}
                </Text>
              )}
              {error && <Text style={ui.error}>{error}</Text>}
              <Pressable onPress={() => setPickingTerminal(true)} disabled={busy}>
                <Text style={ui.muted}>Terminal: {terminal ? terminal.name : "none selected"} · change</Text>
              </Pressable>
              <View style={[ui.row, { gap: 8 }]}>
                <Button title="Back" kind="secondary" onPress={props.onCancel} disabled={busy} />
                <Button title={props.submitLabel ?? "Complete sale"} kind="good" onPress={complete} disabled={!ready} busy={busy} style={{ flex: 1 }} />
              </View>
            </>
          )}
        </ScrollView>
      </View>
      {prompt && (
        <NumberPrompt
          title={prompt === "CHECK" ? "Check number" : "Gift card"}
          message={prompt === "CHECK" ? `Check for ${formatCents(dueFor("CHECK"))}` : "Scan or type the gift card code"}
          onSubmitText={(v) => (prompt === "CHECK" ? addCheck(v) : addGiftCard(v))}
          onClose={() => setPrompt(null)}
        />
      )}
      {pickingTerminal && terminals && (
        <TerminalPicker terminals={terminals} selectedId={terminal?.id} onSelect={select} onClose={() => setPickingTerminal(false)} />
      )}
    </Modal>
  );
}
