import { CartLine, LoyaltyProgramInput, RewardInput } from "@mypos/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "../errors.js";
import { parse, requireRole } from "../http.js";
import type { Ctx } from "../services/context.js";
import { getProgram, loyaltyBalances, postLoyalty } from "../services/loyalty.js";
import { quoteCart } from "../services/quote.js";

export function loyaltyRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const staff = { preHandler: requireRole("CASHIER") };
  const manager = { preHandler: requireRole("MANAGER") };
  const owner = { preHandler: requireRole("OWNER") };

  app.get("/loyalty/program", staff, async () => getProgram(prisma));

  /** Owner sets the program type and earn rate. Existing balances are kept if the type changes. */
  app.put("/loyalty/program", owner, async (req) => {
    const data = parse(LoyaltyProgramInput, req.body);
    if (data.enabled && data.type === "CASHBACK" && data.cashbackBps === 0) throw badRequest("EARN_RATE", "Set a cashback percentage");
    if (data.enabled && data.type === "POINTS" && data.pointsPerDollar === 0) throw badRequest("EARN_RATE", "Set points per dollar");
    return prisma.loyaltyProgram.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  });

  app.get("/loyalty/rewards", staff, async (req) => {
    const { all } = parse(z.object({ all: z.coerce.boolean().default(false) }), req.query);
    return prisma.loyaltyReward.findMany({ where: all ? {} : { active: true }, orderBy: { pointsCost: "asc" } });
  });

  app.post("/loyalty/rewards", owner, async (req, reply) => {
    const data = parse(RewardInput, req.body);
    if (data.variantId && !(await prisma.variant.findUnique({ where: { id: data.variantId } }))) throw notFound("Variant");
    if (data.productId && !(await prisma.product.findUnique({ where: { id: data.productId } }))) throw notFound("Product");
    return reply.code(201).send(await prisma.loyaltyReward.create({ data }));
  });

  app.patch("/loyalty/rewards/:id", owner, async (req) => {
    const { id } = req.params as { id: string };
    const data = parse(
      z.object({ name: z.string().min(1).optional(), pointsCost: z.number().int().positive().optional(), active: z.boolean().optional() }),
      req.body,
    );
    return prisma.loyaltyReward.update({ where: { id }, data });
  });

  app.get("/customers/:id/loyalty", staff, async (req) => {
    const { id } = req.params as { id: string };
    const [balances, history] = await Promise.all([
      loyaltyBalances(prisma, id),
      prisma.loyaltyEntry.findMany({ where: { customerId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    return { ...balances, history };
  });

  app.post("/customers/:id/loyalty", manager, async (req) => {
    const { id } = req.params as { id: string };
    const e = parse(z.object({ unit: z.enum(["POINTS", "CENTS"]), amount: z.number().int(), reason: z.string().min(1) }), req.body);
    await prisma.$transaction((tx) => postLoyalty(tx, { customerId: id, ...e }));
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
