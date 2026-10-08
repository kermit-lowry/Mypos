import { applyBps } from "./money.js";

/**
 * Automated discounts ("deals"). The merchant defines rules; the register and
 * web store apply them automatically to every cart.
 *
 *   PERCENT_OFF     x% off each matching item
 *   AMOUNT_OFF      $x off each matching item
 *   SALE_PRICE      matching items sell for $x each
 *   BUY_X_GET_Y     buy X, get Y at a discount (100% = free). "BOGO 50%" etc.
 *   MULTI_BUY       X matching items for $y total ("3 for $10")
 *   ORDER_DISCOUNT  spend $x on matching items, get % or $ off them
 */
export const PromotionTypes = ["PERCENT_OFF", "AMOUNT_OFF", "SALE_PRICE", "BUY_X_GET_Y", "MULTI_BUY", "ORDER_DISCOUNT"] as const;
export type PromotionType = (typeof PromotionTypes)[number];

export interface PromoTargets {
  /** Every item (minus exclusions). */
  all?: boolean;
  productIds?: string[];
  variantIds?: string[];
  /** A category includes all of its subcategories. */
  categoryIds?: string[];
}

export interface PromoSchedule {
  /** Absolute window (calendar range). */
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  /** Specific local dates, "YYYY-MM-DD". Empty = any date. */
  dates?: string[];
  /** Local days of week, 0 = Sunday. Empty = every day. */
  daysOfWeek?: number[];
  /** Local time window "HH:MM"; end before start wraps past midnight. */
  startTime?: string | null;
  endTime?: string | null;
}

export interface PromoDef extends PromoSchedule {
  id: string;
  name: string;
  type: PromotionType;
  /** Lower runs first. */
  priority: number;
  /** Stackable deals can apply on top of other deals; others claim the items they use. */
  stackable: boolean;
  targets: PromoTargets;
  exclude?: { productIds?: string[]; categoryIds?: string[] };
  /** BUY_X_GET_Y: what the "get" items are. Defaults to the same as `targets`. */
  getTargets?: PromoTargets | null;
  percentBps?: number | null;
  amountCents?: number | null;
  /** SALE_PRICE: price each; MULTI_BUY: price for the group. */
  priceCents?: number | null;
  buyQty?: number | null;
  getQty?: number | null;
  /** BUY_X_GET_Y: discount on the "get" items; 10_000 = free. */
  getDiscountBps?: number | null;
  /** Needs at least this many matching items in the cart. */
  minQty?: number | null;
  /** ORDER_DISCOUNT: matching items must total at least this. */
  minSubtotalCents?: number | null;
  /** Max times a deal applies per order (BOGO pairs, multi-buy groups). */
  maxApplications?: number | null;
}

export interface PromoLine {
  variantId: string;
  productId: string;
  /** The product's category and all its ancestors. */
  categoryIds: string[];
  unitPriceCents: number;
  quantity: number;
}

export interface AppliedPromotion {
  promotionId: string;
  name: string;
  discountCents: number;
}

export interface PromoResult {
  /** Discount per cart line, same order as the input. */
  lineDiscounts: number[];
  applied: AppliedPromotion[];
}

// ── Schedule ─────────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local date/weekday/minutes in the store's time zone. */
export function localParts(now: Date, timeZone: string): { date: string; weekday: number; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(parts.weekday!),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** Whether a deal is running at `now` in the store's time zone. */
export function isScheduledNow(s: PromoSchedule, now: Date, timeZone: string): boolean {
  if (s.startsAt && now < new Date(s.startsAt)) return false;
  if (s.endsAt && now >= new Date(s.endsAt)) return false;
  const local = localParts(now, timeZone);
  if (s.dates?.length && !s.dates.includes(local.date)) return false;
  if (s.daysOfWeek?.length && !s.daysOfWeek.includes(local.weekday)) return false;
  if (s.startTime && s.endTime) {
    const start = toMinutes(s.startTime);
    const end = toMinutes(s.endTime);
    const inWindow = start <= end ? local.minutes >= start && local.minutes < end : local.minutes >= start || local.minutes < end;
    if (!inWindow) return false;
  }
  return true;
}

// ── Matching ─────────────────────────────────────────────────────

function matches(t: PromoTargets, line: PromoLine): boolean {
  if (t.all) return true;
  return (
    !!t.variantIds?.includes(line.variantId) ||
    !!t.productIds?.includes(line.productId) ||
    !!t.categoryIds?.some((c) => line.categoryIds.includes(c))
  );
}

function excluded(p: PromoDef, line: PromoLine): boolean {
  return !!p.exclude?.productIds?.includes(line.productId) || !!p.exclude?.categoryIds?.some((c) => line.categoryIds.includes(c));
}

// ── Engine ───────────────────────────────────────────────────────

interface Unit {
  line: number;
  price: number;
  /** Price left after deals so far. */
  remaining: number;
  /** Some deal used this unit. */
  touched: boolean;
  /** A non-stackable deal claimed it; nothing else may use it. */
  locked: boolean;
}

/** Split `amount` across units in proportion to their remaining price. */
function allocate(units: Unit[], amount: number): number[] {
  const base = units.reduce((a, u) => a + u.remaining, 0);
  if (base <= 0 || amount <= 0) return units.map(() => 0);
  const out = units.map((u) => Math.floor((amount * u.remaining) / base));
  let left = Math.min(amount, base) - out.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % units.length) {
    if (out[i]! < units[i]!.remaining) {
      out[i]!++;
      left--;
    }
  }
  return out;
}

const byPriceDesc = (a: Unit, b: Unit) => b.remaining - a.remaining || a.line - b.line;

/**
 * Apply every running deal to a cart. Deals run in priority order. A
 * non-stackable deal only uses items no other deal has touched, and claims
 * them. Stackable deals apply to whatever price is left on unclaimed items.
 */
export function applyPromotions(lines: PromoLine[], promos: PromoDef[]): PromoResult {
  const units: Unit[] = lines.flatMap((l, line) =>
    Array.from({ length: l.quantity }, () => ({ line, price: l.unitPriceCents, remaining: l.unitPriceCents, touched: false, locked: false })),
  );
  const lineDiscounts = lines.map(() => 0);
  const applied: AppliedPromotion[] = [];

  const ordered = [...promos].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const p of ordered) {
    const available = (t: PromoTargets) =>
      units.filter((u) => {
        const line = lines[u.line]!;
        return !u.locked && (p.stackable || !u.touched) && u.remaining > 0 && matches(t, line) && !excluded(p, line);
      });
    const eligible = available(p.targets);
    if (p.minQty && eligible.length < p.minQty) continue;

    // unit -> discount for this deal; `used` = units the deal relies on (incl. BOGO "buy" items).
    const discounts = new Map<Unit, number>();
    const used = new Set<Unit>();
    const max = p.maxApplications ?? Infinity;

    switch (p.type) {
      case "PERCENT_OFF":
        for (const u of eligible) discounts.set(u, Math.min(u.remaining, applyBps(u.remaining, p.percentBps ?? 0)));
        break;
      case "AMOUNT_OFF":
        for (const u of eligible) discounts.set(u, Math.min(u.remaining, p.amountCents ?? 0));
        break;
      case "SALE_PRICE":
        for (const u of eligible) if (p.priceCents != null && u.remaining > p.priceCents) discounts.set(u, u.remaining - p.priceCents);
        break;
      case "MULTI_BUY": {
        const n = p.buyQty ?? 0;
        const pool = [...eligible].sort(byPriceDesc);
        for (let g = 0; n > 0 && g < max && pool.length >= n; g++) {
          const group = pool.splice(0, n);
          const total = group.reduce((a, u) => a + u.remaining, 0);
          if (p.priceCents == null || total <= p.priceCents) break;
          allocate(group, total - p.priceCents).forEach((d, i) => discounts.set(group[i]!, d));
          group.forEach((u) => used.add(u));
        }
        break;
      }
      case "BUY_X_GET_Y": {
        const x = p.buyQty ?? 0;
        const y = p.getQty ?? 0;
        if (x <= 0 || y <= 0) break;
        const sameSet = !p.getTargets;
        const buyPool = [...eligible].sort(byPriceDesc);
        const getPool = (sameSet ? buyPool : available(p.getTargets!)).slice().sort(byPriceDesc);
        const taken = new Set<Unit>();
        for (let app = 0; app < max; app++) {
          const buys = buyPool.filter((u) => !taken.has(u)).slice(0, x);
          if (buys.length < x) break;
          buys.forEach((u) => taken.add(u));
          const cheapestBuy = Math.min(...buys.map((u) => u.remaining));
          // Same items: the free one is of equal or lesser value. Different
          // items (buy a box, get sleeves): the cheapest matching ones.
          const candidates = getPool.filter((u) => !taken.has(u) && (!sameSet || u.remaining <= cheapestBuy));
          const gets = sameSet ? candidates.slice(0, y) : candidates.slice(-y).reverse();
          if (gets.length < y) {
            buys.forEach((u) => taken.delete(u));
            break;
          }
          gets.forEach((u) => {
            taken.add(u);
            discounts.set(u, Math.min(u.remaining, applyBps(u.remaining, p.getDiscountBps ?? 10_000)));
          });
          buys.forEach((u) => used.add(u));
        }
        break;
      }
      case "ORDER_DISCOUNT": {
        const base = eligible.reduce((a, u) => a + u.remaining, 0);
        if (base <= 0 || base < (p.minSubtotalCents ?? 0)) break;
        let amount = p.percentBps ? applyBps(base, p.percentBps) : (p.amountCents ?? 0);
        amount = Math.min(amount, base);
        allocate(eligible, amount).forEach((d, i) => discounts.set(eligible[i]!, d));
        break;
      }
    }

    let total = 0;
    for (const [u, d] of discounts) {
      if (d <= 0) continue;
      u.remaining -= d;
      lineDiscounts[u.line]! += d;
      total += d;
      used.add(u);
    }
    if (total === 0) continue;
    for (const u of used) {
      u.touched = true;
      if (!p.stackable) u.locked = true;
    }
    applied.push({ promotionId: p.id, name: p.name, discountCents: total });
  }

  return { lineDiscounts, applied };
}
