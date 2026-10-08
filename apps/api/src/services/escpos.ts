import { formatCents } from "@mypos/shared";
import type { SessionReport } from "./drawer.js";
import type { Receipt } from "./receipts.js";
import { receiptText } from "./receipts.js";

/**
 * ESC/POS for network thermal receipt printers (Epson TM, Star in ESC/POS
 * mode, and most generic 58/80mm printers). Cash drawers plugged into the
 * printer's DK port open with the drawer-kick command.
 */
const ESC = 0x1b;
const GS = 0x1d;

const INIT = [ESC, 0x40];
const CODEPAGE_437 = [ESC, 0x74, 0];
const ALIGN_LEFT = [ESC, 0x61, 0];
const ALIGN_CENTER = [ESC, 0x61, 1];
const DOUBLE = [GS, 0x21, 0x11];
const NORMAL = [GS, 0x21, 0x00];
const FEED_AND_CUT = [ESC, 0x64, 4, GS, 0x56, 66, 3];
/** Pulse drawer pin 2 (the usual one), 50ms on / 500ms off. */
export const DRAWER_KICK = [ESC, 0x70, 0, 25, 250];

/** Printers here use code page 437; map the few non-ASCII characters we emit. */
function ascii(s: string): number[] {
  const mapped = s
    .replace(/[•·]/g, "*")
    .replace(/…/g, "...")
    .replace(/×/g, "x")
    .replace(/[−–—]/g, "-")
    .normalize("NFKD")
    .replace(/[^\x0a\x20-\x7e]/g, "");
  return [...mapped].map((c) => c.charCodeAt(0));
}

export function receiptEscPos(r: Receipt, opts: { width?: number; openDrawer?: boolean } = {}): Buffer {
  const width = opts.width ?? 42;
  // Store name big and centered; the rest is the fixed-width text receipt.
  const [, ...rest] = receiptText(r, width).split("\n");
  return Buffer.from([
    ...INIT,
    ...CODEPAGE_437,
    ...(opts.openDrawer ? DRAWER_KICK : []),
    ...ALIGN_CENTER,
    ...DOUBLE,
    ...ascii(r.store.name.slice(0, Math.floor(width / 2))),
    0x0a,
    ...NORMAL,
    ...ALIGN_LEFT,
    ...ascii(rest.join("\n")),
    0x0a,
    ...FEED_AND_CUT,
  ]);
}

export const drawerKickBytes = () => Buffer.from([...INIT, ...DRAWER_KICK]);

// ── Drawer (X / Z) report ────────────────────────────────────────

function pad(left: string, right: string, width: number): string {
  const l = left.length + right.length + 1 > width ? left.slice(0, Math.max(0, width - right.length - 2)) + "…" : left;
  return l + " ".repeat(Math.max(1, width - l.length - right.length)) + right;
}

const KIND_LABEL = { PAID_IN: "Paid in", PAID_OUT: "Paid out", DROP: "Drop" } as const;

/** Fixed-width text for thermal printers (42 columns for 80mm, 32 for 58mm). */
export function drawerReportText(r: SessionReport, width = 42): string {
  const out: string[] = [];
  const center = (s: string) => " ".repeat(Math.max(0, Math.floor((width - s.length) / 2))) + s;
  const rule = "-".repeat(width);
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: r.session.timeZone, dateStyle: "short", timeStyle: "short" }) : "");
  const money = (c: number) => formatCents(c);
  const neg = (c: number) => (c ? `-${formatCents(c)}` : formatCents(0));
  const { cash, sales } = r;

  out.push(center(r.session.locationName));
  out.push(center(`${r.kind === "Z" ? "CLOSING" : "X"} REPORT  Drawer #${r.session.number}`));
  if (r.session.terminalName) out.push(center(`Register: ${r.session.terminalName}`));
  out.push(pad(`Opened ${when(r.session.openedAt)}`, r.session.openedBy ?? "", width));
  if (r.session.closedAt) out.push(pad(`Closed ${when(r.session.closedAt)}`, r.session.closedBy ?? "", width));
  else out.push(pad("Printed", when(r.generatedAt), width));
  out.push(rule, "CASH");
  out.push(pad("Opening float", money(cash.openingFloatCents), width));
  out.push(pad("Cash sales", money(cash.cashSalesCents), width));
  out.push(pad("Cash refunds", neg(cash.cashRefundsCents), width));
  out.push(pad("Trade-ins paid", neg(cash.tradeInCashCents), width));
  out.push(pad("Paid in", money(cash.paidInCents), width));
  out.push(pad("Paid out", neg(cash.paidOutCents), width));
  out.push(pad("Drops", neg(cash.dropCents), width));
  out.push(pad("EXPECTED", money(cash.expectedCents), width));
  if (cash.countedCashCents !== null) {
    out.push(pad("COUNTED", money(cash.countedCashCents), width));
    const v = cash.varianceCents ?? 0;
    out.push(pad(v === 0 ? "Variance" : v < 0 ? "Variance (short)" : "Variance (over)", v < 0 ? `-${money(-v)}` : money(v), width));
    if (r.session.approvedBy) out.push(`Variance approved by ${r.session.approvedBy}`);
  }
  out.push(rule, "SALES");
  out.push(pad("Orders / units", `${sales.orders} / ${sales.units}`, width));
  out.push(pad("Gross", money(sales.grossCents), width));
  out.push(pad("Discounts", neg(sales.discountCents), width));
  out.push(pad("Net sales", money(sales.netSalesCents), width));
  out.push(pad("Tax", money(sales.taxCents), width));
  if (sales.cardAdjustmentCents) out.push(pad("Card price adj.", money(sales.cardAdjustmentCents), width));
  out.push(pad("Collected", money(sales.collectedCents), width));
  out.push(pad(`Refunds (${sales.refunds.count})`, neg(sales.refunds.amountCents), width));
  // Reports stored before layaway existed have no block.
  const layaway = r.layawayPayments as SessionReport["layawayPayments"] | undefined;
  if (layaway) {
    out.push(pad(`Layaway payments (${layaway.count})`, money(layaway.amountCents), width));
    for (const t of layaway.byTender) out.push(pad(`  ${t.tender} (${t.count})`, money(t.amountCents), width));
    if (layaway.refunds.count) out.push(pad(`Layaway refunds (${layaway.refunds.count})`, neg(layaway.refunds.amountCents), width));
  }
  out.push("TENDERS");
  if (sales.byTender.length === 0) out.push("  none");
  for (const t of sales.byTender) out.push(pad(`  ${t.tender} (${t.count})`, money(t.amountCents), width));
  if (sales.refunds.byTender.length) {
    out.push("REFUNDS BY TENDER");
    for (const t of sales.refunds.byTender) out.push(pad(`  ${t.tender} (${t.count})`, neg(t.amountCents), width));
  }
  out.push("TRADE-INS");
  out.push(pad(`  Cash (${sales.tradeIns.byPayout.CASH.tickets})`, money(sales.tradeIns.byPayout.CASH.paidCents), width));
  out.push(pad(`  Store credit (${sales.tradeIns.byPayout.STORE_CREDIT.tickets})`, money(sales.tradeIns.byPayout.STORE_CREDIT.paidCents), width));
  if (r.movements.length) {
    out.push(rule, "PAID IN / OUT");
    for (const m of r.movements) {
      const amt = m.kind === "PAID_IN" ? money(m.amountCents) : `-${money(m.amountCents)}`;
      out.push(pad(`${KIND_LABEL[m.kind]}: ${m.reason}`, amt, width));
      if (m.staff || m.note) out.push(`   ${[m.staff, m.note].filter(Boolean).join(" - ")}`);
    }
  }
  if (r.byEmployee.length) {
    out.push(rule, "BY EMPLOYEE");
    for (const e of r.byEmployee) out.push(pad(`${e.name} (${e.orders})`, money(e.netCents), width));
  }
  if (r.session.notes) out.push(rule, `Notes: ${r.session.notes}`);
  return out.join("\n");
}

/** The text report as ESC/POS: store name big, then the fixed-width text, feed and cut. */
export function drawerReportEscPos(r: SessionReport, width = 42): Buffer {
  const [, ...rest] = drawerReportText(r, width).split("\n");
  return Buffer.from([
    ...INIT,
    ...CODEPAGE_437,
    ...ALIGN_CENTER,
    ...DOUBLE,
    ...ascii(r.session.locationName.slice(0, Math.floor(width / 2))),
    0x0a,
    ...NORMAL,
    ...ALIGN_LEFT,
    ...ascii(rest.join("\n")),
    0x0a,
    ...FEED_AND_CUT,
  ]);
}

// ── Layaway statement ────────────────────────────────────────────

import type { LayawayStatement } from "./layaway.js";

/** Break a sentence into lines of at most `width` characters. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Fixed-width statement for thermal printers (42 columns for 80mm, 32 for 58mm). */
export function layawayStatementText(s: LayawayStatement, width = 42): string {
  const out: string[] = [];
  const center = (t: string) => " ".repeat(Math.max(0, Math.floor((width - t.length) / 2))) + t.slice(0, width);
  const rule = "-".repeat(width);
  const money = (c: number) => formatCents(c);
  const day = (d: Date) => d.toLocaleDateString("en-US");

  out.push(center(s.store.name));
  if (s.store.header) s.store.header.split("\n").forEach((l) => out.push(center(l)));
  out.push(center(`LAYAWAY #${s.number}`));
  out.push(center(`Opened ${day(s.createdAt)}`));
  if (s.cashier) out.push(center(`Cashier: ${s.cashier}`));
  out.push(center(`Customer: ${s.customer.name}`));
  out.push(rule);
  for (const l of s.lines) {
    out.push(pad(l.quantity > 1 ? `${l.quantity} x ${l.title}` : l.title, money(l.totalCents + l.discountCents), width));
    if (l.quantity > 1) out.push(`   @ ${money(l.unitCents)} ea`);
    if (l.discountCents) out.push(pad("   Discount", `-${money(l.discountCents)}`, width));
  }
  out.push(rule);
  out.push(pad("Subtotal", money(s.subtotalCents), width));
  if (s.discountCents) out.push(pad("Discounts", `-${money(s.discountCents)}`, width));
  for (const p of s.promotions) out.push(pad(`  ${p.name}`, `-${money(p.discountCents)}`, width));
  out.push(pad("Tax", money(s.taxCents), width));
  out.push(pad("TOTAL", money(s.totalCents), width));
  out.push(rule, "PAYMENTS");
  if (s.payments.length === 0) out.push("  none yet");
  for (const p of s.payments) {
    out.push(pad(`${day(p.at)} ${p.label}${p.deposit ? " (deposit)" : ""}`, money(p.amountCents), width));
    if (p.appliedCents !== p.amountCents) out.push(pad("   applied to balance", money(p.appliedCents), width));
    if (p.detail) out.push(`   ${p.detail}`);
  }
  out.push(rule);
  out.push(pad("Paid toward balance", money(s.paidCents), width));
  if (s.cardAdjustmentCents) out.push(pad(`Card price adj. (${s.dualPricing?.percent ?? ""})`, money(s.cardAdjustmentCents), width));
  out.push(pad("BALANCE DUE", money(s.balanceCents), width));
  if (s.dualPricing && s.balanceCents > 0) out.push(pad("  by card", money(s.cardBalanceCents), width));
  if (s.status === "ACTIVE") out.push(pad("Due by", day(s.dueAt), width));
  out.push(rule);
  for (const t of s.terms) out.push(...wrap(t, width));
  if (s.store.footer) {
    out.push("");
    s.store.footer.split("\n").forEach((l) => out.push(center(l)));
  }
  return out.join("\n");
}

/** The statement as ESC/POS: store name big, then the fixed-width text, feed and cut. */
export function layawayStatementEscPos(s: LayawayStatement, width = 42): Buffer {
  const [, ...rest] = layawayStatementText(s, width).split("\n");
  return Buffer.from([
    ...INIT,
    ...CODEPAGE_437,
    ...ALIGN_CENTER,
    ...DOUBLE,
    ...ascii(s.store.name.slice(0, Math.floor(width / 2))),
    0x0a,
    ...NORMAL,
    ...ALIGN_LEFT,
    ...ascii(rest.join("\n")),
    0x0a,
    ...FEED_AND_CUT,
  ]);
}

// ── Pick ticket / packing slip ───────────────────────────────────

import { addressLines, type PickTicket } from "./fulfillment.js";

/** Fixed-width pick ticket for thermal printers (42 columns for 80mm, 32 for 58mm). */
export function pickTicketText(t: PickTicket, width = 42): string {
  const out: string[] = [];
  const center = (s: string) => " ".repeat(Math.max(0, Math.floor((width - s.length) / 2))) + s.slice(0, width);
  const rule = "-".repeat(width);
  const money = (c: number) => formatCents(c);
  const when = (d: Date) => d.toLocaleString("en-US", { timeZone: t.store.timeZone, dateStyle: "short", timeStyle: "short" });

  out.push(center(t.store.name));
  out.push(center(t.fulfillment === "SHIP" ? `PACKING SLIP  Order #${t.orderNumber}` : `PICK TICKET  Order #${t.orderNumber}`));
  out.push(center(`${t.channel}${t.externalId ? ` #${t.externalId}` : ""}  ${when(t.createdAt)}`));
  out.push(rule);
  if (t.fulfillment === "SHIP") {
    out.push("SHIP TO");
    const lines = addressLines(t.shippingAddress);
    if (lines.length === 0) out.push("  (no address on the order)");
    for (const l of lines) out.push(...wrap(l, width - 2).map((x) => `  ${x}`));
    if (t.carrier) out.push(pad("  Carrier", `${t.carrier}${t.trackingNumber ? ` ${t.trackingNumber}` : ""}`, width));
  } else {
    out.push("IN-STORE PICKUP");
    if (t.pickupInstructions) out.push(...wrap(t.pickupInstructions, width - 2).map((x) => `  ${x}`));
  }
  if (t.customer) {
    out.push("CUSTOMER");
    for (const s of [t.customer.name, t.customer.email, t.customer.phone]) if (s) out.push(`  ${s.slice(0, width - 2)}`);
  }
  if (t.customerNote) {
    out.push("NOTE");
    out.push(...wrap(t.customerNote, width - 2).map((x) => `  ${x}`));
  }
  out.push(rule, `ITEMS (${t.items})`);
  for (const l of t.lines) {
    out.push(pad(`[${l.picked ? "x" : " "}] ${l.quantity} x ${l.title}`, money(l.totalCents), width));
    out.push(`      ${l.sku}${l.quantity > 1 ? `  @ ${money(l.unitCents)} ea` : ""}`.slice(0, width));
  }
  out.push(rule);
  out.push(pad("Subtotal", money(t.subtotalCents), width));
  if (t.discountCents) out.push(pad("Discounts", `-${money(t.discountCents)}`, width));
  out.push(pad("Tax", money(t.taxCents), width));
  if (t.shippingCents) out.push(pad("Shipping", money(t.shippingCents), width));
  if (t.cardAdjustmentCents) out.push(pad(`Card price adj.${t.cardPricePercent ? ` (${t.cardPricePercent})` : ""}`, money(t.cardAdjustmentCents), width));
  out.push(pad("TOTAL PAID", money(t.totalCents), width));
  for (const p of t.payments) {
    out.push(pad(`  ${p.label}`, money(p.amountCents), width));
    if (p.detail) out.push(`     ${p.detail}`);
  }
  out.push(rule);
  out.push(pad("Set aside by", t.setAsideBy ?? "______________", width));
  out.push(pad("On", t.setAsideAt ? when(t.setAsideAt) : "______________", width));
  if (t.store.footer) {
    out.push("");
    t.store.footer.split("\n").forEach((l) => out.push(center(l)));
  }
  return out.join("\n");
}

/** The pick ticket as ESC/POS: store name big, then the fixed-width text, feed and cut. */
export function pickTicketEscPos(t: PickTicket, width = 42): Buffer {
  const [, ...rest] = pickTicketText(t, width).split("\n");
  return Buffer.from([
    ...INIT,
    ...CODEPAGE_437,
    ...ALIGN_CENTER,
    ...DOUBLE,
    ...ascii(t.store.name.slice(0, Math.floor(width / 2))),
    0x0a,
    ...NORMAL,
    ...ALIGN_LEFT,
    ...ascii(rest.join("\n")),
    0x0a,
    ...FEED_AND_CUT,
  ]);
}
