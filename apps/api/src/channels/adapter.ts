import type { SalesChannel } from "@prisma/client";

export interface ExternalOrderLine {
  /** The channel's listing id, matched against ChannelListing.externalId. */
  listingId: string;
  quantity: number;
  unitPriceCents: number;
}

/** Where the buyer wants it shipped, as far as the channel tells us. */
export interface ExternalAddress {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
}

export interface ExternalOrder {
  externalId: string;
  createdAt: Date;
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  lines: ExternalOrderLine[];
  taxCents: number;
  /** Everything the buyer paid, shipping included. */
  totalCents: number;
  /** Shipping the buyer paid (part of totalCents). */
  shippingCents?: number;
  shippingAddress?: ExternalAddress;
  /** Outside channels ship unless the channel says the buyer collects (default SHIP). */
  fulfillment?: "PICKUP" | "SHIP";
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
