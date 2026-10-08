import type { Db, Tx } from "../db.js";
import { conflict } from "../errors.js";

export async function creditBalance(db: Db, customerId: string): Promise<number> {
  const agg = await db.storeCreditEntry.aggregate({ where: { customerId }, _sum: { amountCents: true } });
  return agg._sum.amountCents ?? 0;
}

/**
 * Append a ledger entry. Debits lock the customer row first so concurrent
 * spends of the same balance serialize instead of overdrawing.
 */
export async function postCredit(
  tx: Tx,
  entry: { customerId: string; amountCents: number; reason: string; orderId?: string; buylistId?: string },
): Promise<number> {
  if (entry.amountCents < 0) {
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${entry.customerId} FOR UPDATE`;
    const balance = await creditBalance(tx, entry.customerId);
    if (balance + entry.amountCents < 0) {
      throw conflict("INSUFFICIENT_CREDIT", "Store credit balance too low", { balance, requested: -entry.amountCents });
    }
  }
  await tx.storeCreditEntry.create({ data: entry });
  return creditBalance(tx, entry.customerId);
}
