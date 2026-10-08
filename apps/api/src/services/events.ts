import type { EventInput } from "@mypos/shared";
import { notFound } from "../errors.js";
import type { Ctx } from "./context.js";

/** An event is backed by an EVENT_ENTRY variant so entries ring up like any other item. */
export async function createEvent(ctx: Ctx, input: EventInput) {
  return ctx.prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        kind: "EVENT_ENTRY",
        title: `Entry: ${input.name}`,
        game: input.game,
        channels: ["POS", "STOREFRONT"],
        variants: {
          create: {
            sku: `EVT-${Date.now().toString(36).toUpperCase()}`,
            priceCents: input.entryFeeCents,
            // Event entry fees are commonly non-taxable admissions; adjust per jurisdiction.
            taxable: false,
          },
        },
      },
      include: { variants: true },
    });
    return tx.event.create({ data: { ...input, variantId: product.variants[0]!.id } });
  });
}

export async function eventRoster(ctx: Ctx, eventId: string) {
  const event = await ctx.prisma.event.findUnique({
    where: { id: eventId },
    include: { registrations: { include: { customer: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!event) throw notFound("Event");
  return {
    ...event,
    spotsLeft: event.capacity - event.registrations.length,
    roster: event.registrations.map((r) => ({
      registrationId: r.id,
      customerId: r.customerId,
      name: r.customer.name,
      playerIds: r.customer.playerIds,
      checkedIn: r.checkedIn,
    })),
  };
}

export async function checkIn(ctx: Ctx, registrationId: string) {
  return ctx.prisma.eventRegistration.update({ where: { id: registrationId }, data: { checkedIn: true } });
}
