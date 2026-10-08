import type { PrismaClient, SalesChannel } from "@prisma/client";
import type { ChannelAdapter, ExternalOrder } from "./adapter.js";
import { moveInventory } from "../services/inventory.js";
import { describeVariant } from "../services/checkout.js";
import { EbayAdapter } from "./ebay.js";
import { ShopifyAdapter } from "./shopify.js";
import { TcgplayerAdapter } from "./tcgplayer.js";

export const defaultAdapters = (): ChannelAdapter[] => [new ShopifyAdapter(), new TcgplayerAdapter(), new EbayAdapter()];

/** Units sellable online: on hand minus reserved, summed across locations. */
export async function availableFor(prisma: PrismaClient, variantId: string): Promise<number> {
  const levels = await prisma.inventoryLevel.findMany({ where: { variantId } });
  return Math.max(0, levels.reduce((a, l) => a + l.onHand - l.reserved, 0));
}

/** Push quantities that changed since the last push. */
export async function pushInventory(prisma: PrismaClient, adapter: ChannelAdapter) {
  const listings = await prisma.channelListing.findMany({ where: { channel: adapter.channel } });
  let pushed = 0;
  let failed = 0;
  for (const listing of listings) {
    const available = await availableFor(prisma, listing.variantId);
    if (available === listing.lastPushed) continue;
    try {
      await adapter.setQuantity(listing, available);
      await prisma.channelListing.update({ where: { id: listing.id }, data: { lastPushed: available, lastSyncAt: new Date(), lastError: null } });
      pushed++;
    } catch (e) {
      await prisma.channelListing.update({ where: { id: listing.id }, data: { lastError: e instanceof Error ? e.message : String(e) } });
      failed++;
    }
  }
  return { pushed, failed };
}

/**
 * Record a paid outside order and take the stock out of `locationId`.
 * Idempotent on (channel, externalId). Lines whose listing we don't know are
 * skipped and reported so staff can link them.
 */
export async function importOrder(prisma: PrismaClient, channel: SalesChannel, locationId: string, ext: ExternalOrder) {
  const dupe = await prisma.order.findUnique({ where: { channel_externalId: { channel, externalId: ext.externalId } } });
  if (dupe) return { imported: false, unmatched: [] as string[] };

  const listings = await prisma.channelListing.findMany({
    where: { channel, externalId: { in: ext.lines.map((l) => l.listingId) } },
    include: { variant: { include: { product: true } } },
  });
  const byListing = new Map(listings.map((l) => [l.externalId, l]));
  const unmatched = ext.lines.filter((l) => !byListing.has(l.listingId)).map((l) => l.listingId);
  const matched = ext.lines.filter((l) => byListing.has(l.listingId));
  const subtotal = matched.reduce((a, l) => a + l.unitPriceCents * l.quantity, 0);

  await prisma.$transaction(async (tx) => {
    const customer = ext.customerEmail
      ? await tx.customer.upsert({
          where: { email: ext.customerEmail },
          create: { email: ext.customerEmail, name: ext.customerName ?? ext.customerEmail },
          update: {},
        })
      : null;
    const order = await tx.order.create({
      data: {
        channel,
        externalId: ext.externalId,
        status: "PAID",
        locationId,
        customerId: customer?.id,
        subtotalCents: subtotal,
        discountCents: 0,
        taxCents: ext.taxCents,
        totalCents: ext.totalCents,
        createdAt: ext.createdAt,
        note: unmatched.length ? `Unmatched listings: ${unmatched.join(", ")}` : undefined,
      },
    });
    for (const l of matched) {
      const listing = byListing.get(l.listingId)!;
      await tx.orderLine.create({
        data: {
          orderId: order.id,
          variantId: listing.variantId,
          title: describeVariant(listing.variant.product.title, listing.variant),
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          taxable: listing.variant.taxable,
        },
      });
      // The channel already sold it, so record the sale even if it oversells us.
      await moveInventory(tx, {
        variantId: listing.variantId,
        locationId,
        delta: -l.quantity,
        reason: "SALE",
        orderId: order.id,
        strict: false,
        note: `${channel} order ${ext.externalId}`,
      });
    }
    await tx.payment.create({
      data: { orderId: order.id, amountCents: ext.totalCents, tender: "EXTERNAL", status: "APPROVED", gateway: channel, gatewayRef: ext.externalId },
    });
  });
  return { imported: true, unmatched };
}

export async function pullOrders(prisma: PrismaClient, adapter: ChannelAdapter, locationId: string) {
  const state = await prisma.channelSyncCursor.findUnique({ where: { channel: adapter.channel } });
  const { orders, cursor } = await adapter.fetchOrders(state?.cursor ?? null);
  let imported = 0;
  const unmatched: string[] = [];
  for (const o of orders) {
    const r = await importOrder(prisma, adapter.channel, locationId, o);
    if (r.imported) imported++;
    unmatched.push(...r.unmatched);
  }
  await prisma.channelSyncCursor.upsert({
    where: { channel: adapter.channel },
    create: { channel: adapter.channel, cursor },
    update: { cursor },
  });
  return { fetched: orders.length, imported, unmatched };
}

/** One sync pass across all configured channels. */
export async function syncAll(prisma: PrismaClient, locationId: string, adapters: ChannelAdapter[] = defaultAdapters()) {
  const results: Record<string, unknown> = {};
  for (const a of adapters.filter((a) => a.enabled())) {
    try {
      results[a.channel] = { orders: await pullOrders(prisma, a, locationId), inventory: await pushInventory(prisma, a) };
    } catch (e) {
      results[a.channel] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return results;
}
