import { cardAmountDue, cardPrice, dualTotals, formatBps, formatCents, isCardPriced, type DualTotals, type TenderInput } from "@mypos/shared";
import * as Crypto from "expo-crypto";
import * as Print from "expo-print";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, apiText, type Customer, type LoyaltyProgram, type LoyaltyQuote, type Product, type Variant } from "../api";
import { Button } from "../components/Button";
import { CustomerPicker } from "../components/CustomerPicker";
import { NumberPrompt } from "../components/NumberPrompt";
import { DiscountSheet, type AppliedDiscount } from "../components/DiscountSheet";
import { MarketBadge } from "../components/MarketBadge";
import { NotPermitted, useAskApproval, useGuard } from "../approval";
import { SplitPane } from "../components/SplitPane";
import { useLayout } from "../layout";
import { imageOf, ProductSearch, variantLabel } from "../components/ProductSearch";
import { Thumb } from "../components/Thumb";
import { RewardsPicker } from "../components/RewardsPicker";
import { TerminalPicker, useTerminal } from "../components/TerminalPicker";
import { displayChannel, publishDisplay } from "../display";
import { useCan, useSession } from "../session";
import { colors, ui } from "../theme";

interface Line {
  product: Product;
  variant: Variant;
  quantity: number;
  discountCents: number;
  discountPresetId?: string;
  discountReasonId?: string;
  discountReason?: string;
  discountNote?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function SellScreen() {
  const { location, permissions } = useSession();
  const can = useCan();
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [tendering, setTendering] = useState(false);
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [rewardIds, setRewardIds] = useState<string[]>([]);
  const [pickingRewards, setPickingRewards] = useState(false);
  const [quote, setQuote] = useState<LoyaltyQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  /** A line, or "cart" for a whole-cart discount. */
  const [discounting, setDiscounting] = useState<Line | "cart" | null>(null);
  /** Manager approval for this cart's discounts, sent with the sale. */
  const [discountApproval, setDiscountApproval] = useState<string | null>(null);
  const guard = useGuard();
  const askApproval = useAskApproval();
  const [notice, setNotice] = useState<string | null>(null);
  const [showCart, setShowCart] = useState(false);
  const [drawerMsg, setDrawerMsg] = useState<string | null>(null);

  useEffect(() => {
    api<LoyaltyProgram>("GET", "/loyalty/program")
      .then(setProgram)
      .catch(() => setProgram(null));
  }, []);

  const bps = location.cardPriceBps;
  const localTotals = useMemo(
    () =>
      dualTotals(
        lines.map((l) => ({
          unitPriceCents: l.variant.priceCents,
          quantity: l.quantity,
          discountCents: l.discountCents,
          taxable: l.variant.taxable,
        })),
        location.taxRateBps,
        bps,
      ),
    [lines, location.taxRateBps, bps],
  );
  const terminalState = useTerminal();
  const channel = displayChannel(location.id, terminalState.terminal?.id);
  const [payState, setPayState] = useState<PayState>(null);

  // The server prices every cart: automated deals (which depend on the day and
  // time), rewards, and both prices. Charge waits for a quote of this exact cart.
  const loyaltyOn = !!program?.enabled && !!customer;
  const cartLines = lines.map((l) => ({
    variantId: l.variant.id,
    quantity: l.quantity,
    discountCents: l.discountCents,
    discountPresetId: l.discountPresetId,
    discountReasonId: l.discountReasonId,
    discountNote: l.discountNote,
  }));
  const signature = JSON.stringify([cartLines, rewardIds, customer?.id ?? null]);
  const [quoteSig, setQuoteSig] = useState<string | null>(null);
  useEffect(() => {
    if (lines.length === 0) {
      setQuote(null);
      setQuoteError(null);
      setQuoteSig(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api<LoyaltyQuote>("POST", "/cart/quote", { locationId: location.id, customerId: customer?.id, lines: cartLines, rewardIds })
        .then((q) => live && (setQuote(q), setQuoteError(null), setQuoteSig(signature)))
        .catch((e) => live && (setQuote(null), setQuoteSig(null), setQuoteError(e instanceof ApiError ? e.message : String(e))));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [signature, location.id]);

  const fresh = quote && quoteSig === signature ? quote : null;
  const dual: DualTotals = useMemo(() => (fresh ? { cash: fresh, card: fresh.card } : localTotals), [fresh, localTotals]);
  const totals = dual.cash;
  const quoteReady = !!fresh && !quoteError;
  /** Discount on a cart line, including deals, once priced by the server. */
  const lineDiscount = (i: number) => fresh?.lines[i]?.discountCents ?? lines[i]!.discountCents;

  function add(product: Product, variant: Variant) {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.variant.id === variant.id);
      if (i >= 0 && !variant.serialized) return prev.map((l, j) => (j === i ? { ...l, quantity: l.quantity + 1 } : l));
      if (i >= 0) return prev;
      return [...prev, { product, variant, quantity: 1, discountCents: 0 }];
    });
  }

  /** Run a guarded action; show why if it isn't allowed. */
  async function guarded(fn: () => Promise<unknown>) {
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice(e instanceof NotPermitted || e instanceof ApiError ? e.message : String(e));
    }
  }

  const noSale = () =>
    guarded(async () => {
      if (!terminalState.terminal) return setDrawerMsg("Pick this register's terminal first");
      const r = await guard("NO_SALE", (t) => api("POST", `/terminals/${terminalState.terminal!.id}/drawer`, undefined, { approvalToken: t }));
      if (r) setDrawerMsg("Drawer opened");
    });

  const itemsFor = (ls: { line: Line; quantity: number }[]) =>
    ls.map(({ line, quantity }) => ({ variantId: line.variant.id, title: line.product.title, quantity, priceCents: line.variant.priceCents }));

  /** Removing items is a void: checked against permissions and logged. */
  const setQty = (id: string, q: number) =>
    guarded(async () => {
      const line = lines.find((l) => l.variant.id === id);
      if (!line) return;
      if (q < line.quantity) {
        const ok = await guard("LINE_VOID", (t) =>
          api(
            "POST",
            "/audit/cart",
            { action: "LINE_VOID", locationId: location.id, items: itemsFor([{ line, quantity: line.quantity - q }]) },
            { approvalToken: t },
          ),
        );
        if (!ok) return;
      }
      setLines((prev) => (q <= 0 ? prev.filter((l) => l.variant.id !== id) : prev.map((l) => (l.variant.id === id ? { ...l, quantity: q } : l))));
    });

  const discount = (line: Line) => setDiscounting(line);

  /** Apply a manual discount; ask a manager first if it's over this employee's limit. */
  async function applyDiscount(targets: Line[], d: AppliedDiscount) {
    const level = can("DISCOUNT_LINE");
    if (level === "PIN" || d.maxBps > permissions.discountMaxBps) {
      const perms: ("DISCOUNT_LINE" | "DISCOUNT_CUSTOM")[] = ["DISCOUNT_LINE"];
      if (!d.presetId && can("DISCOUNT_CUSTOM") === "PIN") perms.push("DISCOUNT_CUSTOM");
      const token = await askApproval({ permissions: perms, discountBps: d.maxBps });
      if (!token) return;
      setDiscountApproval(token);
    } else if (!d.presetId && can("DISCOUNT_CUSTOM") === "PIN") {
      const token = await askApproval({ permissions: ["DISCOUNT_CUSTOM"] });
      if (!token) return;
      setDiscountApproval(token);
    }
    const byId = new Map(targets.map((t, i) => [t.variant.id, d.amounts[i]!]));
    setLines((prev) =>
      prev.map((l) =>
        byId.has(l.variant.id)
          ? {
              ...l,
              discountCents: byId.get(l.variant.id)!,
              discountPresetId: d.presetId,
              discountReasonId: d.reasonId,
              discountReason: d.reasonName,
              discountNote: d.note,
            }
          : l,
      ),
    );
  }

  const removeDiscount = (target: Line) =>
    setLines((prev) =>
      prev.map((l) =>
        l.variant.id === target.variant.id
          ? { ...l, discountCents: 0, discountPresetId: undefined, discountReasonId: undefined, discountReason: undefined, discountNote: undefined }
          : l,
      ),
    );

  /** Deleting the cart is checked against permissions and logged. */
  const clearCart = () =>
    guarded(async () => {
      const ok = await guard("CART_CLEAR", (t) =>
        api(
          "POST",
          "/audit/cart",
          { action: "CART_CLEAR", locationId: location.id, items: itemsFor(lines.map((line) => ({ line, quantity: line.quantity }))) },
          { approvalToken: t },
        ),
      );
      if (ok) reset();
    });

  function reset() {
    setLines([]);
    setCustomer(null);
    setRewardIds([]);
    setTendering(false);
    setPayState(null);
    setDiscountApproval(null);
  }

  // Mirror the sale to the customer-facing display.
  useEffect(() => {
    if (payState?.done) {
      publishDisplay(channel, {
        state: "DONE",
        storeName: location.name,
        totalCents: payState.done.totalCents,
        changeCents: payState.done.changeCents,
      });
      return;
    }
    if (lines.length === 0) {
      publishDisplay(channel, { state: "IDLE", storeName: location.name });
      return;
    }
    publishDisplay(channel, {
      state: tendering ? "PAYING" : "CART",
      storeName: location.name,
      cardPercent: bps > 0 ? formatBps(bps) : null,
      lines: lines.map((l, i) => ({
        title: l.product.title,
        detail: variantLabel(l.variant),
        imageUrl: imageOf(l.product, l.variant),
        market: l.variant.market?.marketCents != null ? l.variant.market : null,
        quantity: l.quantity,
        cashCents: l.variant.priceCents * l.quantity - lineDiscount(i),
        cardCents: cardPrice(l.variant.priceCents, bps) * l.quantity - (lineDiscount(i) ? cardPrice(lineDiscount(i), bps) : 0),
      })),
      promotions: fresh?.promotions.map((p) => ({ name: p.name, discountCents: p.discountCents })) ?? [],
      cash: dual.cash,
      card: dual.card,
      due: tendering && payState?.due ? payState.due : undefined,
      customer: customer ? { name: customer.name, points: customer.loyalty?.points, rewardsCents: customer.loyalty?.rewardsCents } : null,
      earn:
        quote?.earn && quote.earn.amount > 0
          ? quote.earn.unit === "POINTS"
            ? `${quote.earn.amount.toLocaleString()} points`
            : `${formatCents(quote.earn.amount)} rewards`
          : null,
    });
  }, [channel, lines, dual, tendering, payState, customer, fresh, bps, location.name]);

  const cartCount = lines.reduce((a, l) => a + l.quantity, 0);
  return (
    <View style={{ flex: 1 }}>
      <SplitPane
        showRight={showCart}
        onToggle={setShowCart}
        rightLabel={`Cart (${cartCount})${cartCount ? ` · ${formatCents(dual.cash.totalCents)}` : ""}`}
        left={<ProductSearch onPick={add} />}
        right={
          <>
            <CustomerPicker
              customer={customer}
              onChange={(c) => {
                setCustomer(c);
                setRewardIds([]);
              }}
            />
            {loyaltyOn && program!.type === "POINTS" && (
              <Button
                title={rewardIds.length ? `${rewardIds.length} reward(s) applied` : "Redeem points"}
                kind="secondary"
                onPress={() => setPickingRewards(true)}
              />
            )}
            <FlatList
              style={{ flex: 1 }}
              data={lines}
              keyExtractor={(l) => l.variant.id}
              ListEmptyComponent={<Text style={[ui.muted, { textAlign: "center", marginTop: 40 }]}>Scan or search to add items</Text>}
              renderItem={({ item: l, index }) => (
                <View style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", gap: 10 }}>
                  <Thumb uri={imageOf(l.product, l.variant)} title={l.product.title} />
                  <View style={{ flex: 1 }}>
                    <View style={[ui.row, { justifyContent: "space-between" }]}>
                      <Text style={[ui.text, { flex: 1 }]} numberOfLines={1}>
                        {l.product.title}
                      </Text>
                      <Text style={ui.text}>{formatCents(l.variant.priceCents * l.quantity - lineDiscount(index))}</Text>
                    </View>
                    {bps > 0 && (
                      <Text style={[ui.muted, { textAlign: "right" }]}>
                        Card{" "}
                        {formatCents(
                          cardPrice(l.variant.priceCents, bps) * l.quantity - (lineDiscount(index) ? cardPrice(lineDiscount(index), bps) : 0),
                        )}
                      </Text>
                    )}
                    {!!fresh?.lines[index]?.promoDiscountCents && (
                      <Text style={[ui.muted, { color: colors.good, textAlign: "right" }]}>
                        Deal −{formatCents(fresh.lines[index]!.promoDiscountCents)}
                      </Text>
                    )}
                    <Text style={ui.muted}>{variantLabel(l.variant)}</Text>
                    <MarketBadge market={l.variant.market} />
                    <View style={[ui.row, { gap: 8, marginTop: 6 }]}>
                      <Button
                        title="−"
                        kind="secondary"
                        onPress={() => setQty(l.variant.id, l.quantity - 1)}
                        style={{ minHeight: 36, paddingVertical: 6 }}
                      />
                      <Text style={ui.text}>{l.quantity}</Text>
                      <Button
                        title="+"
                        kind="secondary"
                        disabled={l.variant.serialized}
                        onPress={() => setQty(l.variant.id, l.quantity + 1)}
                        style={{ minHeight: 36, paddingVertical: 6 }}
                      />
                      {can("DISCOUNT_LINE") !== "DENY" && (
                        <Pressable onPress={() => discount(l)}>
                          <Text style={[ui.muted, { marginLeft: 8 }]}>{l.discountCents ? `−${formatCents(l.discountCents)}` : "Discount"}</Text>
                        </Pressable>
                      )}
                    </View>
                    {!!l.discountReason && (
                      <Text style={ui.muted}>
                        {l.discountReason}
                        {l.discountNote ? `: ${l.discountNote}` : ""}
                      </Text>
                    )}
                  </View>
                </View>
              )}
            />
            <View style={{ gap: 4 }}>
              <Row label="Subtotal" value={totals.subtotalCents} />
              {totals.discountCents > 0 && <Row label={rewardIds.length ? "Discounts & rewards" : "Discounts"} value={-totals.discountCents} />}
              {fresh?.promotions.map((p) => (
                <View key={p.promotionId} style={[ui.row, { justifyContent: "space-between" }]}>
                  <Text style={[ui.muted, { color: colors.good }]}> {p.name}</Text>
                  <Text style={[ui.muted, { color: colors.good }]}>−{formatCents(p.discountCents)}</Text>
                </View>
              ))}
              <Row label={`Tax (${(location.taxRateBps / 100).toFixed(2)}%)`} value={totals.taxCents} />
              {bps > 0 ? (
                <>
                  <Row label="Cash price" value={dual.cash.totalCents} big />
                  <Row label={`Card price (+${formatBps(bps)})`} value={dual.card.totalCents} big />
                </>
              ) : (
                <Row label="Total" value={totals.totalCents} big />
              )}
              {quote?.earn && quote.earn.amount > 0 && (
                <Text style={[ui.muted, { color: colors.good }]}>
                  Earns {quote.earn.unit === "POINTS" ? `${quote.earn.amount.toLocaleString()} pts` : `${formatCents(quote.earn.amount)} rewards`}
                </Text>
              )}
              {quoteError && <Text style={ui.error}>{quoteError}</Text>}
            </View>
            {notice && <Text style={ui.error}>{notice}</Text>}
            <View style={[ui.row, { gap: 8 }]}>
              <Button title="Clear" kind="secondary" onPress={clearCart} disabled={!lines.length || can("CART_CLEAR") === "DENY"} />
              {can("DISCOUNT_LINE") !== "DENY" && (
                <Button title="% Cart" kind="secondary" onPress={() => setDiscounting("cart")} disabled={!lines.length} />
              )}
              <Button title="Charge" kind="good" onPress={() => setTendering(true)} disabled={!lines.length || !quoteReady} style={{ flex: 1 }} />
            </View>
            {can("NO_SALE") !== "DENY" && (
              <Pressable onPress={noSale}>
                <Text style={ui.muted}>
                  No sale (open drawer){can("NO_SALE") === "PIN" ? " · needs PIN" : ""}
                  {drawerMsg ? ` · ${drawerMsg}` : ""}
                </Text>
              </Pressable>
            )}
          </>
        }
      />

      {discounting && (
        <DiscountSheet
          title={discounting === "cart" ? "Discount the whole cart" : `Discount: ${discounting.product.title}`}
          grosses={(discounting === "cart" ? lines : [discounting]).map((l) => l.variant.priceCents * l.quantity)}
          onApply={(d) => applyDiscount(discounting === "cart" ? lines : [discounting], d)}
          onRemove={discounting !== "cart" && discounting.discountCents > 0 ? () => removeDiscount(discounting) : undefined}
          onClose={() => setDiscounting(null)}
        />
      )}

      {pickingRewards && customer && (
        <RewardsPicker points={customer.loyalty?.points ?? 0} selected={rewardIds} onChange={setRewardIds} onClose={() => setPickingRewards(false)} />
      )}

      {tendering && (
        <TenderSheet
          dual={dual}
          bps={bps}
          cardPricedTenders={location.cardPricedTenders ?? []}
          terminalState={terminalState}
          onState={setPayState}
          customer={customer}
          onCancel={() => setTendering(false)}
          submit={async (tenders, idempotencyKey) => {
            const body = { locationId: location.id, customerId: customer?.id, lines: cartLines, tenders, idempotencyKey, rewardIds };
            try {
              return await api("POST", "/orders/checkout", body, { approvalToken: discountApproval });
            } catch (e) {
              // Approval expired or settings changed: ask once more, then retry the same sale.
              if (!(e instanceof ApiError) || e.code !== "APPROVAL_REQUIRED") throw e;
              const d = (e.details ?? {}) as { permission?: never; permissions?: never[]; discountBps?: number };
              const token = await askApproval({ permissions: d.permissions ?? [d.permission!], discountBps: d.discountBps });
              if (!token) throw e;
              setDiscountApproval(token);
              return api("POST", "/orders/checkout", body, { approvalToken: token });
            }
          }}
          onDone={reset}
        />
      )}
    </View>
  );
}

function Row({ label, value, big }: { label: string; value: number; big?: boolean }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between" }]}>
      <Text style={big ? ui.h1 : ui.muted}>{label}</Text>
      <Text style={big ? ui.h1 : ui.text}>{formatCents(value)}</Text>
    </View>
  );
}

type PayState = null | { due?: { cashCents: number; cardCents: number }; done?: { totalCents: number; changeCents: number } };

function TenderSheet(props: {
  dual: DualTotals;
  bps: number;
  cardPricedTenders: string[];
  terminalState: ReturnType<typeof useTerminal>;
  onState: (s: PayState) => void;
  customer: Customer | null;
  onCancel: () => void;
  submit: (
    tenders: TenderInput[],
    idempotencyKey: string,
  ) => Promise<{ order: { id: string; number: number; totalCents: number; cardAdjustmentCents: number }; changeCents: number }>;
  onDone: () => void;
}) {
  // One key per sale attempt: network retries reuse it so the card is never
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
  const [receipt, setReceipt] = useState<{ id: string; number: number; changeCents: number } | null>(null);
  const [printMsg, setPrintMsg] = useState<string | null>(null);

  // Dual pricing: cash-priced tenders pay down the cash total; a card covers
  // whatever is left at the card price.
  // Which tenders pay the card price is a store setting (cards always do).
  const priced = (type: TenderInput["type"]) => isCardPriced(type, props.cardPricedTenders);
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

  useEffect(() => {
    if (!receipt) props.onState({ due: { cashCents: cashDue, cardCents: hasCard ? 0 : cardDue } });
  }, [cashDue, cardDue, hasCard, receipt]);
  const credit = props.customer?.storeCreditCents ?? 0;
  const creditUsed = tenders.filter((t) => t.type === "STORE_CREDIT").reduce((a, t) => a + t.amountCents, 0);
  const rewards = props.customer?.loyalty?.rewardsCents ?? 0;
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
          setReceipt({ id: r.order.id, number: r.order.number, changeCents: r.changeCents });
          props.onState({ done: { totalCents: r.order.totalCents + r.order.cardAdjustmentCents, changeCents: r.changeCents } });
          // Cash sales: print the receipt and pop the drawer for change.
          if (terminal?.receiptPrinterHost && tenders.some((t) => t.type === "CASH")) {
            api("POST", `/orders/${r.order.id}/receipt/print`, { terminalId: terminal.id, target: "printer", openDrawer: true })
              .then(() => setPrintMsg("Receipt printed · drawer open"))
              .catch((e) => setPrintMsg(e instanceof ApiError ? `Printer: ${e.message}` : String(e)));
          }
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
      setError(e instanceof ApiError ? e.message : String(e));
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
      <View style={{ flex: 1, backgroundColor: "#000b", justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: dialog(560), maxHeight: "90%", flexGrow: 0 }]} contentContainerStyle={{ gap: 12 }}>
          {receipt ? (
            <>
              <Text style={ui.h1}>Sale #{receipt.number} complete</Text>
              {receipt.changeCents > 0 && (
                <Text style={[ui.h1, { color: colors.good, fontSize: 40 }]}>Change {formatCents(receipt.changeCents)}</Text>
              )}
              <View style={[ui.row, { gap: 8 }]}>
                {terminal && (
                  <Button
                    title={terminal.receiptPrinterHost ? "Print receipt" : "Print on terminal"}
                    kind="secondary"
                    style={{ flex: 1 }}
                    onPress={async () => {
                      try {
                        const r = await api<{ on: string }>("POST", `/orders/${receipt.id}/receipt/print`, { terminalId: terminal.id });
                        setPrintMsg(r.on === "printer" ? "Printing" : "Printing on the terminal");
                      } catch (e) {
                        setPrintMsg(e instanceof ApiError ? e.message : String(e));
                      }
                    }}
                  />
                )}
                <Button
                  title={terminal ? "Other printer…" : "Print receipt"}
                  kind="secondary"
                  style={{ flex: 1 }}
                  onPress={async () => {
                    try {
                      // System print dialog: AirPrint on iPad, Android's print service on Android.
                      await Print.printAsync({ html: await apiText("GET", `/orders/${receipt.id}/receipt?format=html`) });
                    } catch (e) {
                      setPrintMsg(e instanceof Error ? e.message : String(e));
                    }
                  }}
                />
              </View>
              {printMsg && <Text style={ui.muted}>{printMsg}</Text>}
              <Button title="New sale" kind="good" onPress={props.onDone} />
            </>
          ) : (
            <>
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
                  {!hasCard && (
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
                    <Button title={`Card ${formatCents(cardRemaining)}`} onPress={addCard} style={{ flexGrow: 1 }} />
                    {dueFor("CHECK") > 0 && <Button title="Check" kind="secondary" onPress={() => setPrompt("CHECK")} style={{ flexGrow: 1 }} />}
                    {dueFor("GIFT_CARD") > 0 && (
                      <Button title="Gift card" kind="secondary" onPress={() => setPrompt("GIFT_CARD")} style={{ flexGrow: 1 }} />
                    )}
                    {credit - creditUsed > 0 && dueFor("STORE_CREDIT") > 0 && (
                      <Button
                        title={`Store credit (${formatCents(credit - creditUsed)})`}
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
                <Text style={[ui.h2, { color: colors.accent, textAlign: "center" }]}>
                  Tap, insert, or swipe on {terminal?.name ?? "the terminal"}
                </Text>
              )}
              {error && <Text style={ui.error}>{error}</Text>}
              <Pressable onPress={() => setPickingTerminal(true)} disabled={busy}>
                <Text style={ui.muted}>Terminal: {terminal ? terminal.name : "none selected"} · change</Text>
              </Pressable>
              <View style={[ui.row, { gap: 8 }]}>
                <Button title="Back" kind="secondary" onPress={props.onCancel} disabled={busy} />
                <Button title="Complete sale" kind="good" onPress={complete} disabled={!ready} busy={busy} style={{ flex: 1 }} />
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
