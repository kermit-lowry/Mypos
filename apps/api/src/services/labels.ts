import { cardPrice, formatCents } from "@mypos/shared";
import type { PrismaClient } from "@prisma/client";
import bwipjs from "bwip-js";
import { Socket } from "node:net";
import { badRequest, notFound } from "../errors.js";

export interface LabelItem {
  variantId: string;
  copies: number;
}

export interface LabelData {
  title: string;
  detail: string;
  /** What the barcode scans as at the register: UPC/EAN if we have one, else our SKU. */
  code: string;
  sku: string;
  cashCents: number;
  /** Null when dual pricing is off. */
  cardCents: number | null;
  copies: number;
}

export async function labelData(prisma: PrismaClient, locationId: string, items: LabelItem[]): Promise<LabelData[]> {
  const location = await prisma.location.findUnique({ where: { id: locationId } });
  if (!location) throw notFound("Location");
  const variants = await prisma.variant.findMany({ where: { id: { in: items.map((i) => i.variantId) } }, include: { product: true } });
  return items.map((i) => {
    const v = variants.find((x) => x.id === i.variantId);
    if (!v) throw notFound(`Variant ${i.variantId}`);
    const p = v.product;
    const detail = [
      p.setCode && `${p.setCode}${p.collectorNumber ? ` #${p.collectorNumber}` : ""}`,
      v.condition,
      v.finish && v.finish !== "NONFOIL" ? v.finish.replace("_", " ") : null,
      v.size && `Size ${v.size}`,
      v.colorway,
      v.itemCondition,
      p.styleCode,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      title: p.title,
      detail,
      code: v.barcode ?? v.sku,
      sku: v.sku,
      cashCents: v.priceCents,
      cardCents: location.cardPriceBps > 0 ? cardPrice(v.priceCents, location.cardPriceBps) : null,
      copies: i.copies,
    };
  });
}

/** ZPL field data can't contain the ^ and ~ control characters. */
const zplText = (s: string) => s.replace(/[\^~]/g, " ");

/**
 * ZPL for Zebra thermal printers: 2.25" x 1.25" labels at 203 dpi.
 * Dual pricing labels show both prices at the same size so neither is hidden.
 */
export function labelsZpl(labels: LabelData[]): string {
  return labels
    .map((l) => {
      const prices =
        l.cardCents !== null
          ? [
              `^FO15,98^A0N,20,20^FDCASH^FS`,
              `^FO15,118^A0N,40,40^FD${formatCents(l.cashCents)}^FS`,
              `^FO235,98^A0N,20,20^FDCARD^FS`,
              `^FO235,118^A0N,40,40^FD${formatCents(l.cardCents)}^FS`,
            ]
          : [`^FO15,100^A0N,56,56^FD${formatCents(l.cashCents)}^FS`];
      return [
        "^XA",
        "^CI28",
        "^PW457",
        "^LL254",
        `^FO15,12^A0N,26,26^FB427,2,0,L^FD${zplText(l.title)}^FS`,
        `^FO15,68^A0N,20,20^FB427,1,0,L^FD${zplText(l.detail)}^FS`,
        ...prices,
        `^FO15,172^BY${l.code.length > 14 ? 1 : 2}^BCN,50,N,N,N^FD${zplText(l.code)}^FS`,
        `^FO15,228^A0N,18,18^FD${zplText(l.sku)}^FS`,
        `^PQ${l.copies}`,
        "^XZ",
      ].join("\n");
    })
    .join("\n");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** One label per page at 2.25" x 1.25", for AirPrint label printers or a plain printer. */
export function labelsHtml(labels: LabelData[]): string {
  const pages = labels.flatMap((l) => {
    const barcode = bwipjs.toSVG({ bcid: "code128", text: l.code, height: 7, includetext: false });
    const prices =
      l.cardCents !== null
        ? `<div class="prices"><div><small>CASH</small><b>${formatCents(l.cashCents)}</b></div><div><small>CARD</small><b>${formatCents(l.cardCents)}</b></div></div>`
        : `<div class="prices single"><b>${formatCents(l.cashCents)}</b></div>`;
    const page = `<section><h1>${esc(l.title)}</h1><p>${esc(l.detail)}</p>${prices}<div class="bc">${barcode}</div><p class="sku">${esc(l.sku)}</p></section>`;
    return Array.from({ length: l.copies }, () => page);
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:2.25in 1.25in;margin:0}*{box-sizing:border-box}body{margin:0;font-family:-apple-system,system-ui,sans-serif}
section{width:2.25in;height:1.25in;padding:.05in .08in;page-break-after:always;overflow:hidden}
h1{font-size:9pt;line-height:1.1;margin:0;max-height:2.2em;overflow:hidden}p{font-size:6.5pt;margin:1px 0;white-space:nowrap;overflow:hidden}
.prices{display:flex;gap:.1in;margin:2px 0}.prices div{flex:1}.prices small{display:block;font-size:6pt;font-weight:700}
.prices b{font-size:14pt}.prices.single b{font-size:18pt}.bc svg{height:.22in;width:100%}.sku{font-size:6pt}
</style></head><body>${pages.join("")}</body></html>`;
}

/** Send raw bytes (ZPL, ESC/POS) to a network printer over raw TCP, port 9100 by default. */
export function sendToPrinter(hostPort: string, data: string | Buffer, timeoutMs = 5_000): Promise<void> {
  const [host, port] = hostPort.split(":");
  if (!host) throw badRequest("PRINTER", "No printer configured");
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => {
      socket.destroy();
      reject(badRequest("PRINTER_UNREACHABLE", `Label printer at ${hostPort} didn't respond`));
    });
    socket.once("error", (e) => reject(badRequest("PRINTER_UNREACHABLE", `Label printer at ${hostPort}: ${e.message}`)));
    socket.connect(Number(port ?? 9100), host, () => socket.end(data, () => resolve()));
  });
}
