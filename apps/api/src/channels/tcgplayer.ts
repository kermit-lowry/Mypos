import { config } from "../config.js";
import type { ChannelAdapter, ExternalOrder } from "./adapter.js";

/**
 * TCGplayer Seller API. Access is invite-only and TCGplayer has been
 * restricting new API keys; endpoint shapes below follow their published
 * v1.39 docs and must be verified against your account before enabling.
 * externalId = TCGplayer SKU id.
 */
export class TcgplayerAdapter implements ChannelAdapter {
  readonly channel = "TCGPLAYER" as const;
  private readonly base = "https://api.tcgplayer.com";

  enabled(): boolean {
    return !!(config.tcgplayer.accessToken && config.tcgplayer.storeKey);
  }

  private headers() {
    return { Authorization: `bearer ${config.tcgplayer.accessToken}`, "content-type": "application/json" };
  }

  async setQuantity(listing: { externalId: string }, available: number): Promise<void> {
    const res = await fetch(
      `${this.base}/stores/${config.tcgplayer.storeKey}/inventory/skus/${encodeURIComponent(listing.externalId)}/quantity`,
      { method: "PUT", headers: this.headers(), body: JSON.stringify({ quantity: available }) },
    );
    if (!res.ok) throw new Error(`TCGplayer ${res.status}: ${await res.text()}`);
  }

  async fetchOrders(_cursor: string | null): Promise<{ orders: ExternalOrder[]; cursor: string | null }> {
    // TCGplayer order import needs per-order detail calls; until it is verified
    // against a live seller account, pull orders via their CSV export instead.
    throw new Error("TCGplayer order import is not implemented yet");
  }
}
