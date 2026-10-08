import type { ProductKind } from "./enums.js";
import { applyBps } from "./money.js";

/**
 * CASHBACK: customers earn a percentage of every eligible dollar as rewards
 *           dollars, spent like a tender.
 * POINTS:   customers earn points per eligible dollar and spend them on
 *           rewards the owner defines (% off, $ off, or a specific item).
 */
export const LoyaltyTypes = ["CASHBACK", "POINTS"] as const;
export type LoyaltyType = (typeof LoyaltyTypes)[number];

export const RewardTypes = ["PERCENT_OFF", "AMOUNT_OFF", "ITEM"] as const;
export type RewardType = (typeof RewardTypes)[number];

export interface LoyaltyProgramConfig {
  enabled: boolean;
  type: LoyaltyType;
  /** CASHBACK: rewards earned, in bps of eligible spend (2% = 200). */
  cashbackBps: number;
  /** POINTS: points earned per whole eligible dollar. */
  pointsPerDollar: number;
  /** Product kinds that neither earn nor take %/$-off rewards (e.g. event entries). */
  excludedKinds: ProductKind[];
  /** Whether spend paid with store credit / rewards earns. Usually off, so trade-in credit doesn't double-dip. */
  earnOnCredit: boolean;
}

export interface RewardDef {
  id: string;
  type: RewardType;
  pointsCost: number;
  /** PERCENT_OFF */
  percentBps?: number | null;
  /** AMOUNT_OFF: amount; PERCENT_OFF / ITEM: optional cap. */
  amountCents?: number | null;
  maxDiscountCents?: number | null;
  /** ITEM: the variant or product the reward discounts (one unit). */
  variantId?: string | null;
  productId?: string | null;
}

export interface LoyaltyLine {
  variantId: string;
  productId: string;
  kind: ProductKind;
  unitPriceCents: number;
  quantity: number;
  /** Discount already on the line before rewards. */
  discountCents: number;
}

const net = (l: LoyaltyLine, extra = 0) => l.unitPriceCents * l.quantity - l.discountCents - extra;

/** Split `amount` across lines in proportion to `weights`, putting rounding leftovers on the largest line. */
function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || amount <= 0) return weights.map(() => 0);
  const out = weights.map((w) => Math.floor((amount * w) / total));
  let left = amount - out.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length) {
    const i = order[k]![1];
    if (out[i]! < weights[i]!) {
      out[i]!++;
      left--;
    }
  }
  return out;
}

export class RewardNotApplicable extends Error {}

/**
 * Per-line reward discounts for a set of redeemed rewards, applied in order.
 * Throws RewardNotApplicable when a reward has nothing to discount.
 */
export function applyRewards(lines: LoyaltyLine[], rewards: RewardDef[], program: Pick<LoyaltyProgramConfig, "excludedKinds">): number[] {
  const extra = lines.map(() => 0);
  for (const r of rewards) {
    if (r.type === "ITEM") {
      const i = lines.findIndex(
        (l, j) => (r.variantId ? l.variantId === r.variantId : l.productId === r.productId) && net(l, extra[j]) > 0,
      );
      if (i < 0) throw new RewardNotApplicable("The reward item isn't in the cart");
      const l = lines[i]!;
      // One unit free, or up to the cap.
      const unitLeft = Math.min(l.unitPriceCents, net(l, extra[i]));
      extra[i]! += Math.min(unitLeft, r.maxDiscountCents ?? unitLeft);
      continue;
    }
    const weights = lines.map((l, j) => (program.excludedKinds.includes(l.kind) ? 0 : Math.max(0, net(l, extra[j]))));
    const base = weights.reduce((a, b) => a + b, 0);
    if (base <= 0) throw new RewardNotApplicable("Nothing in the cart is eligible for this reward");
    let amount = r.type === "PERCENT_OFF" ? applyBps(base, r.percentBps ?? 0) : (r.amountCents ?? 0);
    if (r.maxDiscountCents != null) amount = Math.min(amount, r.maxDiscountCents);
    amount = Math.min(amount, base);
    allocate(amount, weights).forEach((d, j) => (extra[j]! += d));
  }
  return extra;
}

/** Spend that earns, before credit-tender exclusion. */
export function eligibleSpend(lines: LoyaltyLine[], rewardDiscounts: number[], program: Pick<LoyaltyProgramConfig, "excludedKinds">): number {
  return lines.reduce((a, l, i) => a + (program.excludedKinds.includes(l.kind) ? 0 : Math.max(0, net(l, rewardDiscounts[i]))), 0);
}

/**
 * What a sale earns. `creditPaidCents` is the part of the order paid with
 * store credit or rewards dollars; it doesn't earn unless `earnOnCredit`.
 */
export function earnFor(program: LoyaltyProgramConfig, eligibleCents: number, orderTotalCents: number, creditPaidCents: number): number {
  if (!program.enabled || eligibleCents <= 0) return 0;
  let base = eligibleCents;
  if (!program.earnOnCredit && creditPaidCents > 0 && orderTotalCents > 0) {
    base = Math.max(0, Math.round(eligibleCents * (1 - creditPaidCents / orderTotalCents)));
  }
  return program.type === "CASHBACK"
    ? Math.floor((base * program.cashbackBps) / 10_000)
    : Math.floor(base / 100) * program.pointsPerDollar;
}
