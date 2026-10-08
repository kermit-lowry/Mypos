import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { syncAll } from "../channels/sync.js";
import { parse, requireRole } from "../http.js";
import type { Ctx } from "../services/context.js";

export function adminRoutes(app: FastifyInstance, base: Ctx) {
  const { prisma } = base;
  const manager = { preHandler: requireRole("MANAGER") };

  app.get("/locations", { preHandler: requireRole("CASHIER") }, async () => prisma.location.findMany({ orderBy: { name: "asc" } }));

  app.post("/channels/listings", manager, async (req) => {
    const input = parse(
      z.object({
        variantId: z.string(),
        channel: z.enum(["SHOPIFY", "TCGPLAYER", "EBAY"]),
        externalId: z.string().min(1),
        inventoryRef: z.string().optional(),
      }),
      req.body,
    );
    return prisma.channelListing.upsert({
      where: { variantId_channel: { variantId: input.variantId, channel: input.channel } },
      create: input,
      update: { externalId: input.externalId, inventoryRef: input.inventoryRef, lastPushed: null },
    });
  });

  app.post("/channels/sync", manager, async (req) => {
    const { locationId } = parse(z.object({ locationId: z.string() }), req.body);
    return syncAll(prisma, locationId);
  });

  /** End-of-day: sales by tender and product type, refunds, and buylist payouts. */
  app.get("/reports/daily", manager, async (req) => {
    const { locationId, date } = parse(z.object({ locationId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.query);
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const [payments, lines, buylists, adjustments] = await Promise.all([
      prisma.payment.groupBy({
        by: ["tender"],
        where: { status: "APPROVED", createdAt: { gte: start, lt: end }, OR: [{ order: { locationId } }, { preorder: { locationId } }] },
        _sum: { amountCents: true, changeCents: true },
      }),
      prisma.orderLine.findMany({
        where: { order: { locationId, status: { not: "VOID" }, createdAt: { gte: start, lt: end } } },
        include: { variant: { include: { product: { select: { kind: true } } } } },
      }),
      prisma.buylistTicket.groupBy({
        by: ["payout"],
        where: { locationId, status: "ACCEPTED", acceptedAt: { gte: start, lt: end } },
        _sum: { paidCents: true },
        _count: true,
      }),
      prisma.order.aggregate({
        where: { locationId, status: { not: "VOID" }, createdAt: { gte: start, lt: end } },
        _sum: { cardAdjustmentCents: true, cardAdjustmentTaxCents: true, taxCents: true },
      }),
    ]);
    const byKind: Record<string, { units: number; netCents: number; costCents: number }> = {};
    for (const l of lines) {
      const k = (byKind[l.variant.product.kind] ??= { units: 0, netCents: 0, costCents: 0 });
      const units = l.quantity - l.refundedQty;
      k.units += units;
      k.netCents += Math.round(((l.unitPriceCents * l.quantity - l.discountCents) * units) / l.quantity);
      k.costCents += (l.variant.costCents ?? 0) * units;
    }
    return {
      date,
      tenders: payments.map((p) => ({ tender: p.tender, netCents: p._sum.amountCents ?? 0 })),
      byKind,
      tax: {
        collectedCents: (adjustments._sum.taxCents ?? 0) + (adjustments._sum.cardAdjustmentTaxCents ?? 0),
      },
      /** Extra collected from card-priced payments (dual pricing), including its tax. */
      cardPriceAdjustmentCents: adjustments._sum.cardAdjustmentCents ?? 0,
      buylist: buylists.map((b) => ({ payout: b.payout, tickets: b._count, paidCents: b._sum.paidCents ?? 0 })),
    };
  });
}
