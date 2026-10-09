import { describe, expect, it } from "vitest";
import { discountBps, effectivePermissions, PermissionKeys, PERMISSIONS, permissionsFor, REGISTER_PERMISSIONS, WEB_PERMISSIONS } from "./permissions.js";

describe("effectivePermissions", () => {
  it("owners can do everything in their scope, regardless of settings", () => {
    const p = effectivePermissions("OWNER", { permissions: { MANAGE_STAFF: "DENY" }, discountMaxBps: 0 }, { overrides: { REFUND: "DENY" } });
    expect(REGISTER_PERMISSIONS.every((k) => p.levels[k] === "ALLOW")).toBe(true);
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
    expect(PIN_PERMISSIONS).not.toContain("MANAGE_USERS");
    expect(effectivePermissions("MANAGER", null, { overrides: { VIEW_REPORTS: "PIN" } }).levels.VIEW_REPORTS).toBe("DENY");
    expect(effectivePermissions("CASHIER", { permissions: { MANAGE_USERS: "PIN" }, discountMaxBps: 1000 }).levels.MANAGE_USERS).toBe("DENY");
    expect(effectivePermissions("CASHIER", null, { overrides: { REFUND: "PIN" } }).levels.REFUND).toBe("PIN");
  });
});

describe("employees and website users", () => {
  const registerOnly = PermissionKeys.filter((p) => PERMISSIONS[p].scope === "register");
  const webOnly = PermissionKeys.filter((p) => PERMISSIONS[p].scope === "web");

  it("splits the permissions by scope; BACK_OFFICE_LOGIN is gone", () => {
    expect(PermissionKeys).toHaveLength(43);
    expect(PermissionKeys).not.toContain("BACK_OFFICE_LOGIN");
    expect(registerOnly).toHaveLength(14);
    expect(webOnly).toEqual(["MANAGE_USERS"]);
    expect(REGISTER_PERMISSIONS).toEqual(PermissionKeys.filter((p) => p !== "MANAGE_USERS"));
    expect(WEB_PERMISSIONS).toEqual(PermissionKeys.filter((p) => !registerOnly.includes(p)));
    expect(permissionsFor("EMPLOYEE")).toBe(REGISTER_PERMISSIONS);
    expect(permissionsFor("USER")).toBe(WEB_PERMISSIONS);
  });

  it("a stored BACK_OFFICE_LOGIN level is ignored like any unknown key", () => {
    const p = effectivePermissions("MANAGER", { permissions: { BACK_OFFICE_LOGIN: "DENY" } as never, discountMaxBps: 1000 }, { overrides: { BACK_OFFICE_LOGIN: "ALLOW" } as never });
    expect("BACK_OFFICE_LOGIN" in p.levels).toBe(false);
  });

  it("a website user: no register-only permissions, no PIN levels, no discount limit", () => {
    const p = effectivePermissions("MANAGER", { permissions: { REFUND: "PIN" }, discountMaxBps: 5000 }, { kind: "USER", overrides: { VIEW_REPORTS: "ALLOW", LAYAWAY_MANAGE: "PIN" }, discountMaxBps: 2500 });
    for (const k of registerOnly) expect(p.levels[k]).toBe("DENY");
    expect(p.levels).toMatchObject({ REFUND: "DENY", LAYAWAY_MANAGE: "DENY", VIEW_REPORTS: "ALLOW", MANAGE_CATALOG: "ALLOW", MANAGE_USERS: "DENY" });
    expect(Object.values(p.levels)).not.toContain("PIN");
    expect(p.discountMaxBps).toBe(0);
    // Cashier defaults are coerced the same way: PRICE_OVERRIDE is register-only and REFUND is PIN by default.
    const cashier = effectivePermissions("CASHIER", null, { kind: "USER" });
    expect(cashier.levels).toMatchObject({ PRICE_OVERRIDE: "DENY", REFUND: "DENY", MANAGE_CUSTOMERS: "ALLOW" });
  });

  it("an employee never has web-only permissions, even as an owner", () => {
    expect(effectivePermissions("MANAGER", null, { kind: "EMPLOYEE", overrides: { MANAGE_USERS: "ALLOW" } }).levels.MANAGE_USERS).toBe("DENY");
    expect(effectivePermissions("CASHIER", null).levels.MANAGE_USERS).toBe("DENY");
    const owner = effectivePermissions("OWNER", null);
    expect(owner.levels.MANAGE_USERS).toBe("DENY");
    for (const k of REGISTER_PERMISSIONS) expect(owner.levels[k]).toBe("ALLOW");
    expect(owner.discountMaxBps).toBe(10_000);
  });

  it("an owner user has everything on the website and nothing register-only", () => {
    const owner = effectivePermissions("OWNER", { permissions: { MANAGE_USERS: "DENY" }, discountMaxBps: 0 }, { kind: "USER", overrides: { REFUND: "DENY" } });
    for (const k of WEB_PERMISSIONS) expect(owner.levels[k]).toBe("ALLOW");
    for (const k of registerOnly) expect(owner.levels[k]).toBe("DENY");
    expect(owner.discountMaxBps).toBe(0);
  });
});
