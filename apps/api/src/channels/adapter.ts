import type { SalesChannel } from "@prisma/client";

export interface ExternalOrderLine {
  /** The channel's listing id, matched against ChannelListing.externalId. */
  listingId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface ExternalOrder {
  externalId: string;
  createdAt: Date;
  customerEmail?: string;
  customerName?: string;
  lines: ExternalOrderLine[];
  taxCents: number;
  totalCents: number;
}

/**
 * Every outside sales channel (Shopify, TCGplayer, eBay) implements this.
 * MyPOS is the inventory source of truth: it pushes available quantities out
 * and pulls paid orders in.
 */
export interface ChannelAdapter {
  readonly channel: SalesChannel;
  enabled(): boolean;
  setQuantity(listing: { externalId: string; inventoryRef: string | null }, available: number): Promise<void>;
  /** Paid orders since `cursor`; returns the cursor to use next time. */
  fetchOrders(cursor: string | null): Promise<{ orders: ExternalOrder[]; cursor: string | null }>;
}
