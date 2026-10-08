import type { MarketTrend } from "@mypos/shared";
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
export const getToken = () => token;

/**
 * JSON request. Network failures on POSTs carrying an idempotencyKey are
 * retried with the same key, so a sale is never charged twice when the store
 * wifi drops mid-request.
 */
/** Options for one request. */
export interface RequestOptions {
  /** A manager's PIN approval for this action. */
  approvalToken?: string | null;
}

export async function api<T = any>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const retries = body && typeof body === "object" && "idempotencyKey" in body ? 3 : 0;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          // Only claim a JSON body when there is one; servers reject an empty JSON body.
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(opts.approvalToken ? { "x-approval-token": opts.approvalToken } : {}),
        },
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
  gradingCompany?: string | null;
  grade?: string | null;
  certNumber?: string | null;
  imageUrl?: string | null;
  costCents?: number | null;
  autoPrice?: boolean;
  barcode?: string | null;
  taxable: boolean;
  serialized: boolean;
  inventory?: { locationId: string; onHand: number }[];
  /** Market price and 7-day change, for items with a price feed. */
  market?: MarketTrend | null;
}

/** One of a product's suppliers, with their item number and price. */
export interface ProductVendor {
  vendorId: string;
  vendorSku: string | null;
  costCents: number | null;
  preferred: boolean;
  leadDays?: number | null;
  notes?: string | null;
  vendor?: Vendor;
}

export interface Vendor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes?: string | null;
  active: boolean;
  accountNumber?: string | null;
  contactName?: string | null;
  website?: string | null;
  address?: string | null;
  defaultCategoryId?: string | null;
  /** Counts from the list endpoint. */
  products?: number;
  purchaseOrders?: number;
}

export interface Brand {
  id: string;
  name: string;
  active: boolean;
  /** Products carrying the brand (list endpoint). */
  products?: number;
}

export interface Product {
  id: string;
  kind: string;
  title: string;
  brand: string | null;
  brandId?: string | null;
  imageUrl?: string | null;
  setName: string | null;
  setCode: string | null;
  collectorNumber: string | null;
  styleCode?: string | null;
  categoryId?: string | null;
  channels?: string[];
  variants: Variant[];
  vendors?: ProductVendor[];
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
  lines: { variantId: string; promoDiscountCents: number; rewardDiscountCents: number; discountCents: number }[];
  promotions: { promotionId: string; name: string; discountCents: number }[];
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
  /** Tenders besides card that pay the card price. */
  cardPricedTenders: string[];
  labelPrinterHost: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  /** Layaway terms (absent on servers without layaway). */
  layawayEnabled?: boolean;
  /** Minimum deposit as bps of the layaway total (2000 = 20%). */
  layawayMinDepositBps?: number;
  layawayTermDays?: number;
  layawayCancelFeeCents?: number;
  layawayCancelFeeBps?: number;
}

/** Fetch a text/HTML response (receipts, labels). */
export async function apiText(method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
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

// ─── Cash drawer sessions (shifts) and the time clock ────────────

export type CashMovementKind = "PAID_IN" | "PAID_OUT" | "DROP";

/** Cash put in or taken out of a drawer besides sales. Amount is always positive. */
export interface CashMovement {
  id: string;
  kind: CashMovementKind;
  amountCents: number;
  reason: string;
  note?: string | null;
  createdAt: string;
  staff?: { name: string } | null;
}

/** Denomination counts, cents → how many (e.g. { "2000": 5, "25": 40 }). */
export type CashCounts = Record<string, number>;

/** Where the cash in the drawer should have come from, if the store isn't blind-counting. */
export interface DrawerExpected {
  openingFloatCents: number;
  cashSalesCents: number;
  cashRefundsCents: number;
  tradeInCashCents: number;
  paidInCents: number;
  paidOutCents: number;
  dropCents: number;
  expectedCents: number;
}

/** The X report while a drawer is open; the stored closing (Z) report once closed. */
export interface DrawerReport {
  openingFloatCents?: number;
  cashSalesCents?: number;
  cashRefundsCents?: number;
  tradeInCashCents?: number;
  paidInCents?: number;
  paidOutCents?: number;
  dropCents?: number;
  expectedCents?: number;
  sales?: {
    orders: number;
    units: number;
    grossCents: number;
    discountCents: number;
    netSalesCents: number;
    taxCents: number;
    collectedCents: number;
    refundedCents: number;
  };
  tenders?: { tender: string; count: number; netCents: number }[];
  tradeIns?: { tickets?: number; cashCents?: number; creditCents?: number; [k: string]: unknown };
  byEmployee?: { staffId?: string | null; name: string; orders: number; netCents: number; collectedCents?: number }[];
}

/** One cash drawer from "start shift" to "close". */
export interface DrawerSession {
  id: string;
  number: number;
  status: "OPEN" | "CLOSED";
  terminalId: string | null;
  openedAt: string;
  openedById: string | null;
  openedBy?: { name: string } | null;
  openingFloatCents: number;
  openingCount?: CashCounts | null;
  closedAt?: string | null;
  closedBy?: { name: string } | null;
  expectedCashCents?: number | null;
  countedCashCents?: number | null;
  /** counted − expected (negative = short). */
  varianceCents?: number | null;
  closingCount?: CashCounts | null;
  closingReport?: DrawerReport | null;
  notes?: string | null;
  movements?: CashMovement[];
  /** Present on GET /drawer/:id. */
  expected?: DrawerExpected | null;
  report?: DrawerReport | null;
}

export interface DrawerSettings {
  requireDrawerSession: boolean;
  blindCashCount: boolean;
  cashVarianceAlertCents: number;
}

/** Time clock: one row per clock-in, closed by the clock-out. */
export interface TimeEntry {
  id: string;
  clockIn: string;
  clockOut?: string | null;
  breakMinutes?: number;
}

// ─── Layaway ─────────────────────────────────────────────────────

export type LayawayStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

/** An item held on a layaway, at the price locked when it opened. */
export interface LayawayLine {
  id: string;
  variantId: string;
  title: string;
  quantity: number;
  unitPriceCents: number;
  /** Total discount on the line, including deals. */
  discountCents: number;
  promoDiscountCents: number;
  taxable: boolean;
  variant?: { sku?: string | null; imageUrl?: string | null; product?: { title?: string; imageUrl?: string | null } | null } | null;
}

/** A deposit or payment toward a layaway. A card pays the card price: only `appliedCents` reduces the balance. */
export interface LayawayPayment {
  id: string;
  amountCents: number;
  appliedCents: number;
  tender: string;
  status: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
  changeCents?: number;
  createdAt: string;
  staff?: { name: string } | null;
}

/**
 * Items held for a customer against a deposit and paid off over time. Totals
 * are cash prices locked when it opened; completing it creates the sale.
 */
export interface Layaway {
  id: string;
  number: number;
  status: LayawayStatus;
  locationId: string;
  customerId: string;
  customer?: { id: string; name: string; email?: string | null; phone?: string | null } | null;
  staff?: { name: string } | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  /** Card markup in effect when it opened. */
  cardPriceBps: number;
  cardAdjustmentCents: number;
  cardAdjustmentTaxCents: number;
  paidCents: number;
  balanceCents: number;
  overdue: boolean;
  dueAt: string;
  notes?: string | null;
  createdAt: string;
  completedAt?: string | null;
  /** The sale created at pickup. */
  orderId?: string | null;
  cancelledAt?: string | null;
  cancelFeeCents: number;
  refundedCents: number;
  cancelReason?: string | null;
  /** What cancelling now would cost and return (GET /layaways/:id). */
  cancelFeePreview?: { feeCents: number; refundCents: number } | null;
  lines?: LayawayLine[];
  payments?: LayawayPayment[];
  /** List rows: how many lines, without the lines themselves. */
  lineCount?: number;
  _count?: { lines: number };
}

// ─── Online orders (fulfillment) ─────────────────────────────────

/** NEW → ACKNOWLEDGED → PICKING → READY → PICKED_UP | SHIPPED. PROBLEM parks an order that can't be filled. */
export type FulfillmentStatus = "NEW" | "ACKNOWLEDGED" | "PICKING" | "READY" | "SHIPPED" | "PICKED_UP" | "PROBLEM";
export type FulfillmentMethod = "PICKUP" | "SHIP";
export type OnlineChannel = "STOREFRONT" | "SHOPIFY" | "EBAY" | "TCGPLAYER";

export interface ShippingAddress {
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
}

/** One item to set aside. */
export interface OnlineOrderLine {
  id: string;
  variantId: string;
  title: string;
  quantity: number;
  sku?: string | null;
  imageUrl?: string | null;
  unitPriceCents?: number;
  discountCents?: number;
  /** Units already refunded; a fully refunded line needn't be set aside. */
  refundedQty?: number;
  picked?: boolean;
}

export interface OnlineOrderTotals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  /** Charged on top of the items, not taxed; included in totalCents. */
  shippingCents: number;
  totalCents: number;
  cardAdjustmentCents: number;
  /** What the card was charged: total plus the card price adjustment. */
  chargedCents?: number;
}

/** A paid order from the web store or a marketplace, waiting to be set aside and handed over or shipped. */
export interface OnlineOrder extends Partial<OnlineOrderTotals> {
  id: string;
  number: number;
  channel: OnlineChannel | string;
  externalId?: string | null;
  /** Payment status of the sale (PAID, PARTIALLY_REFUNDED, REFUNDED, VOID). */
  status: string;
  fulfillment: FulfillmentMethod;
  fulfillmentStatus: FulfillmentStatus;
  customer: { id: string; name: string; email?: string | null; phone?: string | null } | null;
  customerPhone?: string | null;
  /** The customer's note at checkout (pickup time, gift, etc.). */
  customerNote?: string | null;
  /** Staff/import note on the sale. */
  note?: string | null;
  /** The note left when it was flagged, while it is in PROBLEM. */
  problemNote?: string | null;
  shippingAddress?: ShippingAddress | null;
  /** Money, when the server nests it (else the flat *Cents fields). */
  totals?: OnlineOrderTotals;
  carrier?: string | null;
  trackingNumber?: string | null;
  /** Lines ticked off as set aside. */
  pickedLineIds: string[];
  items?: number;
  createdAt: string;
  acknowledgedAt?: string | null;
  readyAt?: string | null;
  shippedAt?: string | null;
  pickedUpAt?: string | null;
  fulfilledBy?: { id?: string; name: string } | null;
  ageMinutes?: number;
  lines: OnlineOrderLine[];
  /** GET /fulfillment/orders/:id only: placed, each queue step (who, when, note), refunds. */
  timeline?: { at: string; event: string; by?: string | null; note?: string | null }[];
}

/** What the register polls: open-order counts and the newest orders, for the badge and toasts. */
export interface FulfillmentQueue {
  counts: { NEW: number; ACKNOWLEDGED: number; PICKING: number; READY: number; PROBLEM: number; total: number };
  /** Orders created after `since`. */
  newSince: number;
  latest: FulfillmentQueueOrder[];
}

export interface FulfillmentQueueOrder {
  id: string;
  number: number;
  channel: OnlineChannel | string;
  fulfillment: FulfillmentMethod;
  fulfillmentStatus: FulfillmentStatus;
  customer: { name: string | null } | null;
  items: number;
  /** What the customer paid, shipping and card adjustment included. */
  totalCents: number;
  createdAt: string;
}

// ─── Employee tasks ──────────────────────────────────────────────

export type TaskPriority = "LOW" | "NORMAL" | "HIGH";
export type TaskRecurrence = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";
export type TaskAssigneeType = "ANYONE" | "ROLE" | "EMPLOYEE";
export type TaskStatus = "OPEN" | "DONE" | "SKIPPED";
export type TaskRole = "OWNER" | "MANAGER" | "CASHIER";

/** One day's instance of a task at one store: what an employee ticks off. */
export interface TaskOccurrence {
  id: string;
  taskId: string;
  locationId: string;
  title: string;
  instructions: string | null;
  checklist: string[];
  /** Indices into `checklist` that are ticked. */
  checklistDone: number[];
  priority: TaskPriority;
  recurrence: TaskRecurrence;
  /** The task's schedule (WEEKLY: 0 = Sunday; MONTHLY: 31 = the last day); older API builds leave them out. */
  daysOfWeek?: number[];
  dayOfMonth?: number | null;
  requireNote: boolean;
  /** Store-local day, "YYYY-MM-DD". */
  dueOn: string;
  dueAt: string;
  /** Store-local "HH:mm"; null = by the end of the day. */
  dueTime: string | null;
  status: TaskStatus;
  assignee: { type: TaskAssigneeType; role?: TaskRole | null; employee?: { id: string; name: string } | null };
  completedBy: { id: string; name: string } | null;
  completedAt: string | null;
  late: boolean;
  note: string | null;
  skipReason: string | null;
}

/** GET /tasks/mine: what the signed-in employee sees. */
export interface MyTasks {
  today: TaskOccurrence[];
  overdue: TaskOccurrence[];
  upcoming: TaskOccurrence[];
  counts: { open: number; overdue: number; doneToday: number };
}

/** A task definition (managers): the schedule and who it is for. */
export interface TaskDef {
  id: string;
  /** null = every store */
  locationId: string | null;
  location?: { id: string; name: string } | null;
  title: string;
  instructions: string | null;
  checklist: string[];
  priority: TaskPriority;
  recurrence: TaskRecurrence;
  /** WEEKLY: 0 = Sunday … 6 = Saturday */
  daysOfWeek: number[];
  /** MONTHLY: 1..31; past the month's end = its last day */
  dayOfMonth: number | null;
  dueTime: string | null;
  startsOn: string;
  endsOn: string | null;
  nextDueOn: string | null;
  assigneeType: TaskAssigneeType;
  assigneeRole: TaskRole | null;
  assigneeId: string | null;
  assignee?: { id: string; name: string } | null;
  requireNote: boolean;
  active: boolean;
  createdById?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /tasks and PATCH /tasks/:id (partial). */
export interface TaskInput {
  locationId?: string | null;
  title: string;
  instructions?: string | null;
  checklist?: string[];
  priority?: TaskPriority;
  recurrence: TaskRecurrence;
  daysOfWeek?: number[];
  dayOfMonth?: number | null;
  dueTime?: string | null;
  startsOn: string;
  endsOn?: string | null;
  assigneeType?: TaskAssigneeType;
  assigneeRole?: TaskRole | null;
  assigneeId?: string | null;
  requireNote?: boolean;
  active?: boolean;
}
