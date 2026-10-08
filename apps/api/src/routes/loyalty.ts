import { CartLine, LoyaltyProgramInput, RewardInput, cartTotals, earnFor } from "@mypos/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "../errors.js";
import { parse, requireRole } from "../http.js";
import type { Ctx } from "../services/context.js";
import { earns, getProgram, loyaltyBalances, postLoyalty, priceRewards, unitFor } from "../services/loyalty.js";

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

  /** Register preview: reward discounts, totals, and what the sale will earn. Charges nothing. */
  app.post("/loyalty/quote", staff, async (req) => {
    const input = parse(
      z.object({
        locationId: z.string(),
        customerId: z.string().optional(),
        lines: z.array(CartLine).min(1),
        rewardIds: z.array(z.string()).default([]),
        creditPaidCents: z.number().int().nonnegative().default(0),
      }),
      req.body,
    );
    const [program, location, variants] = await Promise.all([
      getProgram(prisma),
      prisma.location.findUniqueOrThrow({ where: { id: input.locationId } }),
      prisma.variant.findMany({ where: { id: { in: input.lines.map((l) => l.variantId) } }, include: { product: true } }),
    ]);
    const lines = input.lines.map((l) => {
      const v = variants.find((x) => x.id === l.variantId);
      if (!v) throw notFound(`Variant ${l.variantId}`);
      const unitPriceCents = l.unitPriceCents ?? v.priceCents;
      return {
        variantId: v.id,
        productId: v.productId,
        kind: v.product.kind,
        unitPriceCents,
        quantity: l.quantity,
        discountCents: Math.min(l.discountCents, unitPriceCents * l.quantity),
        taxable: v.taxable,
      };
    });
    const { discounts, pointsCost } = await priceRewards(prisma, program, lines, input.rewardIds);
    const final = lines.map((l, i) => ({ ...l, discountCents: l.discountCents + discounts[i]! }));
    const totals = cartTotals(final, location.taxRateBps);
    const eligible = final.reduce((a, l) => a + (earns(program, l.kind) ? l.unitPriceCents * l.quantity - l.discountCents : 0), 0);
    return {
      ...totals,
      rewardDiscounts: discounts,
      pointsCost,
      earn: input.customerId ? { unit: unitFor(program), amount: earnFor(program, eligible, totals.totalCents, input.creditPaidCents) } : null,
      balances: input.customerId ? await loyaltyBalances(prisma, input.customerId) : null,
    };
  });
}
