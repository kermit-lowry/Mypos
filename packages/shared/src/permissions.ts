import type { StaffKind, StaffRole } from "./enums.js";

/**
 * Permissions. Each permission is, per role (and optionally per employee or
 * website user):
 *   ALLOW  they can do it
 *   PIN    they can do it with a manager's PIN (someone who has ALLOW)
 *   DENY   they can't
 * Owners always have ALLOW for everything in their scope, so a store can't
 * lock itself out.
 *
 * Register employees and back-office website users are separate accounts.
 * A permission's `scope` says where it applies: "register" only matters to
 * employees, "web" only to website users, "both" to either (the register has
 * manager tabs for deals, loyalty, settings, staff and activity; the back
 * office does refunds, fulfillment, layaway, tasks...). A website user has no
 * PIN pad, so their levels are only ever Allowed / Not allowed.
 */
export const PermissionLevels = ["ALLOW", "PIN", "DENY"] as const;
export type PermissionLevel = (typeof PermissionLevels)[number];

/** Where a permission applies: the register (employees), the website (users), or both. */
export type PermissionScope = "register" | "web" | "both";

export const PERMISSIONS = {
  // At the register
  DISCOUNT_LINE: { group: "Register", label: "Give manual discounts", detail: "Up to the employee's discount limit; more needs a PIN", scope: "register" },
  DISCOUNT_CUSTOM: { group: "Register", label: "Type in custom discount amounts", detail: "Off = discount buttons only", scope: "register" },
  PRICE_OVERRIDE: { group: "Register", label: "Change an item's price", scope: "register" },
  LINE_VOID: { group: "Register", label: "Remove items from the cart", scope: "register" },
  CART_CLEAR: { group: "Register", label: "Delete the whole cart", scope: "register" },
  NO_SALE: { group: "Register", label: "Open the cash drawer (no sale)", scope: "register" },
  REFUND: { group: "Register", label: "Refund sales", scope: "both" },
  BUYLIST_PAYOUT: { group: "Trade-ins", label: "Pay cash for trade-ins", scope: "register" },
  BUYLIST_CREDIT: { group: "Trade-ins", label: "Give store credit for trade-ins", scope: "register" },
  BUYLIST_OVERRIDE: { group: "Trade-ins", label: "Offer more than the suggested price", scope: "register" },
  TENDER_STORE_CREDIT: { group: "Register", label: "Take store credit as payment", scope: "register" },
  PREORDER_CANCEL: { group: "Register", label: "Cancel preorders and refund deposits", scope: "both" },
  DRAWER_OPEN_CLOSE: { group: "Register", label: "Start and close a cash drawer (shift)", detail: "Count the float in, blind-count at close", scope: "register" },
  FULFILL_ORDERS: { group: "Register", label: "Set aside, ship and hand over online orders", scope: "both" },
  LAYAWAY_CREATE: { group: "Register", label: "Put items on layaway and take payments", scope: "register" },
  LAYAWAY_CANCEL: { group: "Register", label: "Cancel a layaway and refund it", detail: "The cancellation fee applies unless waived by a manager", scope: "both" },
  LAYAWAY_MANAGE: { group: "Back office", label: "Extend layaway due dates and waive fees", scope: "both" },
  CASH_IN_OUT: { group: "Money", label: "Paid in / paid out / safe drops", scope: "register" },
  CASH_VARIANCE_OVERRIDE: { group: "Money", label: "Accept a cash count that is off by more than the alert amount", scope: "register" },
  // Money & balances
  ADJUST_BALANCES: { group: "Money", label: "Adjust store credit and rewards balances", scope: "both" },
  GIFT_CARD_ISSUE: { group: "Money", label: "Issue gift cards", scope: "both" },
  RESOLVE_PAYMENTS: { group: "Money", label: "Resolve uncertain card payments", scope: "both" },
  VIEW_REPORTS: { group: "Money", label: "View sales reports", pin: false, scope: "both" },
  // Back office
  MANAGE_CATALOG: { group: "Back office", label: "Add and edit products and prices", scope: "both" },
  INVENTORY_ADJUST: { group: "Back office", label: "Adjust inventory counts", scope: "both" },
  MANAGE_DEALS: { group: "Back office", label: "Create and edit deals and categories", pin: false, scope: "both" },
  MANAGE_PURCHASING: { group: "Back office", label: "Vendors and purchase orders", scope: "both" },
  RECEIVE_STOCK: { group: "Back office", label: "Receive purchase orders and transfers", scope: "both" },
  MANAGE_TRANSFERS: { group: "Back office", label: "Create and send transfers between locations", scope: "both" },
  MANAGE_CUSTOMERS: { group: "Back office", label: "Edit customers", scope: "both" },
  MANAGE_TIMESHEETS: { group: "Back office", label: "Edit employees' time clock entries", scope: "both" },
  MANAGE_TASKS: { group: "Back office", label: "Create and assign employee tasks", detail: "Also complete, skip or reopen anyone's task", pin: false, scope: "both" },
  TASK_SKIP: { group: "Register", label: "Skip a task with a reason", scope: "both" },
  MANAGE_EVENTS: { group: "Back office", label: "Create events", scope: "both" },
  MANAGE_CONSIGNMENT: { group: "Back office", label: "Take in and return consignment", scope: "both" },
  CONSIGNOR_SETTLE: { group: "Back office", label: "Pay consignors", scope: "both" },
  MANAGE_TERMINALS: { group: "Back office", label: "Set up card terminals and printers", pin: false, scope: "both" },
  MANAGE_CHANNELS: { group: "Back office", label: "Online channel listings and sync", pin: false, scope: "both" },
  MANAGE_BUYLIST: { group: "Owner", label: "Trade-in offer settings (margins, trend rules)", pin: false, scope: "both" },
  MANAGE_LOYALTY: { group: "Owner", label: "Loyalty program settings", pin: false, scope: "both" },
  MANAGE_SETTINGS: { group: "Owner", label: "Store settings (tax, dual pricing, receipts)", pin: false, scope: "both" },
  MANAGE_STAFF: { group: "Owner", label: "Employees, PINs, and permissions", pin: false, scope: "both" },
  MANAGE_USERS: { group: "Owner", label: "Website users and their permissions", pin: false, scope: "web" },
} as const satisfies Record<string, { group: string; label: string; detail?: string; pin?: false; scope: PermissionScope }>;

export type Permission = keyof typeof PERMISSIONS;
export const PermissionKeys = Object.keys(PERMISSIONS) as Permission[];

/**
 * Permissions a manager can approve with a PIN at the moment of use. The
 * others gate whole pages or sign-in, where nobody is there to enter a PIN,
 * so they are only ever Allowed or Not allowed.
 */
export const canUsePin = (p: Permission): boolean => (PERMISSIONS[p] as { pin?: false }).pin !== false;
export const PIN_PERMISSIONS = PermissionKeys.filter(canUsePin);

export const scopeOf = (p: Permission): PermissionScope => PERMISSIONS[p].scope;
/** What a register employee can be given. */
export const REGISTER_PERMISSIONS = PermissionKeys.filter((p) => scopeOf(p) !== "web");
/** What a website user can be given. */
export const WEB_PERMISSIONS = PermissionKeys.filter((p) => scopeOf(p) !== "register");
/** The permissions that apply to an account of this kind. */
export const permissionsFor = (kind: StaffKind): Permission[] => (kind === "USER" ? WEB_PERMISSIONS : REGISTER_PERMISSIONS);
/** Whether `p` means anything to an account of this kind. */
export const appliesTo = (p: Permission, kind: StaffKind): boolean => (kind === "USER" ? scopeOf(p) !== "register" : scopeOf(p) !== "web");

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
    MANAGE_EVENTS: "DENY",
    MANAGE_CONSIGNMENT: "DENY",
    CONSIGNOR_SETTLE: "DENY",
    MANAGE_TERMINALS: "DENY",
    MANAGE_CHANNELS: "DENY",
    MANAGE_LOYALTY: "DENY",
    MANAGE_SETTINGS: "DENY",
    MANAGE_STAFF: "DENY",
    MANAGE_USERS: "DENY",
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
    MANAGE_EVENTS: "ALLOW",
    MANAGE_CONSIGNMENT: "ALLOW",
    CONSIGNOR_SETTLE: "DENY",
    MANAGE_TERMINALS: "ALLOW",
    MANAGE_CHANNELS: "ALLOW",
    MANAGE_LOYALTY: "DENY",
    MANAGE_SETTINGS: "DENY",
    MANAGE_STAFF: "DENY",
    MANAGE_USERS: "DENY",
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

/**
 * Role defaults, then the store's role settings, then the account's own
 * overrides. Then the account's kind: a website user (kind USER) gets DENY on
 * every register-only permission, has no PIN pad so any PIN level reads as
 * DENY, and has no discount limit; an employee gets DENY on web-only ones.
 */
export function effectivePermissions(
  role: StaffRole,
  rolePolicy: RolePolicy | null,
  staff: { overrides?: Partial<Record<Permission, PermissionLevel>> | null; discountMaxBps?: number | null; kind?: StaffKind } = {},
): EffectivePermissions {
  const kind = staff.kind ?? "EMPLOYEE";
  const scoped = (levels: Record<Permission, PermissionLevel>): EffectivePermissions["levels"] =>
    Object.fromEntries(PermissionKeys.map((p) => [p, !appliesTo(p, kind) ? "DENY" : kind === "USER" && levels[p] === "PIN" ? "DENY" : levels[p]])) as Record<Permission, PermissionLevel>;
  if (role === "OWNER") {
    const all = Object.fromEntries(PermissionKeys.map((p) => [p, "ALLOW"])) as Record<Permission, PermissionLevel>;
    return { levels: scoped(all), discountMaxBps: kind === "USER" ? 0 : 10_000 };
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
  return { levels: scoped(levels), discountMaxBps: kind === "USER" ? 0 : (staff.discountMaxBps ?? rolePolicy?.discountMaxBps ?? DEFAULT_DISCOUNT_LIMIT_BPS[role]) };
}

/** Discount as bps of the line it's on. */
export const discountBps = (discountCents: number, grossCents: number) => (grossCents > 0 ? Math.ceil((discountCents * 10_000) / grossCents) : 0);
