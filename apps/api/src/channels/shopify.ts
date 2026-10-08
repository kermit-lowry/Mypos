import { config } from "../config.js";
import type { ChannelAdapter, ExternalOrder } from "./adapter.js";

const API_VERSION = "2025-07";

/**
 * Shopify Admin REST API. Listings link a MyPOS variant to a Shopify variant:
 * externalId = Shopify variant id, inventoryRef = its inventory_item_id.
 */
export class ShopifyAdapter implements ChannelAdapter {
  readonly channel = "SHOPIFY" as const;

  enabled(): boolean {
    return !!(config.shopify.shop && config.shopify.accessToken && config.shopify.locationId);
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`https://${config.shopify.shop}/admin/api/${API_VERSION}${path}`, {
      ...init,
      headers: { "X-Shopify-Access-Token": config.shopify.accessToken, "content-type": "application/json", ...init.headers },
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    return res;
  }

  async setQuantity(listing: { externalId: string; inventoryRef: string | null }, available: number): Promise<void> {
    if (!listing.inventoryRef) throw new Error("Shopify listing is missing inventory_item_id");
    await this.call("/inventory_levels/set.json", {
      method: "POST",
      body: JSON.stringify({
        location_id: Number(config.shopify.locationId),
        inventory_item_id: Number(listing.inventoryRef),
        available,
      }),
    });
  }

  async fetchOrders(cursor: string | null): Promise<{ orders: ExternalOrder[]; cursor: string | null }> {
    const since = cursor ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await this.call(
      `/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(since)}&limit=250&order=created_at+asc`,
    );
    const body = (await res.json()) as {
      orders: {
        id: number;
        created_at: string;
        email?: string;
        customer?: { first_name?: string; last_name?: string };
        total_tax: string;
        total_price: string;
        line_items: { variant_id: number | null; quantity: number; price: string }[];
      }[];
    };
    const orders = body.orders.map<ExternalOrder>((o) => ({
      externalId: String(o.id),
      createdAt: new Date(o.created_at),
      customerEmail: o.email || undefined,
      customerName: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") || undefined,
      taxCents: Math.round(Number(o.total_tax) * 100),
      totalCents: Math.round(Number(o.total_price) * 100),
      lines: o.line_items
        .filter((l) => l.variant_id !== null)
        .map((l) => ({ listingId: String(l.variant_id), quantity: l.quantity, unitPriceCents: Math.round(Number(l.price) * 100) })),
    }));
    const last = orders.at(-1);
    return { orders, cursor: last ? last.createdAt.toISOString() : since };
  }
}
