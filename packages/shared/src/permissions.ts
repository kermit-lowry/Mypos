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
  // Money & balances
  ADJUST_BALANCES: { group: "Money", label: "Adjust store credit and rewards balances" },
  GIFT_CARD_ISSUE: { group: "Money", label: "Issue gift cards" },
  RESOLVE_PAYMENTS: { group: "Money", label: "Resolve uncertain card payments" },
  VIEW_REPORTS: { group: "Money", label: "View sales reports" },
  // Back office
  MANAGE_CATALOG: { group: "Back office", label: "Add and edit products and prices" },
  INVENTORY_ADJUST: { group: "Back office", label: "Adjust inventory counts" },
  MANAGE_DEALS: { group: "Back office", label: "Create and edit deals and categories" },
  MANAGE_EVENTS: { group: "Back office", label: "Create events" },
  MANAGE_CONSIGNMENT: { group: "Back office", label: "Take in and return consignment" },
  CONSIGNOR_SETTLE: { group: "Back office", label: "Pay consignors" },
  MANAGE_TERMINALS: { group: "Back office", label: "Set up card terminals and printers" },
  MANAGE_CHANNELS: { group: "Back office", label: "Online channel listings and sync" },
  MANAGE_BUYLIST: { group: "Owner", label: "Trade-in offer settings (margins, trend rules)" },
  MANAGE_LOYALTY: { group: "Owner", label: "Loyalty program settings" },
  MANAGE_SETTINGS: { group: "Owner", label: "Store settings (tax, dual pricing, receipts)" },
  MANAGE_STAFF: { group: "Owner", label: "Employees, PINs, and permissions" },
} as const satisfies Record<string, { group: string; label: string; detail?: string }>;

export type Permission = keyof typeof PERMISSIONS;
export const PermissionKeys = Object.keys(PERMISSIONS) as Permission[];

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
    ADJUST_BALANCES: "DENY",
    GIFT_CARD_ISSUE: "DENY",
    RESOLVE_PAYMENTS: "DENY",
    VIEW_REPORTS: "DENY",
    MANAGE_CATALOG: "DENY",
    INVENTORY_ADJUST: "DENY",
    MANAGE_DEALS: "DENY",
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
    ADJUST_BALANCES: "ALLOW",
    GIFT_CARD_ISSUE: "ALLOW",
    RESOLVE_PAYMENTS: "ALLOW",
    VIEW_REPORTS: "ALLOW",
    MANAGE_CATALOG: "ALLOW",
    INVENTORY_ADJUST: "ALLOW",
    MANAGE_DEALS: "ALLOW",
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
  const valid = (layer: object | null | undefined) =>
    Object.fromEntries(Object.entries(layer ?? {}).filter(([k, v]) => k in PERMISSIONS && PermissionLevels.includes(v as PermissionLevel)));
  const levels: Record<Permission, PermissionLevel> = { ...DEFAULT_ROLE_PERMISSIONS[role], ...valid(rolePolicy?.permissions), ...valid(staff.overrides) };
  return { levels, discountMaxBps: staff.discountMaxBps ?? rolePolicy?.discountMaxBps ?? DEFAULT_DISCOUNT_LIMIT_BPS[role] };
}

/** Discount as bps of the line it's on. */
export const discountBps = (discountCents: number, grossCents: number) => (grossCents > 0 ? Math.ceil((discountCents * 10_000) / grossCents) : 0);
