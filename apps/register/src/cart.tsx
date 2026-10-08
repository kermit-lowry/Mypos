import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Platform } from "react-native";
import { api, type Customer, type Product, type Variant } from "./api";
import { useGuard } from "./approval";
import { useSession } from "./session";
import * as storage from "./storage";

export interface Line {
  product: Product;
  variant: Variant;
  quantity: number;
  /** A changed price (needs PRICE_OVERRIDE); absent means the list price. */
  unitPriceCents?: number;
  discountCents: number;
  discountPresetId?: string;
  discountReasonId?: string;
  discountReason?: string;
  discountNote?: string;
}

/** What a line sells for per unit: the changed price, else the list price. */
export const unitPrice = (l: Line) => l.unitPriceCents ?? l.variant.priceCents;

/** What's being removed, for the CART_CLEAR / LINE_VOID audit log. */
export const auditItems = (ls: { line: Line; quantity: number }[]) =>
  ls.map(({ line, quantity }) => ({ variantId: line.variant.id, title: line.product.title, quantity, priceCents: unitPrice(line) }));

interface Cart {
  lines: Line[];
  setLines: Dispatch<SetStateAction<Line[]>>;
  customer: Customer | null;
  setCustomer: Dispatch<SetStateAction<Customer | null>>;
  rewardIds: string[];
  setRewardIds: Dispatch<SetStateAction<string[]>>;
  /** Manager approval for this cart's discounts, sent with the sale. */
  discountApproval: string | null;
  setDiscountApproval: Dispatch<SetStateAction<string | null>>;
  /** Empty the cart after a sale, or after a clear was approved. No permission check here. */
  reset: () => void;
}

const CartContext = createContext<Cart | null>(null);

interface Stored {
  lines: Line[];
  customer: Customer | null;
  rewardIds: string[];
}

/** A cart belongs to the employee who built it, at this register's location. */
const keyFor = (staffId: string, locationId: string) => `cart:${staffId}:${locationId}`;

// Only what the cart screen needs is stored: the product's other variants,
// stock and suppliers would bloat the value (the device keystore is small).
const slim = (lines: Line[]): Line[] =>
  lines.map((l) => ({ ...l, product: { ...l.product, variants: [], vendors: undefined }, variant: { ...l.variant, inventory: undefined } }));
const restore = (lines: Line[]): Line[] => lines.map((l) => ({ ...l, product: { ...l.product, variants: [l.variant] } }));

/**
 * The sale in progress. It lives above the tabs so switching tabs doesn't
 * lose it, and it's stored on the device so a reload or crash doesn't either.
 * Deleting it goes through `useClearCart`.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { staff, location } = useSession();
  const key = keyFor(staff.id, location.id);
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [rewardIds, setRewardIds] = useState<string[]>([]);
  const [discountApproval, setDiscountApproval] = useState<string | null>(null);
  // Don't overwrite the stored cart with the empty initial state before it's been read.
  const [restoredKey, setRestoredKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    storage.getItem(key).then((raw) => {
      if (!live) return;
      if (raw) {
        try {
          const s = JSON.parse(raw) as Partial<Stored>;
          // Keep anything scanned in the meantime over the stored copy.
          setLines((prev) => (prev.length ? prev : restore(s.lines ?? [])));
          setCustomer((prev) => prev ?? s.customer ?? null);
          setRewardIds((prev) => (prev.length ? prev : (s.rewardIds ?? [])));
        } catch {
          // Unreadable: start empty.
        }
      }
      setRestoredKey(key);
    });
    return () => {
      live = false;
    };
  }, [key]);

  useEffect(() => {
    if (restoredKey !== key) return;
    if (lines.length === 0) void storage.deleteItem(key);
    else void storage.setItem(key, JSON.stringify({ lines: slim(lines), customer, rewardIds } satisfies Stored));
  }, [key, restoredKey, lines, customer, rewardIds]);

  // In a browser, closing the tab mid-sale asks first.
  const hasLines = lines.length > 0;
  useEffect(() => {
    if (Platform.OS !== "web" || !hasLines) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasLines]);

  const reset = useCallback(() => {
    setLines([]);
    setCustomer(null);
    setRewardIds([]);
    setDiscountApproval(null);
    // Drop the stored copy now: signing out unmounts this provider before the effect above runs.
    void storage.deleteItem(key);
  }, [key]);

  const value = useMemo<Cart>(
    () => ({ lines, setLines, customer, setCustomer, rewardIds, setRewardIds, discountApproval, setDiscountApproval, reset }),
    [lines, customer, rewardIds, discountApproval, reset],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): Cart {
  const c = useContext(CartContext);
  if (!c) throw new Error("useCart needs a CartProvider");
  return c;
}

/**
 * Empty the cart the way the Clear button does: CART_CLEAR is checked against
 * the employee's permissions (a manager's PIN if that's their level) and
 * logged with what was in it. Resolves true when cleared, false if the PIN
 * prompt was cancelled; throws NotPermitted at DENY.
 */
export function useClearCart() {
  const guard = useGuard();
  const { location } = useSession();
  const { lines, reset } = useCart();
  return useCallback(async (): Promise<boolean> => {
    const ok = await guard("CART_CLEAR", (t) =>
      api(
        "POST",
        "/audit/cart",
        { action: "CART_CLEAR", locationId: location.id, items: auditItems(lines.map((line) => ({ line, quantity: line.quantity }))) },
        { approvalToken: t },
      ),
    );
    if (ok) reset();
    return !!ok;
  }, [guard, location.id, lines, reset]);
}
