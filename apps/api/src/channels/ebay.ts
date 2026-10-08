import { config } from "../config.js";
import type { ChannelAdapter, ExternalOrder } from "./adapter.js";

/**
 * eBay Sell APIs. Listings use the inventory-item model where
 * externalId = the eBay inventory SKU (we use our own SKU).
 * Requires a user OAuth token with sell.inventory and sell.fulfillment scopes.
 */
export class EbayAdapter implements ChannelAdapter {
  readonly channel = "EBAY" as const;
  private readonly base = "https://api.ebay.com";

  enabled(): boolean {
    return !!config.ebay.accessToken;
  }

  private headers() {
    return { Authorization: `Bearer ${config.ebay.accessToken}`, "content-type": "application/json", "Content-Language": "en-US" };
  }

  async setQuantity(listing: { externalId: string }, available: number): Promise<void> {
    const sku = encodeURIComponent(listing.externalId);
    // Read-modify-write: PUT replaces the whole inventory item.
    const get = await fetch(`${this.base}/sell/inventory/v1/inventory_item/${sku}`, { headers: this.headers() });
    if (!get.ok) throw new Error(`eBay ${get.status}: ${await get.text()}`);
    const item = (await get.json()) as Record<string, unknown>;
    item.availability = { shipToLocationAvailability: { quantity: available } };
    const put = await fetch(`${this.base}/sell/inventory/v1/inventory_item/${sku}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(item),
    });
    if (!put.ok) throw new Error(`eBay ${put.status}: ${await put.text()}`);
  }

  async fetchOrders(cursor: string | null): Promise<{ orders: ExternalOrder[]; cursor: string | null }> {
    const since = cursor ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const filter = encodeURIComponent(`creationdate:[${since}..],orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}`);
    const res = await fetch(`${this.base}/sell/fulfillment/v1/order?filter=${filter}&limit=200`, { headers: this.headers() });
    if (!res.ok) throw new Error(`eBay ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      orders?: {
        orderId: string;
        creationDate: string;
        orderPaymentStatus: string;
        buyer?: { username?: string };
        pricingSummary?: { total?: { value: string }; tax?: { value: string } };
        lineItems: { sku?: string; quantity: number; lineItemCost: { value: string } }[];
      }[];
    };
    const orders = (body.orders ?? [])
      .filter((o) => o.orderPaymentStatus === "PAID")
      .map<ExternalOrder>((o) => ({
        externalId: o.orderId,
        createdAt: new Date(o.creationDate),
        customerName: o.buyer?.username,
        taxCents: Math.round(Number(o.pricingSummary?.tax?.value ?? 0) * 100),
        totalCents: Math.round(Number(o.pricingSummary?.total?.value ?? 0) * 100),
        lines: o.lineItems
          .filter((l) => l.sku)
          .map((l) => ({
            listingId: l.sku!,
            quantity: l.quantity,
            unitPriceCents: Math.round((Number(l.lineItemCost.value) * 100) / l.quantity),
          })),
      }));
    const last = orders.at(-1);
    return { orders, cursor: last ? last.createdAt.toISOString() : since };
  }
}
