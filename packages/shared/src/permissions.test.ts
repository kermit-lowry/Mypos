import { describe, expect, it } from "vitest";
import { discountBps, effectivePermissions, PermissionKeys } from "./permissions.js";

describe("effectivePermissions", () => {
  it("owners can do everything, regardless of settings", () => {
    const p = effectivePermissions("OWNER", { permissions: { MANAGE_STAFF: "DENY" }, discountMaxBps: 0 }, { overrides: { REFUND: "DENY" } });
    expect(PermissionKeys.every((k) => p.levels[k] === "ALLOW")).toBe(true);
    expect(p.discountMaxBps).toBe(10_000);
  });

  it("layers role defaults, store role settings, then employee overrides", () => {
    expect(effectivePermissions("CASHIER", null).levels.REFUND).toBe("PIN");
    const store = { permissions: { REFUND: "DENY" as const, CART_CLEAR: "PIN" as const }, discountMaxBps: 500 };
    const p = effectivePermissions("CASHIER", store, { overrides: { REFUND: "ALLOW" }, discountMaxBps: 1500 });
    expect(p.levels).toMatchObject({ REFUND: "ALLOW", CART_CLEAR: "PIN", NO_SALE: "PIN" });
    expect(p.discountMaxBps).toBe(1500);
    expect(effectivePermissions("CASHIER", store).discountMaxBps).toBe(500);
    expect(effectivePermissions("CASHIER", null).discountMaxBps).toBe(1000);
  });

  it("ignores unknown permissions and levels stored in the database", () => {
    const p = effectivePermissions("CASHIER", { permissions: { BOGUS: "ALLOW", REFUND: "MAYBE" } as never, discountMaxBps: 1000 });
    expect("BOGUS" in p.levels).toBe(false);
    expect(p.levels.REFUND).toBe("PIN");
  });
});

it("discountBps rounds up so a limit can't be beaten by a fraction", () => {
  expect(discountBps(100, 1000)).toBe(1000);
  expect(discountBps(101, 1000)).toBe(1010);
  expect(discountBps(1, 3)).toBe(3334);
});

describe("PIN-capable permissions", () => {
  it("treats PIN on a page or sign-in permission as not allowed", async () => {
    const { effectivePermissions, canUsePin, PIN_PERMISSIONS } = await import("./permissions.js");
    expect(canUsePin("DISCOUNT_LINE")).toBe(true);
    expect(canUsePin("VIEW_REPORTS")).toBe(false);
    expect(PIN_PERMISSIONS).not.toContain("BACK_OFFICE_LOGIN");
    expect(effectivePermissions("MANAGER", null, { overrides: { VIEW_REPORTS: "PIN" } }).levels.VIEW_REPORTS).toBe("DENY");
    expect(effectivePermissions("CASHIER", { permissions: { BACK_OFFICE_LOGIN: "PIN" }, discountMaxBps: 1000 }).levels.BACK_OFFICE_LOGIN).toBe("DENY");
    expect(effectivePermissions("CASHIER", null, { overrides: { REFUND: "PIN" } }).levels.REFUND).toBe("PIN");
  });
});
