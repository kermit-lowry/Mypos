import type { MarketTrend } from "@mypos/shared";
import { api } from "./api";

/** What the customer-facing screen shows. Published by the register, polled by the display. */
export type DisplayState =
  | { state: "IDLE"; storeName: string }
  | {
      state: "CART" | "PAYING";
      storeName: string;
      /** e.g. "4%"; null when dual pricing is off. */
      cardPercent: string | null;
      lines: { title: string; detail: string; quantity: number; cashCents: number; cardCents: number; market?: MarketTrend | null; imageUrl?: string | null }[];
      /** Automated deals applied (cash-price amounts). */
      promotions?: { name: string; discountCents: number }[];
      cash: { subtotalCents: number; discountCents: number; taxCents: number; totalCents: number };
      card: { subtotalCents: number; discountCents: number; taxCents: number; totalCents: number };
      /** While paying: what's still owed at each price. */
      due?: { cashCents: number; cardCents: number };
      customer?: { name: string; points?: number; rewardsCents?: number } | null;
      earn?: string | null;
    }
  | { state: "DONE"; storeName: string; totalCents: number; changeCents: number; message?: string };

/** Display channel for this register: its card terminal, else the location. */
export const displayChannel = (locationId: string, terminalId: string | null | undefined) => terminalId ?? `loc-${locationId}`;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: { channel: string; state: DisplayState } | null = null;

/** Debounced publish so typing quantities doesn't flood the API. */
export function publishDisplay(channel: string, state: DisplayState) {
  pending = { channel, state };
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const p = pending!;
    pending = null;
    api("PUT", `/displays/${encodeURIComponent(p.channel)}`, p.state).catch(() => undefined);
  }, 250);
}
