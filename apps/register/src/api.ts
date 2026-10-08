import * as SecureStore from "./storage";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let baseUrl = "http://localhost:4000";
let token: string | null = null;

export async function loadSession(): Promise<{ baseUrl: string; token: string | null }> {
  baseUrl = (await SecureStore.getItem("apiUrl")) ?? baseUrl;
  token = await SecureStore.getItem("token");
  return { baseUrl, token };
}

export async function setApiUrl(url: string) {
  baseUrl = url.replace(/\/$/, "");
  await SecureStore.setItem("apiUrl", baseUrl);
}

export async function setToken(t: string | null) {
  token = t;
  if (t) await SecureStore.setItem("token", t);
  else await SecureStore.deleteItem("token");
}

export const getApiUrl = () => baseUrl;

/**
 * JSON request. Network failures on POSTs carrying an idempotencyKey are
 * retried with the same key, so a sale is never charged twice when the store
 * wifi drops mid-request.
 */
export async function api<T = any>(method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown): Promise<T> {
  const retries = body && typeof body === "object" && "idempotencyKey" in body ? 3 : 0;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new ApiError(0, "NETWORK", "Can't reach the server. Check the connection and try again.");
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, json?.error ?? "ERROR", json?.message ?? res.statusText, json?.details);
    return json as T;
  }
}

export interface Variant {
  id: string;
  sku: string;
  priceCents: number;
  marketCents: number | null;
  condition: string | null;
  finish: string | null;
  size: string | null;
  colorway: string | null;
  itemCondition: string | null;
  taxable: boolean;
  serialized: boolean;
  inventory?: { locationId: string; onHand: number }[];
}

export interface Product {
  id: string;
  kind: string;
  title: string;
  brand: string | null;
  setName: string | null;
  setCode: string | null;
  collectorNumber: string | null;
  variants: Variant[];
}

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  storeCreditCents?: number;
  loyalty?: { points: number; rewardsCents: number };
}

export interface LoyaltyProgram {
  enabled: boolean;
  type: "CASHBACK" | "POINTS";
  cashbackBps: number;
  pointsPerDollar: number;
}

export interface Reward {
  id: string;
  name: string;
  type: "PERCENT_OFF" | "AMOUNT_OFF" | "ITEM";
  pointsCost: number;
}

export interface Totals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

export interface LoyaltyQuote extends Totals {
  card: Totals;
  rewardDiscounts: number[];
  pointsCost: number;
  earn: { unit: "POINTS" | "CENTS"; amount: number } | null;
}

export interface Location {
  id: string;
  name: string;
  taxRateBps: number;
  /** Dual pricing: card price = cash price + this many bps. 0 = off. */
  cardPriceBps: number;
  labelPrinterHost: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
}

/** Fetch a text/HTML response (receipts, labels). */
export async function apiText(method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const json = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    })();
    throw new ApiError(res.status, json?.error ?? "ERROR", json?.message ?? res.statusText);
  }
  return text;
}
