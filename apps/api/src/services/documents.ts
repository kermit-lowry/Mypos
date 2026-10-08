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
<h2>Sales</h2><table><tbody>${row("Orders / units", `${sales.orders} / ${sales.units}`)}${row("Gross", money(sales.grossCents))}${row("Discounts", neg(sales.discountCents))}${row("Net sales", money(sales.netSalesCents))}${row("Tax", money(sales.taxCents))}${sales.cardAdjustmentCents ? row("Card price adjustment", money(sales.cardAdjustmentCents)) : ""}${row(`Refunds (${sales.refunds.count})`, neg(sales.refunds.amountCents))}</tbody><tfoot><tr><td>Collected</td><td class="r">${money(sales.collectedCents)}</td></tr></tfoot></table>
<h2>Tenders</h2><table><thead><tr><th>Tender</th><th class="r">Count</th><th class="r">Amount</th></tr></thead><tbody>${tenders}</tbody></table>
${refunds ? `<h2>Refunds by tender</h2><table><thead><tr><th>Tender</th><th class="r">Count</th><th class="r">Amount</th></tr></thead><tbody>${refunds}</tbody></table>` : ""}
<h2>Trade-ins</h2><table><thead><tr><th>Payout</th><th class="r">Tickets</th><th class="r">Paid</th></tr></thead><tbody><tr><td>Cash</td><td class="r">${sales.tradeIns.byPayout.CASH.tickets}</td><td class="r">${money(sales.tradeIns.byPayout.CASH.paidCents)}</td></tr><tr><td>Store credit</td><td class="r">${sales.tradeIns.byPayout.STORE_CREDIT.tickets}</td><td class="r">${money(sales.tradeIns.byPayout.STORE_CREDIT.paidCents)}</td></tr></tbody></table>
${movements ? `<h2>Paid in / out</h2><table><thead><tr><th>When</th><th>Kind</th><th>Reason</th><th>By</th><th class="r">Amount</th></tr></thead><tbody>${movements}</tbody></table>` : ""}
${employees ? `<h2>By employee</h2><table><thead><tr><th>Employee</th><th class="r">Orders</th><th class="r">Net sales</th><th class="r">Collected</th></tr></thead><tbody>${employees}</tbody></table>` : ""}
${cash.openingCount ? `<h2>Opening count</h2>${count(cash.openingCount)}` : ""}${cash.closingCount ? `<h2>Closing count</h2>${count(cash.closingCount)}` : ""}
${r.session.notes ? `<h2>Notes</h2><p>${esc(r.session.notes)}</p>` : ""}<div class="sign"><div>Counted by / date</div><div>Reviewed by / date</div></div>`,
  );
}
