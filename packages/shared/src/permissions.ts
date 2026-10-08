import type { StaffRole } from "./enums.js";

/**
 * Employee permissions. Each permission is, per role (and optionally per
 * employee):
 *   ALLOW  the employee can do it
 *   PIN    they can do it with a manager's PIN (someone who has ALLOW)
 *   DENY   they can't
 * Owners always have ALLOW for everything, so a store can't lock itself out.
 */
export const PermissionLevels = ["ALLOW", "PIN", "DENY"] as const;
export type PermissionLevel = (typeof PermissionLevels)[number];

export const PERMISSIONS = {
  // At the register
  DISCOUNT_LINE: { group: "Register", label: "Give manual discounts", detail: "Up to the employee's discount limit; more needs a PIN" },
  DISCOUNT_CUSTOM: { group: "Register", label: "Type in custom discount amounts", detail: "Off = discount buttons only" },
  PRICE_OVERRIDE: { group: "Register", label: "Change an item's price" },
  LINE_VOID: { group: "Register", label: "Remove items from the cart" },
  CART_CLEAR: { group: "Register", label: "Delete the whole cart" },
  NO_SALE: { group: "Register", label: "Open the cash drawer (no sale)" },
  REFUND: { group: "Register", label: "Refund sales" },
  BUYLIST_PAYOUT: { group: "Trade-ins", label: "Pay cash for trade-ins" },
  BUYLIST_CREDIT: { group: "Trade-ins", label: "Give store credit for trade-ins" },
  BUYLIST_OVERRIDE: { group: "Trade-ins", label: "Offer more than the suggested price" },
  TENDER_STORE_CREDIT: { group: "Register", label: "Take store credit as payment" },
  PREORDER_CANCEL: { group: "Register", label: "Cancel preorders and refund deposits" },
  DRAWER_OPEN_CLOSE: { group: "Register", label: "Start and close a cash drawer (shift)", detail: "Count the float in, blind-count at close" },
  FULFILL_ORDERS: { group: "Register", label: "Set aside, ship and hand over online orders" },
  LAYAWAY_CREATE: { group: "Register", label: "Put items on layaway and take payments" },
  LAYAWAY_CANCEL: { group: "Register", label: "Cancel a layaway and refund it", detail: "The cancellation fee applies unless waived by a manager" },
  LAYAWAY_MANAGE: { group: "Back office", label: "Extend layaway due dates and waive fees" },
  CASH_IN_OUT: { group: "Money", label: "Paid in / paid out / safe drops" },
  CASH_VARIANCE_OVERRIDE: { group: "Money", label: "Accept a cash count that is off by more than the alert amount" },
  // Money & balances
  ADJUST_BALANCES: { group: "Money", label: "Adjust store credit and rewards balances" },
  GIFT_CARD_ISSUE: { group: "Money", label: "Issue gift cards" },
  RESOLVE_PAYMENTS: { group: "Money", label: "Resolve uncertain card payments" },
  VIEW_REPORTS: { group: "Money", label: "View sales reports", pin: false },
  // Back office
  MANAGE_CATALOG: { group: "Back office", label: "Add and edit products and prices" },
  INVENTORY_ADJUST: { group: "Back office", label: "Adjust inventory counts" },
  MANAGE_DEALS: { group: "Back office", label: "Create and edit deals and categories", pin: false },
  MANAGE_PURCHASING: { group: "Back office", label: "Vendors and purchase orders" },
  RECEIVE_STOCK: { group: "Back office", label: "Receive purchase orders and transfers" },
  MANAGE_TRANSFERS: { group: "Back office", label: "Create and send transfers between locations" },
  MANAGE_CUSTOMERS: { group: "Back office", label: "Edit customers" },
  MANAGE_TIMESHEETS: { group: "Back office", label: "Edit employees' time clock entries" },
  MANAGE_TASKS: { group: "Back office", label: "Create and assign employee tasks", detail: "Also complete, skip or reopen anyone's task", pin: false },
  TASK_SKIP: { group: "Register", label: "Skip a task with a reason" },
  BACK_OFFICE_LOGIN: { group: "Back office", label: "Sign in to the back-office website", pin: false },
  MANAGE_EVENTS: { group: "Back office", label: "Create events" },
  MANAGE_CONSIGNMENT: { group: "Back office", label: "Take in and return consignment" },
  CONSIGNOR_SETTLE: { group: "Back office", label: "Pay consignors" },
  MANAGE_TERMINALS: { group: "Back office", label: "Set up card terminals and printers", pin: false },
  MANAGE_CHANNELS: { group: "Back office", label: "Online channel listings and sync", pin: false },
  MANAGE_BUYLIST: { group: "Owner", label: "Trade-in offer settings (margins, trend rules)", pin: false },
  MANAGE_LOYALTY: { group: "Owner", label: "Loyalty program settings", pin: false },
  MANAGE_SETTINGS: { group: "Owner", label: "Store settings (tax, dual pricing, receipts)", pin: false },
  MANAGE_STAFF: { group: "Owner", label: "Employees, PINs, and permissions", pin: false },
} as const satisfies Record<string, { group: string; label: string; detail?: string; pin?: false }>;

export type Permission = keyof typeof PERMISSIONS;
export const PermissionKeys = Object.keys(PERMISSIONS) as Permission[];

/**
 * Permissions a manager can approve with a PIN at the moment of use. The
 * others gate whole pages or sign-in, where nobody is there to enter a PIN,
 * so they are only ever Allowed or Not allowed.
 */
export const canUsePin = (p: Permission): boolean => (PERMISSIONS[p] as { pin?: false }).pin !== false;
export const PIN_PERMISSIONS = PermissionKeys.filter(canUsePin);

type Matrix = Record<Exclude<StaffRole, "OWNER">, Record<Permission, PermissionLevel>>;

export const DEFAULT_ROLE_PERMISSIONS: Matrix = {
  CASHIER: {
    DISCOUNT_LINE: "ALLOW",
    DISCOUNT_CUSTOM: "ALLOW",
    PRICE_OVERRIDE: "PIN",
    LINE_VOID: "ALLOW",
    CART_CLEAR: "ALLOW",
    NO_SALE: "PIN",
    REFUND: "PIN",
    BUYLIST_PAYOUT: "PIN",
    BUYLIST_CREDIT: "PIN",
    BUYLIST_OVERRIDE: "PIN",
    TENDER_STORE_CREDIT: "ALLOW",
    MANAGE_BUYLIST: "DENY",
    PREORDER_CANCEL: "PIN",
    DRAWER_OPEN_CLOSE: "ALLOW",
    FULFILL_ORDERS: "ALLOW",
    LAYAWAY_CREATE: "ALLOW",
    LAYAWAY_CANCEL: "PIN",
    LAYAWAY_MANAGE: "DENY",
    CASH_IN_OUT: "PIN",
    CASH_VARIANCE_OVERRIDE: "PIN",
    MANAGE_TIMESHEETS: "DENY",
    MANAGE_TASKS: "DENY",
    TASK_SKIP: "PIN",
    ADJUST_BALANCES: "DENY",
    GIFT_CARD_ISSUE: "DENY",
    RESOLVE_PAYMENTS: "DENY",
    VIEW_REPORTS: "DENY",
    MANAGE_CATALOG: "DENY",
    INVENTORY_ADJUST: "DENY",
    MANAGE_DEALS: "DENY",
    MANAGE_PURCHASING: "DENY",
    RECEIVE_STOCK: "DENY",
    MANAGE_TRANSFERS: "DENY",
    MANAGE_CUSTOMERS: "ALLOW",
    BACK_OFFICE_LOGIN: "DENY",
    MANAGE_EVENTS: "DENY",
    MANAGE_CONSIGNMENT: "DENY",
    CONSIGNOR_SETTLE: "DENY",
    MANAGE_TERMINALS: "DENY",
    MANAGE_CHANNELS: "DENY",
    MANAGE_LOYALTY: "DENY",
    MANAGE_SETTINGS: "DENY",
    MANAGE_STAFF: "DENY",
  },
  MANAGER: {
    DISCOUNT_LINE: "ALLOW",
    DISCOUNT_CUSTOM: "ALLOW",
    PRICE_OVERRIDE: "ALLOW",
    LINE_VOID: "ALLOW",
    CART_CLEAR: "ALLOW",
    NO_SALE: "ALLOW",
    REFUND: "ALLOW",
    BUYLIST_PAYOUT: "ALLOW",
    BUYLIST_CREDIT: "ALLOW",
    BUYLIST_OVERRIDE: "ALLOW",
    TENDER_STORE_CREDIT: "ALLOW",
    MANAGE_BUYLIST: "DENY",
    PREORDER_CANCEL: "ALLOW",
    DRAWER_OPEN_CLOSE: "ALLOW",
    FULFILL_ORDERS: "ALLOW",
    LAYAWAY_CREATE: "ALLOW",
    LAYAWAY_CANCEL: "ALLOW",
    LAYAWAY_MANAGE: "ALLOW",
    CASH_IN_OUT: "ALLOW",
    CASH_VARIANCE_OVERRIDE: "ALLOW",
    MANAGE_TIMESHEETS: "ALLOW",
    MANAGE_TASKS: "ALLOW",
    TASK_SKIP: "ALLOW",
    ADJUST_BALANCES: "ALLOW",
    GIFT_CARD_ISSUE: "ALLOW",
    RESOLVE_PAYMENTS: "ALLOW",
    VIEW_REPORTS: "ALLOW",
    MANAGE_CATALOG: "ALLOW",
    INVENTORY_ADJUST: "ALLOW",
    MANAGE_DEALS: "ALLOW",
    MANAGE_PURCHASING: "ALLOW",
    RECEIVE_STOCK: "ALLOW",
    MANAGE_TRANSFERS: "ALLOW",
    MANAGE_CUSTOMERS: "ALLOW",
    BACK_OFFICE_LOGIN: "ALLOW",
    MANAGE_EVENTS: "ALLOW",
    MANAGE_CONSIGNMENT: "ALLOW",
    CONSIGNOR_SETTLE: "DENY",
    MANAGE_TERMINALS: "ALLOW",
    MANAGE_CHANNELS: "ALLOW",
    MANAGE_LOYALTY: "DENY",
    MANAGE_SETTINGS: "DENY",
    MANAGE_STAFF: "DENY",
  },
};

/** Most a role may discount a line (bps of the line) without approval. */
export const DEFAULT_DISCOUNT_LIMIT_BPS: Record<StaffRole, number> = { CASHIER: 1_000, MANAGER: 10_000, OWNER: 10_000 };

export interface RolePolicy {
  permissions: Partial<Record<Permission, PermissionLevel>>;
  discountMaxBps: number;
}

export interface EffectivePermissions {
  levels: Record<Permission, PermissionLevel>;
  discountMaxBps: number;
}

/** Role defaults, then the store's role settings, then the employee's own overrides. */
export function effectivePermissions(
  role: StaffRole,
  rolePolicy: RolePolicy | null,
  staff: { overrides?: Partial<Record<Permission, PermissionLevel>> | null; discountMaxBps?: number | null } = {},
): EffectivePermissions {
  if (role === "OWNER") {
    return { levels: Object.fromEntries(PermissionKeys.map((p) => [p, "ALLOW"])) as Record<Permission, PermissionLevel>, discountMaxBps: 10_000 };
  }
  // Only known permissions with valid levels from stored settings count; a bad
  // value falls back to the layer beneath it rather than disappearing.
  // A PIN level on a page/sign-in permission means "not allowed": there is no
  // PIN prompt on those, so it must never read as allowed.
  const valid = (layer: object | null | undefined) =>
    Object.fromEntries(
      Object.entries(layer ?? {})
        .filter(([k, v]) => k in PERMISSIONS && PermissionLevels.includes(v as PermissionLevel))
        .map(([k, v]) => [k, v === "PIN" && !canUsePin(k as Permission) ? "DENY" : v]),
    );
  const levels: Record<Permission, PermissionLevel> = { ...DEFAULT_ROLE_PERMISSIONS[role], ...valid(rolePolicy?.permissions), ...valid(staff.overrides) };
  return { levels, discountMaxBps: staff.discountMaxBps ?? rolePolicy?.discountMaxBps ?? DEFAULT_DISCOUNT_LIMIT_BPS[role] };
}

/** Discount as bps of the line it's on. */
export const discountBps = (discountCents: number, grossCents: number) => (grossCents > 0 ? Math.ceil((discountCents * 10_000) / grossCents) : 0);
