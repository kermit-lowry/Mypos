import { formatCents, PERMISSIONS, type Permission } from "@mypos/shared";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, View } from "react-native";
import { api } from "../api";
import { Button } from "../components/Button";
import { useLayout } from "../layout";
import { useSession } from "../session";
import { colors, ui } from "../theme";

interface Event {
  id: string;
  action: string;
  staffName: string | null;
  approverName: string | null;
  status: number | null;
  ip: string | null;
  details: Record<string, any>;
  createdAt: string;
}

/** Chip key, label, and the /audit query. `action` takes a comma-separated list. */
const FILTERS: [string, string, Record<string, string>][] = [
  ["all", "All events", { kind: "events" }],
  ["drawer", "Cash drawer", { action: "NO_SALE,DRAWER_OPEN" }],
  ["clear", "Cart deletes", { action: "CART_CLEAR" }],
  ["void", "Voided items", { action: "LINE_VOID" }],
  ["discount", "Discounts", { action: "DISCOUNT" }],
  ["override", "Price overrides", { action: "PRICE_OVERRIDE" }],
  ["price", "Price changes", { action: "PRICE_CHANGE" }],
  ["refund", "Refunds", { action: "REFUND,PREORDER_CANCELLED" }],
  ["approval", "PIN approvals", { action: "APPROVAL" }],
  ["approval-failed", "Failed PIN approvals", { action: "APPROVAL_FAILED" }],
  ["balances", "Balance adjustments", { action: "BALANCE_ADJUSTED" }],
  ["gift", "Gift cards issued", { action: "GIFT_CARD_ISSUED" }],
  ["tradein", "Trade-in overrides", { action: "BUYLIST_OVERRIDE" }],
  ["login", "Sign-ins", { action: "LOGIN" }],
  ["failed", "Failed sign-ins", { action: "LOGIN_FAILED" }],
  ["staff", "Employee changes", { action: "STAFF_CREATED,STAFF_UPDATED,ROLE_UPDATED" }],
  ["catalog", "Catalog changes", { action: "PRODUCT_CREATED,PRODUCT_UPDATED,VARIANT_UPDATED,BRAND_CREATED,BRAND_RENAMED,BRAND_MERGED,PRODUCT_VENDOR_SET,PRODUCT_VENDOR_REMOVED" }],
  [
    "purchasing",
    "Purchasing",
    { action: "PO_CREATED,PO_UPDATED,PO_ORDERED,PO_CANCELLED,PO_RECEIVED,VENDOR_CREATED,VENDOR_UPDATED,TRANSFER_CREATED,TRANSFER_UPDATED,TRANSFER_SENT,TRANSFER_RECEIVED,TRANSFER_SHORT,TRANSFER_CANCELLED" },
  ],
  [
    "setup",
    "Store & deals setup",
    {
      action:
        "SETTINGS_UPDATED,PROMOTION_CREATED,PROMOTION_UPDATED,PROMOTION_DELETED,DISCOUNT_REASON_CREATED,DISCOUNT_REASON_UPDATED,DISCOUNT_PRESET_CREATED,DISCOUNT_PRESET_UPDATED,CATEGORY_CREATED,CATEGORY_UPDATED,CATEGORY_DELETED,LOYALTY_PROGRAM_UPDATED,LOYALTY_REWARD_CREATED,LOYALTY_REWARD_UPDATED,BUYLIST_POLICY_UPDATED,TERMINAL_UPDATED,TERMINAL_SYNCED,LOCATION_CREATED",
    },
  ],
  ["payments", "Payments resolved", { action: "PAYMENT_RESOLVED" }],
  ["requests", "Every change (raw)", { kind: "requests" }],
];

const LEVEL_LABEL: Record<string, string> = { ALLOW: "Allowed", PIN: "Needs PIN", DENY: "Not allowed" };
const FIELD_LABEL: Record<string, string> = { discountMaxBps: "discount limit" };
const METHOD: Record<string, string> = { web: "website", pin: "PIN", "email+pin": "email + PIN" };
const REFUSAL: Record<string, string> = {
  BAD_PIN: "wrong PIN",
  LOCKED_OUT: "locked out after too many wrong PINs",
  APPROVER_NOT_ALLOWED: "that manager isn't allowed to approve this",
  APPROVER_LIMIT: "over that manager's discount limit",
};
const BALANCE_KIND: Record<string, string> = { STORE_CREDIT: "store credit", POINTS: "points", CASHBACK: "rewards" };

/** Plain "Added/Changed/Deleted <thing> "<name>"" events, keyed by the action's prefix. */
const THINGS: Record<string, { noun: string; name: (d: any) => unknown; extra?: (d: any) => string }> = {
  PROMOTION: { noun: "deal", name: (d) => d.name, extra: (d) => (d.type ? words(d.type) : "") },
  DISCOUNT_REASON: { noun: "discount reason", name: (d) => d.name },
  DISCOUNT_PRESET: { noun: "discount button", name: (d) => d.label },
  CATEGORY: { noun: "category", name: (d) => d.path ?? d.name },
  LOYALTY_REWARD: { noun: "reward", name: (d) => d.name, extra: (d) => [d.pointsCost != null ? `${Number(d.pointsCost).toLocaleString()} points` : "", d.type ? words(d.type) : ""].filter(Boolean).join(", ") },
  VENDOR: { noun: "vendor", name: (d) => d.name, extra: (d) => (Array.isArray(d.fields) ? d.fields.map(label).join(", ") : "") },
  BRAND: { noun: "brand", name: (d) => d.name },
  LOCATION: { noun: "location", name: (d) => d.name },
};
const VERB: Record<string, string> = { CREATED: "Added", UPDATED: "Changed", DELETED: "Deleted" };

const isPermission = (k: string): k is Permission => k in PERMISSIONS;
const isObject = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const money = (c: unknown) => formatCents(Number(c) || 0);
const pct = (bps: unknown) => `${Number(bps) / 100}%`;
const signedMoney = (c: number) => `${c < 0 ? "−" : "+"}${formatCents(Math.abs(c))}`;
const signedCount = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n).toLocaleString()}`;
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const count = (x: unknown) => (Array.isArray(x) ? x.length : Number(x) || 0);
/** "CASH_SALE" → "cash sale". */
const words = (x: unknown) => String(x ?? "").replace(/_/g, " ").toLowerCase();
/** Permission labels, e.g. "Refund sales, Give manual discounts". */
const perms = (list: unknown) =>
  (Array.isArray(list) ? list : [list])
    .filter(Boolean)
    .map((p) => (isPermission(String(p)) ? PERMISSIONS[p as Permission].label : String(p)))
    .join(", ");

/** A field name as a person would say it: discountMaxBps → "discount limit", cardPriceBps → "card price". */
function label(k: string): string {
  if (isPermission(k)) return PERMISSIONS[k].label;
  return (
    FIELD_LABEL[k] ??
    k
      .replace(/(Cents|Bps)$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .toLowerCase()
  );
}

/** A field value as a person would read it: *Cents as money, *Bps as percent, permission levels spelled out. */
function fmt(k: string, v: unknown): string {
  if (v === undefined) return isPermission(k) ? "role default" : "none";
  if (v === null || v === "") return "none";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return /Cents$/.test(k) ? formatCents(v) : /Bps$/.test(k) ? pct(v) : v.toLocaleString();
  if (typeof v === "string") return (isPermission(k) && LEVEL_LABEL[v]) || v;
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x))).join(", ") : "none";
  return JSON.stringify(v);
}

/** Fields that differ between two snapshots as "field: from → to"; nested objects (a role's permissions, receipt settings) are compared field by field. */
function diff(before: unknown, after: unknown, parent?: string): string[] {
  const a = isObject(before) ? before : {};
  const b = isObject(after) ? after : {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) return [];
    const name = parent && !isPermission(k) ? `${parent} ${label(k)}` : label(k);
    if (isObject(a[k]) || isObject(b[k])) return diff(a[k], b[k], k === "permissions" || k === "permissionOverrides" ? undefined : name);
    return [`${name}: ${fmt(k, a[k])} → ${fmt(k, b[k])}`];
  });
}

/** "field: from → to" pairs from a { field: { from, to } } object; nested from/to objects are diffed. */
function changes(c: unknown): string[] {
  if (!isObject(c)) return [];
  return Object.entries(c).flatMap(([k, v]) => {
    if (isObject(v) && ("from" in v || "to" in v)) {
      if (isObject(v.from) || isObject(v.to)) return diff(v.from, v.to, k === "permissions" || k === "permissionOverrides" ? undefined : label(k));
      return [`${label(k)}: ${fmt(k, v.from)} → ${fmt(k, v.to)}`];
    }
    return [`${label(k)}: ${fmt(k, v)}`];
  });
}

/** Compact "key: value" listing of a (redacted) request body or params, cut to fit on a line. */
function kv(x: unknown, max = 240): string {
  if (x === null || x === undefined) return "";
  if (!isObject(x)) return Array.isArray(x) ? plural(x.length, "item") : String(x);
  const s = Object.entries(x)
    .map(([k, v]) => `${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
    .join(", ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Tenders on a refund: ["CASH"] or [{ type, amountCents }]. */
const tenders = (t: unknown) =>
  (Array.isArray(t) ? t : [])
    .map((x) => (isObject(x) ? `${words(x.type ?? x.method ?? x.tender)}${x.amountCents != null ? ` ${money(x.amountCents)}` : ""}`.trim() : words(x)))
    .filter(Boolean)
    .join(", ");

/** Plain-language line for an event. */
function describe(e: Event): string {
  const d = e.details;
  const items = (d.items as { title: string; quantity: number }[] | undefined)?.map((i) => `${i.quantity}× ${i.title}`).join(", ");
  switch (e.action) {
    // Register
    case "NO_SALE":
      return d.trigger === "reprint" && d.orderNumber ? `Opened the cash drawer on a reprint of sale #${d.orderNumber}` : "Opened the cash drawer (no sale)";
    case "DRAWER_OPEN":
      return d.orderNumber ? `Opened the cash drawer for ${d.trigger === "cash_sale" ? "cash " : ""}sale #${d.orderNumber}` : "Opened the cash drawer";
    case "CART_CLEAR":
      return `Deleted a cart worth ${money(d.valueCents)}: ${items}`;
    case "LINE_VOID":
      return `Removed ${items} (${money(d.valueCents)})`;
    case "DISCOUNT":
      return `${money(d.amountCents)} off ${d.item} on sale #${d.orderNumber}${d.reason ? `: ${d.reason}` : ""}${d.note ? ` (${d.note})` : ""}`;
    case "PRICE_OVERRIDE":
      return `Sold ${d.item} at ${money(d.toCents)} instead of ${money(d.fromCents)} (sale #${d.orderNumber})`;
    case "REFUND":
      return `Refunded ${money(d.amountCents)} on sale #${d.orderNumber}`;
    case "PREORDER_CANCELLED":
      return `Cancelled a preorder and refunded ${money(d.refundCents)}${d.toStoreCredit ? " to store credit" : tenders(d.tenders) ? ` (${tenders(d.tenders)})` : ""}`;
    case "PAYMENT_RESOLVED":
      return `Resolved an uncertain card payment of ${money(d.amountCents)} as ${words(d.outcome)}${d.orderNumber ? ` (sale #${d.orderNumber})` : ""}`;
    // Approvals and sign-ins
    case "APPROVAL":
      return `PIN approval for ${perms(d.permissions)}${d.discountBps ? ` (${pct(d.discountBps)} discount)` : ""}${d.reason ? `: ${d.reason}` : ""}`;
    case "APPROVAL_FAILED": {
      const why =
        d.reason === "APPROVER_NOT_ALLOWED" && count(d.missing)
          ? `that manager can't approve ${perms(d.missing)}`
          : d.reason === "APPROVER_LIMIT" && d.approverMaxBps != null
            ? `over that manager's ${pct(d.approverMaxBps)} discount limit`
            : (REFUSAL[d.reason] ?? words(d.reason));
      return `Manager PIN refused: ${why} (asked for: ${perms(d.permissions)}${d.discountBps ? `, ${pct(d.discountBps)} discount` : ""})`;
    }
    case "LOGIN":
      return `Signed in (${METHOD[d.method] ?? d.method})`;
    case "LOGIN_FAILED": {
      const method = METHOD[d.method] ?? d.method;
      return `Failed ${method ? `${method} ` : ""}sign-in${d.email ? ` as ${d.email}` : ""}${d.reason ? ` — ${d.reason === "LOCKED_OUT" ? "locked out after too many tries" : d.reason}` : ""}`;
    }
    case "PASSWORD_CHANGED":
      return "Changed their website password";
    // Money
    case "BALANCE_ADJUSTED": {
      const points = d.kind === "POINTS";
      const amount = points ? signedCount(Number(d.amount) || 0) : signedMoney(Number(d.amount) || 0);
      const after = points ? `${(Number(d.balanceAfter) || 0).toLocaleString()} points` : money(d.balanceAfter);
      return `Adjusted ${BALANCE_KIND[d.kind] ?? words(d.kind)} by ${amount}${d.reason ? ` (${d.reason})` : ""} → ${after}`;
    }
    case "GIFT_CARD_ISSUED":
      return `Issued gift card ••••${d.last4} for ${money(d.amountCents)}`;
    case "CONSIGNOR_SETTLED":
      return `Paid a consignor ${money(d.paidCents)}`;
    // Trade-ins
    case "BUYLIST_OVERRIDE": {
      const lines = (Array.isArray(d.lines) ? d.lines : []).map((l: any) => {
        const parts: string[] = [];
        if (l.cashOfferCents != null && l.cashOfferCents !== l.suggestedCashCents) parts.push(`cash ${money(l.cashOfferCents)} (suggested ${money(l.suggestedCashCents)})`);
        if (l.creditOfferCents != null && l.creditOfferCents !== l.suggestedCreditCents) parts.push(`credit ${money(l.creditOfferCents)} (suggested ${money(l.suggestedCreditCents)})`);
        if (l.enteredResaleCents != null && l.enteredResaleCents !== l.catalogResaleCents) parts.push(`resale ${money(l.enteredResaleCents)} (catalog ${money(l.catalogResaleCents)})`);
        return `${l.description}: ${parts.join(", ") || "above suggestion"}`;
      });
      return `Trade-in offer above the suggested price — ${lines.join("; ") || "no line details"}`;
    }
    case "BUYLIST_POLICY_UPDATED":
      return `Trade-in offer settings: ${diff(d.before, d.after).join(", ") || "updated"}`;
    // Employees
    case "STAFF_CREATED": {
      const extras = [
        d.discountMaxBps != null ? `discount limit ${pct(d.discountMaxBps)}` : "",
        isObject(d.permissionOverrides) && Object.keys(d.permissionOverrides).length ? plural(Object.keys(d.permissionOverrides).length, "custom permission") : "",
        d.passwordSet ? "website password set" : "",
      ].filter(Boolean);
      return `Added ${d.targetName ?? "an employee"}${d.role ? ` as ${words(d.role)}` : ""}${extras.length ? ` (${extras.join(", ")})` : ""}`;
    }
    case "STAFF_UPDATED": {
      const parts = [...changes(d.changes), ...(d.pinChanged ? ["new PIN"] : []), ...(d.passwordChanged ? ["new website password"] : [])];
      if (!parts.length && Array.isArray(d.fields)) parts.push(...d.fields.map((f: unknown) => label(String(f))));
      return `Changed ${d.targetName ?? "an employee"}: ${parts.join(", ") || "nothing"}`;
    }
    case "ROLE_UPDATED":
      return `Changed the ${words(d.role)} role: ${diff(d.before, d.after).join(", ") || "permissions updated"}`;
    // Store setup
    case "SETTINGS_UPDATED":
      return `Settings: ${changes(d.changes).join(", ") || "updated"}`;
    case "LOYALTY_PROGRAM_UPDATED":
      return `Loyalty program: ${diff(d.before, d.after).join(", ") || "updated"}`;
    case "TERMINAL_SYNCED":
      return `Synced ${plural(count(d.count), "card terminal")}`;
    case "TERMINAL_UPDATED":
      return `Changed a card terminal: ${changes(d.changes).join(", ") || "updated"}`;
    // Catalog
    case "PRICE_CHANGE": {
      if (d.source === "reprice") {
        const list = Array.isArray(d.items) ? d.items : [];
        const sample = list
          .slice(0, 3)
          .map((i: any) => `${i.item} ${money(i.fromCents)} → ${money(i.toCents)}`)
          .join(", ");
        return `Repriced ${plural(count(d.count ?? list), "item")} from ${d.provider ?? "market prices"}${d.trigger === "scheduled" ? " (scheduled)" : ""}${sample ? `: ${sample}${list.length > 3 ? ", …" : ""}` : ""}`;
      }
      return `Changed ${d.item} (${d.sku}) from ${money(d.fromCents)} to ${money(d.toCents)}`;
    }
    case "PRODUCT_CREATED":
      return `Added product ${d.title}${d.brand ? ` (${d.brand})` : ""}${d.kind ? `, ${words(d.kind)}` : ""}${d.variants != null ? `, ${plural(count(d.variants), "variant")}` : ""}`;
    case "PRODUCT_UPDATED":
      return `Changed product ${d.title}: ${changes(d.changes).join(", ") || "updated"}`;
    case "VARIANT_UPDATED":
      return `Changed ${d.item} (${d.sku}): ${changes(d.changes).join(", ") || "updated"}`;
    case "BRAND_RENAMED":
      return `Renamed brand ${d.from} → ${d.to}`;
    case "BRAND_MERGED":
      return `Merged brand ${d.from} into ${d.into} (${plural(count(d.products), "product")})`;
    case "PRODUCT_VENDOR_SET":
      return `Set vendor ${d.vendor} for ${d.item}${d.vendorSku ? ` (vendor SKU ${d.vendorSku})` : ""}${d.costCents != null ? `, cost ${money(d.costCents)}` : ""}${d.preferred ? ", preferred" : ""}`;
    case "PRODUCT_VENDOR_REMOVED":
      return `Removed vendor ${d.vendor} from ${d.item}`;
    case "CARD_IMPORTED":
      return `Imported ${d.title} (${d.sku})${d.source ? ` from ${d.source}` : ""}`;
    // Purchasing and transfers
    case "PO_CREATED":
      return `Created purchase order #${d.number}${d.vendor ? ` for ${d.vendor}` : ""}${d.lines != null ? ` (${plural(count(d.lines), "line")})` : ""}`;
    case "PO_UPDATED":
      return `Changed purchase order #${d.number}${Array.isArray(d.fields) ? ` (${d.fields.map((f: unknown) => label(String(f))).join(", ")})` : ""}`;
    case "PO_ORDERED":
      return `Sent purchase order #${d.number}${d.vendor ? ` to ${d.vendor}` : ""}`;
    case "PO_CANCELLED":
      return `Cancelled purchase order #${d.number}`;
    case "PO_RECEIVED": {
      const units = Array.isArray(d.items) ? d.items.reduce((a: number, i: any) => a + (Number(i.quantity) || 0), 0) : count(d.items);
      return `Received ${plural(units, "unit")} on purchase order #${d.number} (${d.complete ? "complete" : "partial"})`;
    }
    case "TRANSFER_CREATED":
      return `Created transfer #${d.number}${d.to ? ` to ${d.to}` : ""}${d.lines != null ? ` (${plural(count(d.lines), "line")})` : ""}`;
    case "TRANSFER_UPDATED":
      return `Changed transfer #${d.number}`;
    case "TRANSFER_SENT":
      return `Sent transfer #${d.number}${d.units != null ? ` (${plural(count(d.units), "unit")})` : ""}`;
    case "TRANSFER_RECEIVED":
      return `Received transfer #${d.number}${count(d.short) ? ` (${plural(count(d.short), "item")} short)` : ""}`;
    case "TRANSFER_SHORT":
      return `Transfer #${d.number} arrived short: ${(Array.isArray(d.short) ? d.short : []).map((s: any) => `${s.received} of ${s.sent}`).join(", ") || "see transfer"}`;
    case "TRANSFER_CANCELLED":
      return `Cancelled transfer #${d.number}`;
    case "CUSTOMER_UPDATED":
      return `Changed a customer's ${Array.isArray(d.fields) ? d.fields.map((f: unknown) => label(String(f))).join(", ") : "details"}`;
    // Raw request log
    case "REQUEST": {
      const params = kv(d.params, 80);
      const body = kv(d.body);
      return `${d.route}${params ? ` (${params})` : ""}${body ? ` — ${body}` : ""}${e.status && e.status >= 400 ? ` — refused (${e.status})` : ""}`;
    }
    default: {
      const m = /^(.+)_(CREATED|UPDATED|DELETED)$/.exec(e.action);
      const thing = m && THINGS[m[1]!];
      if (m && thing) {
        const extra = [thing.extra?.(d), m[2] === "UPDATED" ? changes(d.changes).join(", ") : "", d.active === false && m[2] !== "DELETED" ? "inactive" : ""].filter(Boolean).join("; ");
        return `${VERB[m[2]!]} ${thing.noun} "${thing.name(d) ?? ""}"${extra ? ` (${extra})` : ""}`;
      }
      return words(e.action);
    }
  }
}

/** Activity log: who did what, when, and who approved it. */
export function ActivityScreen() {
  const { location } = useSession();
  const { narrow } = useLayout();
  const [filter, setFilter] = useState("all");
  const [events, setEvents] = useState<Event[]>([]);
  const [more, setMore] = useState(true);

  const query = (before?: string) => {
    const params = new URLSearchParams({ ...FILTERS.find((f) => f[0] === filter)![2], take: "100", ...(before ? { before } : {}) });
    return api<Event[]>("GET", `/audit?${params}`);
  };
  const load = useCallback(async () => {
    const rows = await query();
    setEvents(rows);
    setMore(rows.length === 100);
  }, [filter]);
  useEffect(() => {
    load();
  }, [load]);

  const chips = FILTERS.map(([key, title]) => (
    <Pressable key={key} onPress={() => setFilter(key)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: filter === key ? colors.accent : colors.panel }}>
      <Text style={ui.text}>{title}</Text>
    </Pressable>
  ));

  return (
    <View style={{ flex: 1, padding: 12, gap: 8 }}>
      {narrow ? (
        // Phones: one scrolling row, so the chips don't crowd out the log.
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6 }}>
          {chips}
        </ScrollView>
      ) : (
        <View style={[ui.row, { flexWrap: "wrap", gap: 6 }]}>{chips}</View>
      )}
      <View style={[ui.panel, { flex: 1, padding: 8 }]}>
        <FlatList
          data={events}
          keyExtractor={(e) => e.id}
          ListEmptyComponent={<Text style={[ui.muted, { padding: 16 }]}>Nothing logged yet.</Text>}
          renderItem={({ item: e }) => (
            <View style={{ paddingVertical: 8, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
                <Text style={[ui.text, { flex: 1, color: e.status && e.status >= 400 ? colors.warn : colors.text }]}>{describe(e)}</Text>
                <Text style={ui.muted}>{new Date(e.createdAt).toLocaleString()}</Text>
              </View>
              <Text style={ui.muted}>
                {e.staffName ?? "Unknown"}
                {e.approverName ? ` · approved by ${e.approverName}` : ""}
                {e.ip ? ` · ${e.ip}` : ""}
              </Text>
            </View>
          )}
          ListFooterComponent={
            more && events.length > 0 ? (
              <Button
                title="Load more"
                kind="secondary"
                onPress={async () => {
                  const rows = await query(events[events.length - 1]!.createdAt);
                  setEvents((x) => [...x, ...rows]);
                  setMore(rows.length === 100);
                }}
              />
            ) : null
          }
        />
      </View>
      <Text style={ui.muted}>Location: {location.name}. Every change made at a register or in the back office is recorded.</Text>
    </View>
  );
}
