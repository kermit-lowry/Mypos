import { formatCents } from "@mypos/shared";
import type { PrismaClient } from "@prisma/client";
import { notFound } from "../errors.js";
import { describeVariant } from "./checkout.js";

const esc = (s: string | null | undefined) => (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const date = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-US") : "");

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:13px/1.45 -apple-system,system-ui,sans-serif;color:#111;max-width:800px;margin:24px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:18px 0 6px}.meta{color:#555;display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;margin:12px 0}
table{width:100%;border-collapse:collapse;margin:8px 0}th,td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{background:#f4f4f5;font-weight:600}
td.r,th.r{text-align:right;white-space:nowrap}tfoot td{font-weight:700;border-top:2px solid #111}.sign{margin-top:40px;display:grid;grid-template-columns:1fr 1fr;gap:24px}
.sign div{border-top:1px solid #111;padding-top:4px;color:#555}@media print{body{margin:0}}</style></head><body>${body}</body></html>`;
}

/** Printable purchase order to send to the vendor. */
export async function purchaseOrderHtml(prisma: PrismaClient, id: string): Promise<string> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { vendor: true, location: true, lines: { include: { variant: { include: { product: true } } } }, receipts: { include: { lines: true }, orderBy: { receivedAt: "asc" } } },
  });
  if (!po) throw notFound("Purchase order");
  const subtotal = po.lines.reduce((a, l) => a + l.quantity * l.unitCostCents, 0);
  const rows = po.lines
    .map((l) => `<tr><td>${esc(l.variant.sku)}</td><td>${esc(describeVariant(l.variant.product.title, l.variant))}</td><td class="r">${l.quantity}</td><td class="r">${l.receivedQty}</td><td class="r">${formatCents(l.unitCostCents)}</td><td class="r">${formatCents(l.quantity * l.unitCostCents)}</td></tr>`)
    .join("");
  const receipts = po.receipts.length
    ? `<h2>Deliveries</h2><table><thead><tr><th>Date</th><th>Reference</th><th class="r">Units</th><th class="r">Cost</th></tr></thead><tbody>${po.receipts
        .map((r) => `<tr><td>${date(r.receivedAt)}</td><td>${esc(r.reference)}</td><td class="r">${r.lines.reduce((a, l) => a + l.quantity, 0)}</td><td class="r">${formatCents(r.lines.reduce((a, l) => a + l.quantity * l.unitCostCents, 0))}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  return page(`Purchase order #${po.number}`, `<h1>Purchase order #${po.number}</h1><div>${esc(po.location.name)}${po.location.address ? ` · ${esc(po.location.address)}` : ""}${po.location.phone ? ` · ${esc(po.location.phone)}` : ""}</div>
<div class="meta"><div><b>Vendor</b><br>${esc(po.vendor.name)}${po.vendor.accountNumber ? `<br>Account ${esc(po.vendor.accountNumber)}` : ""}${po.vendor.contactName ? `<br>${esc(po.vendor.contactName)}` : ""}${po.vendor.email ? `<br>${esc(po.vendor.email)}` : ""}${po.vendor.phone ? `<br>${esc(po.vendor.phone)}` : ""}${po.vendor.address ? `<br>${esc(po.vendor.address)}` : ""}</div>
<div><b>Status</b> ${esc(po.status.toLowerCase())}<br><b>Created</b> ${date(po.createdAt)}${po.orderedAt ? `<br><b>Ordered</b> ${date(po.orderedAt)}` : ""}${po.expectedAt ? `<br><b>Expected</b> ${date(po.expectedAt)}` : ""}${po.reference ? `<br><b>Reference</b> ${esc(po.reference)}` : ""}</div></div>
<table><thead><tr><th>SKU</th><th>Item</th><th class="r">Qty</th><th class="r">Rec'd</th><th class="r">Unit cost</th><th class="r">Total</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="5" class="r">Subtotal</td><td class="r">${formatCents(subtotal)}</td></tr>${po.shippingCents ? `<tr><td colspan="5" class="r">Shipping</td><td class="r">${formatCents(po.shippingCents)}</td></tr>` : ""}<tr><td colspan="5" class="r">Total</td><td class="r">${formatCents(subtotal + po.shippingCents)}</td></tr></tfoot></table>
${po.notes ? `<h2>Notes</h2><p>${esc(po.notes)}</p>` : ""}${receipts}`);
}

/** Printable transfer slip to travel with the goods. */
export async function transferHtml(prisma: PrismaClient, id: string): Promise<string> {
  const t = await prisma.transfer.findUnique({ where: { id }, include: { fromLocation: true, toLocation: true, lines: { include: { variant: { include: { product: true } } } } } });
  if (!t) throw notFound("Transfer");
  const rows = t.lines
    .map((l) => `<tr><td>${esc(l.variant.sku)}</td><td>${esc(describeVariant(l.variant.product.title, l.variant))}</td><td class="r">${l.quantity}</td><td class="r">${t.status === "RECEIVED" ? l.receivedQty : ""}</td><td class="r">${formatCents(l.variant.priceCents)}</td></tr>`)
    .join("");
  const units = t.lines.reduce((a, l) => a + l.quantity, 0);
  const value = t.lines.reduce((a, l) => a + l.quantity * l.variant.priceCents, 0);
  return page(`Transfer #${t.number}`, `<h1>Transfer #${t.number}</h1>
<div class="meta"><div><b>From</b><br>${esc(t.fromLocation.name)}${t.fromLocation.address ? `<br>${esc(t.fromLocation.address)}` : ""}</div><div><b>To</b><br>${esc(t.toLocation.name)}${t.toLocation.address ? `<br>${esc(t.toLocation.address)}` : ""}</div>
<div><b>Status</b> ${esc(t.status === "SENT" ? "in transit" : t.status.toLowerCase())}${t.reference ? `<br><b>Reference</b> ${esc(t.reference)}` : ""}</div><div>${t.sentAt ? `<b>Sent</b> ${date(t.sentAt)}<br>` : ""}${t.expectedAt ? `<b>Expected</b> ${date(t.expectedAt)}<br>` : ""}${t.receivedAt ? `<b>Received</b> ${date(t.receivedAt)}` : ""}</div></div>
<table><thead><tr><th>SKU</th><th>Item</th><th class="r">Sent</th><th class="r">Rec'd</th><th class="r">Retail</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="2" class="r">${t.lines.length} items</td><td class="r">${units}</td><td></td><td class="r">${formatCents(value)}</td></tr></tfoot></table>
${t.notes ? `<h2>Notes</h2><p>${esc(t.notes)}</p>` : ""}<div class="sign"><div>Packed by / date</div><div>Received by / date</div></div>`);
}

// ── Drawer (X / Z) report ────────────────────────────────────────

import type { SessionReport } from "./drawer.js";

/** Printable closing / X report for a drawer session. */
export function drawerReportHtml(r: SessionReport): string {
  const when = (iso: string | null) => (iso ? esc(new Date(iso).toLocaleString("en-US", { timeZone: r.session.timeZone })) : "");
  const money = (c: number) => formatCents(c);
  const neg = (c: number) => (c ? `-${formatCents(c)}` : formatCents(0));
  const row = (label: string, value: string, cls = "") => `<tr class="${cls}"><td>${esc(label)}</td><td class="r">${value}</td></tr>`;
  const { cash, sales } = r;
  const variance = cash.varianceCents ?? 0;
  const title = `${r.kind === "Z" ? "Closing" : "X"} report · Drawer #${r.session.number}`;

  const cashRows = [
    row("Opening float", money(cash.openingFloatCents)),
    row("Cash sales", money(cash.cashSalesCents)),
    row("Cash refunds", neg(cash.cashRefundsCents)),
    row("Trade-ins paid in cash", neg(cash.tradeInCashCents)),
    row("Paid in", money(cash.paidInCents)),
    row("Paid out", neg(cash.paidOutCents)),
    row("Drops to safe", neg(cash.dropCents)),
  ].join("");
  const countRows =
    cash.countedCashCents === null
      ? ""
      : `<tr><td>Counted</td><td class="r">${money(cash.countedCashCents)}</td></tr><tr><td>Variance${variance < 0 ? " (short)" : variance > 0 ? " (over)" : ""}</td><td class="r">${variance < 0 ? `-${money(-variance)}` : money(variance)}</td></tr>${r.session.approvedBy ? `<tr><td colspan="2">Variance approved by ${esc(r.session.approvedBy)}</td></tr>` : ""}`;
  const tenders = sales.byTender.map((t) => `<tr><td>${esc(t.tender)}</td><td class="r">${t.count}</td><td class="r">${money(t.amountCents)}</td></tr>`).join("") || `<tr><td colspan="3">No sales</td></tr>`;
  const refunds = sales.refunds.byTender.map((t) => `<tr><td>${esc(t.tender)}</td><td class="r">${t.count}</td><td class="r">${neg(t.amountCents)}</td></tr>`).join("");
  const movements = r.movements
    .map((m) => `<tr><td>${when(m.createdAt)}</td><td>${esc(m.kind.replace("_", " ").toLowerCase())}</td><td>${esc(m.reason)}${m.note ? ` <span style="color:#555">— ${esc(m.note)}</span>` : ""}</td><td>${esc(m.staff ?? "")}</td><td class="r">${m.kind === "PAID_IN" ? money(m.amountCents) : `-${money(m.amountCents)}`}</td></tr>`)
    .join("");
  // Reports stored before layaway existed have no block.
  const layaway = r.layawayPayments as SessionReport["layawayPayments"] | undefined;
  const layawayRows = layaway
    ? row(`Layaway payments (${layaway.count})`, money(layaway.amountCents)) +
      layaway.byTender.map((t) => row(`\u00a0\u00a0${t.tender} (${t.count})`, money(t.amountCents))).join("") +
      (layaway.refunds.count ? row(`Layaway refunds (${layaway.refunds.count})`, neg(layaway.refunds.amountCents)) : "")
    : "";
  const employees = r.byEmployee.map((e) => `<tr><td>${esc(e.name)}</td><td class="r">${e.orders}</td><td class="r">${money(e.netCents)}</td><td class="r">${money(e.collectedCents)}</td></tr>`).join("");
  const count = (c: Record<string, number> | null) =>
    c
      ? `<table><thead><tr><th>Denomination</th><th class="r">Count</th><th class="r">Amount</th></tr></thead><tbody>${Object.entries(c)
          .sort((a, b) => Number(b[0]) - Number(a[0]))
          .map(([d, n]) => `<tr><td>${money(Number(d))}</td><td class="r">${n}</td><td class="r">${money(Number(d) * n)}</td></tr>`)
          .join("")}</tbody></table>`
      : "";

  return page(
    title,
    `<h1>${esc(title)}</h1><div>${esc(r.session.locationName)}${r.session.terminalName ? ` · ${esc(r.session.terminalName)}` : ""}</div>
<div class="meta"><div><b>Opened</b> ${when(r.session.openedAt)}${r.session.openedBy ? ` by ${esc(r.session.openedBy)}` : ""}</div><div><b>${r.session.closedAt ? "Closed" : "Printed"}</b> ${when(r.session.closedAt ?? r.generatedAt)}${r.session.closedBy ? ` by ${esc(r.session.closedBy)}` : ""}</div></div>
<h2>Cash</h2><table><tbody>${cashRows}</tbody><tfoot><tr><td>Expected</td><td class="r">${money(cash.expectedCents)}</td></tr>${countRows}</tfoot></table>
<h2>Sales</h2><table><tbody>${row("Orders / units", `${sales.orders} / ${sales.units}`)}${row("Gross", money(sales.grossCents))}${row("Discounts", neg(sales.discountCents))}${row("Net sales", money(sales.netSalesCents))}${row("Tax", money(sales.taxCents))}${sales.cardAdjustmentCents ? row("Card price adjustment", money(sales.cardAdjustmentCents)) : ""}${row(`Refunds (${sales.refunds.count})`, neg(sales.refunds.amountCents))}${layawayRows}</tbody><tfoot><tr><td>Collected</td><td class="r">${money(sales.collectedCents)}</td></tr></tfoot></table>
<h2>Tenders</h2><table><thead><tr><th>Tender</th><th class="r">Count</th><th class="r">Amount</th></tr></thead><tbody>${tenders}</tbody></table>
${refunds ? `<h2>Refunds by tender</h2><table><thead><tr><th>Tender</th><th class="r">Count</th><th class="r">Amount</th></tr></thead><tbody>${refunds}</tbody></table>` : ""}
<h2>Trade-ins</h2><table><thead><tr><th>Payout</th><th class="r">Tickets</th><th class="r">Paid</th></tr></thead><tbody><tr><td>Cash</td><td class="r">${sales.tradeIns.byPayout.CASH.tickets}</td><td class="r">${money(sales.tradeIns.byPayout.CASH.paidCents)}</td></tr><tr><td>Store credit</td><td class="r">${sales.tradeIns.byPayout.STORE_CREDIT.tickets}</td><td class="r">${money(sales.tradeIns.byPayout.STORE_CREDIT.paidCents)}</td></tr></tbody></table>
${movements ? `<h2>Paid in / out</h2><table><thead><tr><th>When</th><th>Kind</th><th>Reason</th><th>By</th><th class="r">Amount</th></tr></thead><tbody>${movements}</tbody></table>` : ""}
${employees ? `<h2>By employee</h2><table><thead><tr><th>Employee</th><th class="r">Orders</th><th class="r">Net sales</th><th class="r">Collected</th></tr></thead><tbody>${employees}</tbody></table>` : ""}
${cash.openingCount ? `<h2>Opening count</h2>${count(cash.openingCount)}` : ""}${cash.closingCount ? `<h2>Closing count</h2>${count(cash.closingCount)}` : ""}
${r.session.notes ? `<h2>Notes</h2><p>${esc(r.session.notes)}</p>` : ""}<div class="sign"><div>Counted by / date</div><div>Reviewed by / date</div></div>`,
  );
}

// ── Layaway statement ────────────────────────────────────────────

import type { LayawayStatement } from "./layaway.js";

/** Printable / emailable layaway statement. */
export function layawayStatementHtml(s: LayawayStatement): string {
  const money = (c: number) => formatCents(c);
  const row = (label: string, value: string, cls = "") => `<tr class="${cls}"><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`;
  const title = `Layaway #${s.number}`;
  const lines = s.lines
    .map((l) => `<tr><td>${esc(l.title)}</td><td class="r">${l.quantity}</td><td class="r">${money(l.unitCents)}</td><td class="r">${l.discountCents ? `-${money(l.discountCents)}` : ""}</td><td class="r">${money(l.totalCents)}</td></tr>`)
    .join("");
  const payments = s.payments.length
    ? `<table><thead><tr><th>Date</th><th>Tender</th><th>Taken by</th><th class="r">Paid</th><th class="r">To balance</th></tr></thead><tbody>${s.payments
        .map((p) => `<tr><td>${date(p.at)}</td><td>${esc(p.label)}${p.deposit ? " (deposit)" : ""}${p.detail ? ` <span style="color:#555">${esc(p.detail)}</span>` : ""}</td><td>${esc(p.staff ?? "")}</td><td class="r">${money(p.amountCents)}</td><td class="r">${money(p.appliedCents)}</td></tr>`)
        .join("")}</tbody></table>`
    : "<p>No payments yet.</p>";
  return page(
    title,
    `<h1>${esc(title)}</h1><div>${esc(s.store.name)}${s.store.address ? ` · ${esc(s.store.address)}` : ""}${s.store.phone ? ` · ${esc(s.store.phone)}` : ""}</div>
<div class="meta"><div><b>Customer</b><br>${esc(s.customer.name)}${s.customer.email ? `<br>${esc(s.customer.email)}` : ""}${s.customer.phone ? `<br>${esc(s.customer.phone)}` : ""}</div>
<div><b>Status</b> ${esc(s.status.toLowerCase())}<br><b>Opened</b> ${date(s.createdAt)}${s.cashier ? ` by ${esc(s.cashier)}` : ""}<br><b>Due</b> ${date(s.dueAt)}${s.orderNumber ? `<br><b>Sale</b> #${s.orderNumber}` : ""}</div></div>
<table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Discount</th><th class="r">Total</th></tr></thead><tbody>${lines}</tbody>
<tfoot>${row("Subtotal", money(s.subtotalCents)).replace("<td>", '<td colspan="4" class="r">')}${s.discountCents ? row("Discounts", `-${money(s.discountCents)}`).replace("<td>", '<td colspan="4" class="r">') : ""}${row("Tax", money(s.taxCents)).replace("<td>", '<td colspan="4" class="r">')}${row("Total", money(s.totalCents)).replace("<td>", '<td colspan="4" class="r">')}</tfoot></table>
<h2>Payments</h2>${payments}
<table><tbody>${row("Paid toward balance", money(s.paidCents))}${s.cardAdjustmentCents ? row(`Card price adjustment${s.dualPricing ? ` (${s.dualPricing.percent})` : ""}`, money(s.cardAdjustmentCents)) : ""}</tbody>
<tfoot>${row("Balance due", money(s.balanceCents))}${s.dualPricing && s.balanceCents > 0 ? row("Balance by card", money(s.cardBalanceCents)) : ""}</tfoot></table>
<h2>Terms</h2>${s.terms.map((t) => `<p>${esc(t)}</p>`).join("")}${s.store.footer ? `<p>${esc(s.store.footer)}</p>` : ""}`,
  );
}

// ── Pick ticket / packing slip ───────────────────────────────────

import { addressLines, type PickTicket } from "./fulfillment.js";

/** Printable pick ticket (pickup) / packing slip (shipping) for an online order. */
export function pickTicketHtml(t: PickTicket): string {
  const money = (c: number) => formatCents(c);
  const when = (d: Date | null) => (d ? esc(d.toLocaleString("en-US", { timeZone: t.store.timeZone })) : "");
  const kind = t.fulfillment === "SHIP" ? "Packing slip" : "Pick ticket";
  const title = `${kind} · Order #${t.orderNumber}`;
  const rows = t.lines
    .map((l) => `<tr><td class="r" style="font-size:18px">${l.picked ? "&#9746;" : "&#9744;"}</td><td>${esc(l.sku)}</td><td>${esc(l.title)}</td><td class="r">${l.quantity}</td><td class="r">${money(l.unitCents)}</td><td class="r">${money(l.totalCents)}</td></tr>`)
    .join("");
  const address = addressLines(t.shippingAddress);
  const how =
    t.fulfillment === "SHIP"
      ? `<b>SHIP TO</b><br>${address.length ? address.map(esc).join("<br>") : "<i>no address on the order</i>"}${t.carrier ? `<br><b>Carrier</b> ${esc(t.carrier)}${t.trackingNumber ? ` · ${esc(t.trackingNumber)}` : ""}` : ""}`
      : `<b>IN-STORE PICKUP</b>${t.pickupInstructions ? `<br>${esc(t.pickupInstructions)}` : ""}`;
  const contact = t.customer ? [t.customer.name, t.customer.email, t.customer.phone].filter(Boolean).map((s) => esc(s!)).join("<br>") : "<i>no customer</i>";
  const payments = t.payments.map((p) => `<tr><td colspan="5" class="r">${esc(p.label)}${p.detail ? ` (${esc(p.detail)})` : ""}</td><td class="r">${money(p.amountCents)}</td></tr>`).join("");
  return page(
    title,
    `<h1>${esc(title)}</h1><div>${esc(t.store.name)}${t.store.address ? ` · ${esc(t.store.address)}` : ""}${t.store.phone ? ` · ${esc(t.store.phone)}` : ""}</div>
<div class="meta"><div>${how}</div><div><b>Customer</b><br>${contact}</div>
<div><b>Channel</b> ${esc(t.channel)}${t.externalId ? ` #${esc(t.externalId)}` : ""}<br><b>Placed</b> ${when(t.createdAt)}<br><b>Status</b> ${esc((t.fulfillmentStatus ?? "").replace("_", " ").toLowerCase())}</div>
<div><b>Items</b> ${t.items}${t.customerNote ? `<br><b>Customer note</b> ${esc(t.customerNote)}` : ""}</div></div>
<table><thead><tr><th class="r">Set aside</th><th>SKU</th><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Total</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="5" class="r">Subtotal</td><td class="r">${money(t.subtotalCents)}</td></tr>${t.discountCents ? `<tr><td colspan="5" class="r">Discounts</td><td class="r">-${money(t.discountCents)}</td></tr>` : ""}<tr><td colspan="5" class="r">Tax</td><td class="r">${money(t.taxCents)}</td></tr>${t.shippingCents ? `<tr><td colspan="5" class="r">Shipping</td><td class="r">${money(t.shippingCents)}</td></tr>` : ""}${t.cardAdjustmentCents ? `<tr><td colspan="5" class="r">Card price adjustment${t.cardPricePercent ? ` (${esc(t.cardPricePercent)})` : ""}</td><td class="r">${money(t.cardAdjustmentCents)}</td></tr>` : ""}<tr><td colspan="5" class="r">Total paid</td><td class="r">${money(t.totalCents)}</td></tr>${payments}</tfoot></table>
<div class="sign"><div>Set aside by${t.setAsideBy ? `: ${esc(t.setAsideBy)}` : ""}</div><div>On${t.setAsideAt ? `: ${when(t.setAsideAt)}` : ""}</div></div>${t.store.footer ? `<p>${esc(t.store.footer)}</p>` : ""}`,
  );
}
