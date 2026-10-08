import { applyBps, cardPrice, dualTotals, formatBps, formatCents, type CartLine, type DualTotals, type Permission } from "@mypos/shared";
import * as Print from "expo-print";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { api, ApiError, apiText, type Customer, type Layaway, type LoyaltyProgram, type LoyaltyQuote, type Product, type Variant } from "../api";
import { Button } from "../components/Button";
import { CustomerPicker } from "../components/CustomerPicker";
import { NumberPrompt } from "../components/NumberPrompt";
import { DiscountSheet, type AppliedDiscount } from "../components/DiscountSheet";
import { MarketBadge } from "../components/MarketBadge";
import { NotPermitted, useAskApproval, useGuard } from "../approval";
import { auditItems, unitPrice, useCart, useClearCart, type Line } from "../cart";
import { SplitPane } from "../components/SplitPane";
import { useLayout } from "../layout";
import { imageOf, ProductSearch, variantLabel } from "../components/ProductSearch";
import { Thumb } from "../components/Thumb";
import { RewardsPicker } from "../components/RewardsPicker";
import { amountTotals, changeFor, TenderSheet, type Due } from "../components/TenderSheet";
import { useTerminal, type Terminal } from "../components/TerminalPicker";
import { displayChannel, publishDisplay } from "../display";
import { useCan, useSession } from "../session";
import { colors, ui } from "../theme";
import { dayLabel, layawayError, PrintStatement } from "./LayawayScreen";

export function SellScreen() {
  const { location, permissions } = useSession();
  const can = useCan();
  // The cart itself lives in CartProvider: it survives tab changes and reloads.
  const { lines, setLines, customer, setCustomer, rewardIds, setRewardIds, discountApproval, setDiscountApproval, reset: resetCart } = useCart();
  const clearCartLogged = useClearCart();
  const [tendering, setTendering] = useState(false);
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [pickingRewards, setPickingRewards] = useState(false);
  const [quote, setQuote] = useState<LoyaltyQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  /** A line, or "cart" for a whole-cart discount. */
  const [discounting, setDiscounting] = useState<Line | "cart" | null>(null);
  /** The line whose price is being changed. */
  const [repricing, setRepricing] = useState<Line | null>(null);
  const guard = useGuard();
  const askApproval = useAskApproval();
  const [notice, setNotice] = useState<string | null>(null);
  const [showCart, setShowCart] = useState(false);
  const [drawerMsg, setDrawerMsg] = useState<string | null>(null);
  /** Layaway: attaching the customer it needs, or the sheet itself. */
  const [layaway, setLayaway] = useState<"customer" | "sheet" | null>(null);

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
          unitPriceCents: unitPrice(l),
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
  /** What the tender sheet still has to collect. */
  const [due, setDue] = useState<Due | null>(null);
  const [sale, setSale] = useState<SaleDone | null>(null);
  const layawayOn = location.layawayEnabled !== false && can("LAYAWAY_CREATE") !== "DENY";

  // The server prices every cart: automated deals (which depend on the day and
  // time), rewards, and both prices. Charge waits for a quote of this exact cart.
  const loyaltyOn = !!program?.enabled && !!customer;
  const cartLines = lines.map((l) => ({
    variantId: l.variant.id,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
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
            { action: "LINE_VOID", locationId: location.id, items: auditItems([{ line, quantity: line.quantity - q }]) },
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

  /** Deleting the cart is checked against permissions and logged (the same path sign-out uses). */
  const clearCart = () => guarded(clearCartLogged);

  /** Change a line's price. The sale then needs PRICE_OVERRIDE (a manager's PIN at checkout, if that's this employee's level) and is logged. */
  const setPrice = (target: Line, priceCents: number) =>
    setLines((prev) =>
      prev.map((l) => (l.variant.id === target.variant.id ? { ...l, unitPriceCents: priceCents === l.variant.priceCents ? undefined : priceCents } : l)),
    );

  function reset() {
    resetCart();
    setTendering(false);
    setLayaway(null);
    setDue(null);
    setSale(null);
  }

  /** Layaway needs a customer on the sale; attach one first if there isn't. */
  const startLayaway = () => setLayaway(customer ? "sheet" : "customer");

  // Mirror the sale to the customer-facing display.
  useEffect(() => {
    if (sale) {
      publishDisplay(channel, { state: "DONE", storeName: location.name, totalCents: sale.totalCents, changeCents: sale.changeCents });
      return;
    }
    if (lines.length === 0) {
      publishDisplay(channel, { state: "IDLE", storeName: location.name });
      return;
    }
    publishDisplay(channel, {
      state: tendering || layaway === "sheet" ? "PAYING" : "CART",
      storeName: location.name,
      cardPercent: bps > 0 ? formatBps(bps) : null,
      lines: lines.map((l, i) => ({
        title: l.product.title,
        detail: variantLabel(l.variant),
        imageUrl: imageOf(l.product, l.variant),
        market: l.variant.market?.marketCents != null ? l.variant.market : null,
        quantity: l.quantity,
        cashCents: unitPrice(l) * l.quantity - lineDiscount(i),
        cardCents: cardPrice(unitPrice(l), bps) * l.quantity - (lineDiscount(i) ? cardPrice(lineDiscount(i), bps) : 0),
      })),
      promotions: fresh?.promotions.map((p) => ({ name: p.name, discountCents: p.discountCents })) ?? [],
      cash: dual.cash,
      card: dual.card,
      due: (tendering || layaway === "sheet") && due ? due : undefined,
      customer: customer ? { name: customer.name, points: customer.loyalty?.points, rewardsCents: customer.loyalty?.rewardsCents } : null,
      earn:
        quote?.earn && quote.earn.amount > 0
          ? quote.earn.unit === "POINTS"
            ? `${quote.earn.amount.toLocaleString()} points`
            : `${formatCents(quote.earn.amount)} rewards`
          : null,
    });
  }, [channel, lines, dual, tendering, layaway, due, sale, customer, fresh, bps, location.name]);

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
                if (c) setLayaway((l) => (l === "customer" ? "sheet" : l));
              }}
              open={layaway === "customer"}
              onOpenChange={(open) => !open && setLayaway((l) => (l === "customer" ? null : l))}
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
                      <Text style={ui.text}>{formatCents(unitPrice(l) * l.quantity - lineDiscount(index))}</Text>
                    </View>
                    {l.unitPriceCents !== undefined && (
                      <Text style={[ui.muted, { textAlign: "right" }]}>
                        was <Text style={{ textDecorationLine: "line-through" }}>{formatCents(l.variant.priceCents * l.quantity)}</Text>
                      </Text>
                    )}
                    {bps > 0 && (
                      <Text style={[ui.muted, { textAlign: "right" }]}>
                        Card{" "}
                        {formatCents(
                          cardPrice(unitPrice(l), bps) * l.quantity - (lineDiscount(index) ? cardPrice(lineDiscount(index), bps) : 0),
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
                      {can("PRICE_OVERRIDE") !== "DENY" && (
                        <Pressable onPress={() => setRepricing(l)}>
                          <Text style={[ui.muted, { marginLeft: 8 }]}>
                            {l.unitPriceCents !== undefined ? `${formatCents(l.unitPriceCents)} ea` : "Price"}
                            {can("PRICE_OVERRIDE") === "PIN" ? " · PIN" : ""}
                          </Text>
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
            <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
              <Button title="Clear" kind="secondary" onPress={clearCart} disabled={!lines.length || can("CART_CLEAR") === "DENY"} />
              {can("DISCOUNT_LINE") !== "DENY" && (
                <Button title="% Cart" kind="secondary" onPress={() => setDiscounting("cart")} disabled={!lines.length} />
              )}
              {layawayOn && <Button title="Layaway" kind="secondary" onPress={startLayaway} disabled={!lines.length || !quoteReady} />}
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
          grosses={(discounting === "cart" ? lines : [discounting]).map((l) => unitPrice(l) * l.quantity)}
          onApply={(d) => applyDiscount(discounting === "cart" ? lines : [discounting], d)}
          onRemove={discounting !== "cart" && discounting.discountCents > 0 ? () => removeDiscount(discounting) : undefined}
          onClose={() => setDiscounting(null)}
        />
      )}

      {repricing && (
        <NumberPrompt
          title="Change price"
          message={`${repricing.product.title} · list price ${formatCents(repricing.variant.priceCents)}${
            can("PRICE_OVERRIDE") === "PIN" ? " · needs a manager's PIN at checkout" : ""
          }`}
          initial={(unitPrice(repricing) / 100).toFixed(2)}
          onSubmit={(n) => setPrice(repricing, Math.round(n * 100))}
          onClose={() => setRepricing(null)}
        />
      )}

      {pickingRewards && customer && (
        <RewardsPicker points={customer.loyalty?.points ?? 0} selected={rewardIds} onChange={setRewardIds} onClose={() => setPickingRewards(false)} />
      )}

      {tendering && (
        <TenderSheet<{ order: { id: string; number: number; totalCents: number; cardAdjustmentCents: number }; changeCents: number }>
          dual={dual}
          bps={bps}
          cardPricedTenders={location.cardPricedTenders ?? []}
          terminalState={terminalState}
          customer={customer}
          onDue={setDue}
          onCancel={() => setTendering(false)}
          submit={async (tenders, idempotencyKey) => {
            // The register's terminal id puts cash into this register's drawer session.
            const body = { locationId: location.id, customerId: customer?.id, lines: cartLines, tenders, idempotencyKey, rewardIds, terminalId: terminalState.terminal?.id };
            try {
              return await api("POST", "/orders/checkout", body, { approvalToken: discountApproval });
            } catch (e) {
              // Approval expired or settings changed: ask once more, then retry the same sale.
              if (!(e instanceof ApiError) || e.code !== "APPROVAL_REQUIRED") throw e;
              // The server lists every permission the sale still needs (discounts, price changes,
              // store credit), so one PIN covers all of them.
              const d = (e.details ?? {}) as { permission?: Permission; permissions?: Permission[]; discountBps?: number };
              const token = await askApproval({ permissions: d.permissions ?? [d.permission!], discountBps: d.discountBps });
              if (!token) throw e;
              setDiscountApproval(token);
              return api("POST", "/orders/checkout", body, { approvalToken: token });
            }
          }}
          onPaid={(r, tenders) =>
            setSale({
              id: r.order.id,
              number: r.order.number,
              totalCents: r.order.totalCents + r.order.cardAdjustmentCents,
              changeCents: r.changeCents,
              cash: tenders.some((t) => t.type === "CASH"),
            })
          }
          done={sale && <SaleReceipt sale={sale} terminal={terminalState.terminal} onDone={reset} />}
        />
      )}

      {layaway === "sheet" && customer && (
        <LayawaySheet
          lines={lines}
          lineDiscount={lineDiscount}
          totalCents={dual.cash.totalCents}
          cartLines={cartLines}
          customer={customer}
          terminalState={terminalState}
          onDue={setDue}
          onCancel={() => setLayaway(null)}
          onDone={reset}
        />
      )}
    </View>
  );
}

function Row({ label, value, big }: { label: string; value: number | string; big?: boolean }) {
  return (
    <View style={[ui.row, { justifyContent: "space-between" }]}>
      <Text style={big ? ui.h1 : ui.muted}>{label}</Text>
      <Text style={big ? ui.h1 : ui.text}>{typeof value === "number" ? formatCents(value) : value}</Text>
    </View>
  );
}

interface SaleDone {
  id: string;
  number: number;
  /** What the customer paid, card adjustments included. */
  totalCents: number;
  changeCents: number;
  cash: boolean;
}

/** After a sale: the change, the receipt, and on to the next customer. */
function SaleReceipt({ sale, terminal, onDone }: { sale: SaleDone; terminal: Terminal | null; onDone: () => void }) {
  const [printMsg, setPrintMsg] = useState<string | null>(null);

  // Cash sales: print the receipt and pop the drawer for change.
  useEffect(() => {
    if (!sale.cash || !terminal?.receiptPrinterHost) return;
    api("POST", `/orders/${sale.id}/receipt/print`, { terminalId: terminal.id, target: "printer", openDrawer: true })
      .then(() => setPrintMsg("Receipt printed · drawer open"))
      .catch((e) => setPrintMsg(e instanceof ApiError ? `Printer: ${e.message}` : String(e)));
  }, [sale.id]);

  return (
    <>
      <Text style={ui.h1}>Sale #{sale.number} complete</Text>
      {sale.changeCents > 0 && <Text style={[ui.h1, { color: colors.good, fontSize: 40 }]}>Change {formatCents(sale.changeCents)}</Text>}
      <View style={[ui.row, { gap: 8 }]}>
        {terminal && (
          <Button
            title={terminal.receiptPrinterHost ? "Print receipt" : "Print on terminal"}
            kind="secondary"
            style={{ flex: 1 }}
            onPress={async () => {
              try {
                const r = await api<{ on: string }>("POST", `/orders/${sale.id}/receipt/print`, { terminalId: terminal.id });
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
              await Print.printAsync({ html: await apiText("GET", `/orders/${sale.id}/receipt?format=html`) });
            } catch (e) {
              setPrintMsg(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      </View>
      {printMsg && <Text style={ui.muted}>{printMsg}</Text>}
      <Button title="New sale" kind="good" onPress={onDone} />
    </>
  );
}

// ─── Layaway ─────────────────────────────────────────────────────

const DAY = 86_400_000;
/** "2026-10-08" in local time, for the due-date field. */
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** End of that day, local time; undefined unless it's a real YYYY-MM-DD. */
function parseDay(s: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T23:59:59`);
  return Number.isNaN(d.getTime()) || localDay(d) !== s ? undefined : d;
}
const cents = (t: string) => {
  const n = Math.round(Number(t) * 100);
  return t.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
};

interface LayawayOpened {
  layaway: Layaway;
  changeCents: number;
  cash: boolean;
}

/**
 * Put the cart on layaway for the attached customer: the items at today's
 * prices, a deposit (at least the store's minimum), a due date and notes.
 * The deposit is taken like any other payment, then the cart is done.
 */
function LayawaySheet(props: {
  lines: Line[];
  lineDiscount: (i: number) => number;
  /** The cart's cash-price total, as the server quoted it. */
  totalCents: number;
  cartLines: CartLine[];
  customer: Customer;
  terminalState: ReturnType<typeof useTerminal>;
  onDue: (d: Due) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { location } = useSession();
  const guard = useGuard();
  const { dialog } = useLayout();
  const bps = location.cardPriceBps;
  const minDeposit = Math.min(props.totalCents, applyBps(props.totalCents, location.layawayMinDepositBps ?? 2000));
  const [deposit, setDeposit] = useState((minDeposit / 100).toFixed(2));
  const [dueDay, setDueDay] = useState(localDay(new Date(Date.now() + (location.layawayTermDays ?? 30) * DAY)));
  const [notes, setNotes] = useState("");
  const [tendering, setTendering] = useState(false);
  const [opened, setOpened] = useState<LayawayOpened | null>(null);

  const depositCents = cents(deposit);
  const dueAt = parseDay(dueDay);
  const problem =
    depositCents === undefined
      ? "Enter the deposit"
      : depositCents < minDeposit
        ? `The minimum deposit is ${formatCents(minDeposit)}`
        : depositCents > props.totalCents
          ? `The deposit can't be more than the ${formatCents(props.totalCents)} total`
          : !dueAt
            ? "Due date as YYYY-MM-DD"
            : dueAt.getTime() < Date.now()
              ? "The due date is in the past"
              : null;

  return (
    <Modal transparent animationType="fade" onRequestClose={props.onCancel}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: dialog(560), maxHeight: "90%", flexGrow: 0 }]} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
          <Text style={ui.h1}>Layaway for {props.customer.name}</Text>
          <Text style={ui.muted}>Today's prices and deals are locked in; the items are held until the balance is paid.</Text>
          <View>
            {props.lines.map((l, i) => (
              <View key={l.variant.id} style={[ui.row, { justifyContent: "space-between", gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
                <Text style={[ui.text, { flex: 1 }]} numberOfLines={1}>
                  {l.quantity} × {l.product.title}
                </Text>
                <Text style={ui.text}>{formatCents(unitPrice(l) * l.quantity - props.lineDiscount(i))}</Text>
              </View>
            ))}
          </View>
          <View style={{ gap: 4 }}>
            <Row label="Total (cash price)" value={props.totalCents} big />
            <Row label={`Minimum deposit (${formatBps(location.layawayMinDepositBps ?? 2000)})`} value={minDeposit} />
          </View>
          <View style={{ gap: 6 }}>
            <Text style={ui.muted}>Deposit</Text>
            <TextInput style={[ui.input, { fontSize: 22 }]} value={deposit} onChangeText={setDeposit} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.muted} selectTextOnFocus />
            <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
              {[
                { title: "Minimum", cents: minDeposit },
                { title: "Half", cents: Math.round(props.totalCents / 2) },
                { title: "In full", cents: props.totalCents },
              ]
                .filter((d) => d.cents >= minDeposit)
                .map((d) => (
                  <Pressable key={d.title} onPress={() => setDeposit((d.cents / 100).toFixed(2))} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.panelAlt }}>
                    <Text style={ui.text}>
                      {d.title} · {formatCents(d.cents)}
                    </Text>
                  </Pressable>
                ))}
            </View>
          </View>
          <View style={{ gap: 6 }}>
            <Text style={ui.muted}>Balance due by</Text>
            <TextInput style={ui.input} value={dueDay} onChangeText={setDueDay} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} autoCorrect={false} autoCapitalize="none" />
          </View>
          <TextInput style={ui.input} value={notes} onChangeText={setNotes} placeholder="Notes (optional)" placeholderTextColor={colors.muted} />
          {problem && depositCents !== undefined && <Text style={ui.error}>{problem}</Text>}
          <View style={[ui.row, { gap: 8 }]}>
            <Button title="Back" kind="secondary" onPress={props.onCancel} />
            <Button
              title={depositCents !== undefined && !problem ? `Take deposit ${formatCents(depositCents)}` : "Take deposit"}
              kind="good"
              onPress={() => setTendering(true)}
              disabled={!!problem}
              style={{ flex: 1 }}
            />
          </View>
        </ScrollView>
      </View>

      {tendering && depositCents !== undefined && dueAt && (
        <TenderSheet<Layaway>
          dual={amountTotals(depositCents, bps)}
          bps={bps}
          cardPricedTenders={location.cardPricedTenders ?? []}
          terminalState={props.terminalState}
          customer={props.customer}
          heading={`Deposit on layaway · ${props.customer.name} · total ${formatCents(props.totalCents)}`}
          submitLabel="Take deposit"
          exclude={["LOYALTY"]}
          onDue={props.onDue}
          onCancel={() => (opened ? props.onDone() : setTendering(false))}
          submit={async (tenders, idempotencyKey) => {
            const body = {
              locationId: location.id,
              customerId: props.customer.id,
              lines: props.cartLines,
              tenders,
              dueAt: dueAt.toISOString(),
              notes: notes.trim() || undefined,
              idempotencyKey,
              terminalId: props.terminalState.terminal?.id,
            };
            try {
              const r = await guard("LAYAWAY_CREATE", (t) => api<Layaway>("POST", "/layaways", body, { approvalToken: t }));
              if (!r) throw new ApiError(0, "CANCELLED", "Manager approval cancelled");
              return r;
            } catch (e) {
              throw layawayError(e);
            }
          }}
          onPaid={(layaway, tenders) => setOpened({ layaway, changeCents: changeFor(tenders), cash: tenders.some((t) => t.type === "CASH") })}
          done={
            opened && (
              <>
                <Text style={ui.h1}>Layaway #{opened.layaway.number} opened</Text>
                {opened.changeCents > 0 && <Text style={[ui.h1, { color: colors.good, fontSize: 40 }]}>Change {formatCents(opened.changeCents)}</Text>}
                <View style={{ gap: 4 }}>
                  <Row label="Total" value={opened.layaway.totalCents} />
                  <Row label="Deposit" value={opened.layaway.paidCents} />
                  <Row label="Balance" value={opened.layaway.balanceCents} big />
                  <Row label="Due by" value={dayLabel(opened.layaway.dueAt)} />
                </View>
                <PrintStatement layawayId={opened.layaway.id} terminal={props.terminalState.terminal} auto={opened.cash} />
                <Button title="Done" kind="good" onPress={props.onDone} />
              </>
            )
          }
        />
      )}
    </Modal>
  );
}
