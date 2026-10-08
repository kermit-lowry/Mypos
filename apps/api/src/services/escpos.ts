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
