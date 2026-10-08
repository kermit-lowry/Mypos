import { CartLine, LoyaltyProgramInput, RewardInput } from "@mypos/shared";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "../errors.js";
import { parse, requirePermission, requireRole } from "../http.js";
import type { Ctx } from "../services/context.js";
import { getProgram, loyaltyBalances, postLoyalty } from "../services/loyalty.js";
import { audit, changes } from "../services/permissions.js";
import { quoteCart } from "../services/quote.js";

/** Fields a PATCH actually changed, as { field: { from, to } }, for the activity log. */
export function loyaltyRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireRole("CASHIER") };

  app.get("/loyalty/program", staff, async () => getProgram(prisma));

  /** Owner sets the program type and earn rate. Existing balances are kept if the type changes. */
  app.put("/loyalty/program", { preHandler: requirePermission("MANAGE_LOYALTY") }, async (req) => {
    const data = parse(LoyaltyProgramInput, req.body);
    if (data.enabled && data.type === "CASHBACK" && data.cashbackBps === 0) throw badRequest("EARN_RATE", "Set a cashback percentage");
    if (data.enabled && data.type === "POINTS" && data.pointsPerDollar === 0) throw badRequest("EARN_RATE", "Set points per dollar");
    const { id, updatedAt, ...before } = await getProgram(prisma);
    const saved = await prisma.loyaltyProgram.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
    await audit(prisma, { action: "LOYALTY_PROGRAM_UPDATED", staffId: req.user.sub, details: { before, after: data } });
    return saved;
  });

  app.get("/loyalty/rewards", staff, async (req) => {
    const { all } = parse(z.object({ all: z.coerce.boolean().default(false) }), req.query);
    return prisma.loyaltyReward.findMany({ where: all ? {} : { active: true }, orderBy: { pointsCost: "asc" } });
  });

  app.post("/loyalty/rewards", { preHandler: requirePermission("MANAGE_LOYALTY") }, async (req, reply) => {
    const data = parse(RewardInput, req.body);
    if (data.variantId && !(await prisma.variant.findUnique({ where: { id: data.variantId } }))) throw notFound("Variant");
    if (data.productId && !(await prisma.product.findUnique({ where: { id: data.productId } }))) throw notFound("Product");
    const reward = await prisma.loyaltyReward.create({ data });
    await audit(prisma, { action: "LOYALTY_REWARD_CREATED", staffId: req.user.sub, details: { rewardId: reward.id, name: reward.name, pointsCost: reward.pointsCost, type: reward.type } });
    return reply.code(201).send(reward);
  });

  app.patch("/loyalty/rewards/:id", { preHandler: requirePermission("MANAGE_LOYALTY") }, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(
      z.object({ name: z.string().min(1).optional(), pointsCost: z.number().int().positive().optional(), active: z.boolean().optional() }),
      req.body,
    );
    const before = await prisma.loyaltyReward.findUnique({ where: { id } });
    if (!before) throw notFound("Reward");
    const updated = await prisma.loyaltyReward.update({ where: { id }, data });
    await audit(prisma, { action: "LOYALTY_REWARD_UPDATED", staffId: req.user.sub, details: { rewardId: id, name: updated.name, changes: changes(before, data) } });
    return updated;
  });

  app.get("/customers/:id/loyalty", staff, async (req) => {
    const { id } = req.params as { id: string };
    const [balances, history] = await Promise.all([
      loyaltyBalances(prisma, id),
      prisma.loyaltyEntry.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    return { ...balances, history };
  });

  app.post("/customers/:id/loyalty", { preHandler: requirePermission("ADJUST_BALANCES") }, async (req) => {
    const { id } = req.params as { id: string };
    const e = parse(z.object({ unit: z.enum(["POINTS", "CENTS"]), amount: z.number().int(), reason: z.string().min(1) }), req.body);
    await prisma.$transaction(async (tx) => {
      await postLoyalty(tx, { customerId: id, ...e });
      const bal = await loyaltyBalances(tx, id);
      await audit(tx, {
        action: "BALANCE_ADJUSTED",
        staffId: req.user.sub,
        approverId: req.approverId,
        details: {
          customerId: id,
          kind: e.unit === "POINTS" ? "POINTS" : "CASHBACK",
          amount: e.amount,
          reason: e.reason,
          balanceAfter: e.unit === "POINTS" ? bal.points : bal.rewardsCents,
        },
      });
    });
    return loyaltyBalances(prisma, id);
  });

  /** Register preview: deals, rewards, cash/card totals, and what the sale earns. Charges nothing. */
  const QuoteInput = z.object({
    locationId: z.string(),
    customerId: z.string().optional(),
    lines: z.array(CartLine).min(1),
    rewardIds: z.array(z.string()).default([]),
    creditPaidCents: z.number().int().nonnegative().default(0),
  });
  for (const path of ["/cart/quote", "/loyalty/quote"]) {
    app.post(path, staff, async (req) => quoteCart(prisma, { ...parse(QuoteInput, req.body), channel: "POS" }));
  }
}
