import { cardPrice, formatBps, formatCents } from "@mypos/shared";
import type { PrismaClient } from "@prisma/client";
import { notFound } from "../errors.js";

export interface Receipt {
  store: { name: string; header: string | null; footer: string | null };
  orderNumber: number;
  createdAt: Date;
  cashier: string | null;
  customer: string | null;
  /** How the item prices on this receipt are expressed. */
  pricedAt: "CASH" | "CARD";
  lines: { title: string; quantity: number; unitCents: number; discountCents: number; totalCents: number }[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  /** Shown whenever dual pricing was on for the sale. */
  dualPricing: null | {
    percent: string;
    cashTotalCents: number;
    cardTotalCents: number;
    /** Split payments: the extra the card portion paid. */
    cardAdjustmentCents: number;
  };
  payments: { label: string; amountCents: number; detail?: string }[];
  changeCents: number;
  loyalty: string | null;
}

const TENDER_LABELS: Record<string, string> = {
  CARD: "Card",
  CASH: "Cash",
  STORE_CREDIT: "Store credit",
  LOYALTY: "Rewards",
  GIFT_CARD: "Gift card",
  PREORDER_DEPOSIT: "Preorder deposit",
  EXTERNAL: "Paid online",
};

export async function buildReceipt(prisma: PrismaClient, orderId: string): Promise<Receipt> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: true, payments: true, location: true, staff: true, customer: true },
  });
  if (!order) throw notFound("Order");

  const bps = order.cardPriceBps;
  const sale = order.payments.filter((p) => p.amountCents > 0 && p.status === "APPROVED");
  const cardPaid = sale.filter((p) => p.tender === "CARD").reduce((a, p) => a + p.amountCents, 0);
  const charged = order.totalCents + order.cardAdjustmentCents;
  const allCard = bps > 0 && cardPaid > 0 && cardPaid === charged;

  // Paid entirely by card: show card prices on every line so they add up to
  // what was charged. Otherwise show cash prices plus any card adjustment.
  const price = (cents: number) => (allCard ? cardPrice(cents, bps) : cents);
  const shown = allCard
    ? {
        subtotalCents: order.lines.reduce((a, l) => a + price(l.unitPriceCents) * l.quantity, 0),
        discountCents: order.lines.reduce((a, l) => a + (l.discountCents ? price(l.discountCents) : 0), 0),
        taxCents: order.taxCents + order.cardAdjustmentTaxCents,
        totalCents: charged,
      }
    : { subtotalCents: order.subtotalCents, discountCents: order.discountCents, taxCents: order.taxCents, totalCents: order.totalCents };

  const change = sale.reduce((a, p) => a + (p.changeCents ?? 0), 0);
  return {
    store: { name: order.location.name, header: order.location.receiptHeader, footer: order.location.receiptFooter },
    orderNumber: order.number,
    createdAt: order.createdAt,
    cashier: order.staff?.name ?? null,
    customer: order.customer?.name ?? null,
    pricedAt: allCard ? "CARD" : "CASH",
    lines: order.lines.map((l) => {
      const unit = price(l.unitPriceCents);
      const disc = l.discountCents ? price(l.discountCents) : 0;
      return { title: l.title, quantity: l.quantity, unitCents: unit, discountCents: disc, totalCents: unit * l.quantity - disc };
    }),
    ...shown,
    dualPricing:
      bps > 0
        ? {
            percent: formatBps(bps),
            cashTotalCents: order.totalCents,
            cardTotalCents: order.cardTotalCents,
            cardAdjustmentCents: allCard ? 0 : order.cardAdjustmentCents,
          }
        : null,
    payments: sale.map((p) => ({
      label: TENDER_LABELS[p.tender] ?? p.tender,
      amountCents: p.amountCents + (p.changeCents ?? 0),
      detail: p.cardLast4 ? `${p.cardBrand ?? "Card"} •••• ${p.cardLast4}` : undefined,
    })),
    changeCents: change,
    loyalty: order.loyaltyEarned > 0 ? (order.loyaltyUnit === "POINTS" ? `You earned ${order.loyaltyEarned} points` : `You earned ${formatCents(order.loyaltyEarned)} in rewards`) : null,
  };
}

// ── Renderers ──────────────────────────────────────────────────

function pad(left: string, right: string, width: number): string {
  const l = left.length + right.length + 1 > width ? left.slice(0, width - right.length - 2) + "…" : left;
  return l + " ".repeat(Math.max(1, width - l.length - right.length)) + right;
}

/** Fixed-width text for thermal receipt printers (42 columns for 80mm, 32 for 58mm). */
export function receiptText(r: Receipt, width = 42): string {
  const out: string[] = [];
  const center = (s: string) => " ".repeat(Math.max(0, Math.floor((width - s.length) / 2))) + s;
  const rule = "-".repeat(width);
  out.push(center(r.store.name));
  if (r.store.header) r.store.header.split("\n").forEach((l) => out.push(center(l)));
  out.push(center(`Sale #${r.orderNumber}  ${r.createdAt.toLocaleString("en-US")}`));
  if (r.cashier) out.push(center(`Cashier: ${r.cashier}`));
  if (r.customer) out.push(center(`Customer: ${r.customer}`));
  out.push(rule);
  for (const l of r.lines) {
    out.push(pad(l.quantity > 1 ? `${l.quantity} x ${l.title}` : l.title, formatCents(l.totalCents + l.discountCents), width));
    if (l.quantity > 1) out.push(`   @ ${formatCents(l.unitCents)} ea`);
    if (l.discountCents) out.push(pad("   Discount", `-${formatCents(l.discountCents)}`, width));
  }
  out.push(rule);
  out.push(pad("Subtotal", formatCents(r.subtotalCents), width));
  if (r.discountCents) out.push(pad("Discounts", `-${formatCents(r.discountCents)}`, width));
  out.push(pad("Tax", formatCents(r.taxCents), width));
  if (r.dualPricing?.cardAdjustmentCents) out.push(pad(`Card price adj. (${r.dualPricing.percent})`, formatCents(r.dualPricing.cardAdjustmentCents), width));
  out.push(pad(r.pricedAt === "CARD" ? "TOTAL (card price)" : "TOTAL", formatCents(r.totalCents + (r.dualPricing?.cardAdjustmentCents ?? 0)), width));
  if (r.dualPricing) {
    out.push("");
    out.push(pad("Cash price total", formatCents(r.dualPricing.cashTotalCents), width));
    out.push(pad("Card price total", formatCents(r.dualPricing.cardTotalCents), width));
    out.push(center(`Card prices are ${r.dualPricing.percent} higher than cash.`));
  }
  out.push(rule);
  for (const p of r.payments) {
    out.push(pad(p.label, formatCents(p.amountCents), width));
    if (p.detail) out.push(`   ${p.detail}`);
  }
  if (r.changeCents) out.push(pad("Change", formatCents(r.changeCents), width));
  if (r.loyalty) out.push("", center(r.loyalty));
  if (r.store.footer) {
    out.push("");
    r.store.footer.split("\n").forEach((l) => out.push(center(l)));
  }
  return out.join("\n");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Printable / emailable HTML receipt. */
export function receiptHtml(r: Receipt): string {
  const row = (l: string, v: string, cls = "") => `<tr class="${cls}"><td>${esc(l)}</td><td class="r">${esc(v)}</td></tr>`;
  const total = r.totalCents + (r.dualPricing?.cardAdjustmentCents ?? 0);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body{font:14px/1.4 -apple-system,system-ui,sans-serif;max-width:360px;margin:16px auto;color:#111}
h1{font-size:18px;text-align:center;margin:0}.c{text-align:center;color:#555;margin:2px 0}
table{width:100%;border-collapse:collapse;margin:10px 0}td{padding:2px 0;vertical-align:top}.r{text-align:right;white-space:nowrap}
.t td{border-top:1px solid #ccc;padding-top:6px}.b td{font-weight:700;font-size:16px}.m td{color:#555;font-size:12px}
.dual{border:1px solid #111;border-radius:6px;padding:8px;margin:10px 0}</style></head><body>
<h1>${esc(r.store.name)}</h1>${r.store.header ? `<p class="c">${esc(r.store.header)}</p>` : ""}
<p class="c">Sale #${r.orderNumber} · ${esc(r.createdAt.toLocaleString("en-US"))}</p>
${r.cashier || r.customer ? `<p class="c">${esc([r.cashier && `Cashier: ${r.cashier}`, r.customer && `Customer: ${r.customer}`].filter(Boolean).join(" · "))}</p>` : ""}
<table>${r.lines
    .map(
      (l) =>
        row(`${l.quantity > 1 ? `${l.quantity} × ` : ""}${l.title}`, formatCents(l.totalCents + l.discountCents)) +
        (l.quantity > 1 ? row(`@ ${formatCents(l.unitCents)} each`, "", "m") : "") +
        (l.discountCents ? row("Discount", `−${formatCents(l.discountCents)}`, "m") : ""),
    )
    .join("")}
${row("Subtotal", formatCents(r.subtotalCents), "t")}${r.discountCents ? row("Discounts", `−${formatCents(r.discountCents)}`) : ""}
${row("Tax", formatCents(r.taxCents))}${r.dualPricing?.cardAdjustmentCents ? row(`Card price adjustment (${r.dualPricing.percent})`, formatCents(r.dualPricing.cardAdjustmentCents)) : ""}
${row(r.pricedAt === "CARD" ? "Total (card price)" : "Total", formatCents(total), "b")}</table>
${
  r.dualPricing
    ? `<div class="dual"><table>${row("Cash price total", formatCents(r.dualPricing.cashTotalCents))}${row("Card price total", formatCents(r.dualPricing.cardTotalCents))}</table>
<p class="c">Card prices are ${esc(r.dualPricing.percent)} higher than cash prices.</p></div>`
    : ""
}
<table>${r.payments.map((p) => row(p.label + (p.detail ? ` (${p.detail})` : ""), formatCents(p.amountCents))).join("")}
${r.changeCents ? row("Change", formatCents(r.changeCents)) : ""}</table>
${r.loyalty ? `<p class="c">${esc(r.loyalty)}</p>` : ""}${r.store.footer ? `<p class="c">${esc(r.store.footer)}</p>` : ""}
</body></html>`;
}

/** Handpoint "HTML Print Format" for the PAX terminal's built-in printer. */
export function receiptTerminalHtml(r: Receipt): string {
  const text = (s: string, cls = "") => `<div><p class="${cls}">${esc(s)}</p></div>`;
  const pair = (l: string, v: string) => `<div><label>${esc(l)}</label><span class="right">${esc(v)}</span></div>`;
  const sep = `<div class="separator dotted" style="margin-top: 6px; height: 1px; margin-bottom: 6px;"></div>`;
  const total = r.totalCents + (r.dualPricing?.cardAdjustmentCents ?? 0);
  const main = [
    ...r.lines.flatMap((l) => [
      pair(`${l.quantity > 1 ? `${l.quantity}x ` : ""}${l.title.slice(0, 28)}`, formatCents(l.totalCents + l.discountCents)),
      ...(l.discountCents ? [pair("  Discount", `-${formatCents(l.discountCents)}`)] : []),
    ]),
    sep,
    pair("Subtotal", formatCents(r.subtotalCents)),
    ...(r.discountCents ? [pair("Discounts", `-${formatCents(r.discountCents)}`)] : []),
    pair("Tax", formatCents(r.taxCents)),
    ...(r.dualPricing?.cardAdjustmentCents ? [pair(`Card adj. (${r.dualPricing.percent})`, formatCents(r.dualPricing.cardAdjustmentCents))] : []),
    text(`${r.pricedAt === "CARD" ? "CARD TOTAL" : "TOTAL"} ${formatCents(total)}`, "large bold right"),
    ...(r.dualPricing
      ? [
          sep,
          pair("Cash price total", formatCents(r.dualPricing.cashTotalCents)),
          pair("Card price total", formatCents(r.dualPricing.cardTotalCents)),
          text(`Card prices are ${r.dualPricing.percent} higher than cash.`, "small center"),
        ]
      : []),
    sep,
    ...r.payments.map((p) => pair(p.label + (p.detail ? ` ${p.detail}` : ""), formatCents(p.amountCents))),
    ...(r.changeCents ? [pair("Change", formatCents(r.changeCents))] : []),
  ];
  return `<html style="font-family: monospace"><body>
<header>${text(r.store.name, "large bold center")}${r.store.header ? text(r.store.header, "center") : ""}${text(`Sale #${r.orderNumber}`, "center")}${text(r.createdAt.toLocaleString("en-US"), "small center")}</header>
<main>${main.join("")}</main>
<footer>${r.loyalty ? text(r.loyalty, "center") : ""}${r.store.footer ? text(r.store.footer, "center") : ""}</footer>
</body></html>`;
}
