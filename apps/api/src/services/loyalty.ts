import type { LoyaltyProgram, LoyaltyUnit, ProductKind } from "@prisma/client";
import { applyRewards, RewardNotApplicable, type LoyaltyLine, type RewardDef } from "@mypos/shared";
import type { Db, Tx } from "../db.js";
import { badRequest, conflict } from "../errors.js";

export async function getProgram(db: Db): Promise<LoyaltyProgram> {
  return (
    (await db.loyaltyProgram.findUnique({ where: { id: "default" } })) ??
    // Not configured yet: disabled until the owner sets it up.
    { id: "default", enabled: false, type: "POINTS", cashbackBps: 0, pointsPerDollar: 1, excludedKinds: [], earnOnCredit: false, updatedAt: new Date(0) }
  );
}

export const unitFor = (p: Pick<LoyaltyProgram, "type">): LoyaltyUnit => (p.type === "CASHBACK" ? "CENTS" : "POINTS");

export async function loyaltyBalances(db: Db, customerId: string): Promise<{ points: number; rewardsCents: number }> {
  const rows = await db.loyaltyEntry.groupBy({ by: ["unit"], where: { customerId }, _sum: { amount: true } });
  const get = (u: LoyaltyUnit) => rows.find((r) => r.unit === u)?._sum.amount ?? 0;
  return { points: get("POINTS"), rewardsCents: get("CENTS") };
}

/**
 * Append a ledger entry. Spends lock the customer row so two registers can't
 * spend the same balance. Clawbacks pass `allowNegative`: if the customer
 * already spent what a refunded sale earned, they go negative and earn it back.
 */
export async function postLoyalty(
  tx: Tx,
  e: { customerId: string; unit: LoyaltyUnit; amount: number; reason: string; orderId?: string; rewardId?: string },
  opts: { allowNegative?: boolean } = {},
): Promise<void> {
  if (e.amount === 0) return;
  if (e.amount < 0 && !opts.allowNegative) {
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${e.customerId} FOR UPDATE`;
    const bal = await loyaltyBalances(tx, e.customerId);
    const have = e.unit === "POINTS" ? bal.points : bal.rewardsCents;
    if (have + e.amount < 0) {
      throw conflict(e.unit === "POINTS" ? "INSUFFICIENT_POINTS" : "INSUFFICIENT_REWARDS", "Loyalty balance too low", {
        balance: have,
        requested: -e.amount,
      });
    }
  }
  await tx.loyaltyEntry.create({ data: e });
}

export interface PricedRewards {
  rewards: RewardDef[];
  /** Extra discount per cart line, same order as the cart. */
  discounts: number[];
  pointsCost: number;
}

/** Validate redeemed rewards against the program and work out their line discounts. */
export async function priceRewards(
  db: Db,
  program: LoyaltyProgram,
  lines: LoyaltyLine[],
  rewardIds: string[],
): Promise<PricedRewards> {
  if (rewardIds.length === 0) return { rewards: [], discounts: lines.map(() => 0), pointsCost: 0 };
  if (!program.enabled || program.type !== "POINTS") throw badRequest("REWARDS_DISABLED", "Points rewards aren't enabled");
  const found = await db.loyaltyReward.findMany({ where: { id: { in: rewardIds }, active: true } });
  const rewards = rewardIds.map((id) => {
    const r = found.find((f) => f.id === id);
    if (!r) throw badRequest("REWARD_UNAVAILABLE", `Reward ${id} isn't available`);
    return r;
  });
  try {
    const discounts = applyRewards(lines, rewards, program);
    return { rewards, discounts, pointsCost: rewards.reduce((a, r) => a + r.pointsCost, 0) };
  } catch (e) {
    if (e instanceof RewardNotApplicable) throw badRequest("REWARD_NOT_APPLICABLE", e.message);
    throw e;
  }
}

export const earns = (program: Pick<LoyaltyProgram, "excludedKinds">, kind: ProductKind) => !program.excludedKinds.includes(kind);
