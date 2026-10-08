import { formatCents } from "@mypos/shared";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { api } from "../api";
import { Button } from "../components/Button";
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

const FILTERS: [string, string, Record<string, string>][] = [
  ["all", "All events", { kind: "events" }],
  ["drawer", "Cash drawer", { action: "NO_SALE" }],
  ["clear", "Cart deletes", { action: "CART_CLEAR" }],
  ["void", "Voided items", { action: "LINE_VOID" }],
  ["discount", "Discounts", { action: "DISCOUNT" }],
  ["override", "Price overrides", { action: "PRICE_OVERRIDE" }],
  ["price", "Price changes", { action: "PRICE_CHANGE" }],
  ["refund", "Refunds", { action: "REFUND" }],
  ["approval", "PIN approvals", { action: "APPROVAL" }],
  ["login", "Sign-ins", { action: "LOGIN" }],
  ["failed", "Failed sign-ins", { action: "LOGIN_FAILED" }],
  ["requests", "Every change (raw)", { kind: "requests" }],
];

/** Plain-language line for an event. */
function describe(e: Event): string {
  const d = e.details;
  const items = (d.items as { title: string; quantity: number }[] | undefined)?.map((i) => `${i.quantity}× ${i.title}`).join(", ");
  switch (e.action) {
    case "NO_SALE":
      return "Opened the cash drawer (no sale)";
    case "CART_CLEAR":
      return `Deleted a cart worth ${formatCents(d.valueCents ?? 0)}: ${items}`;
    case "LINE_VOID":
      return `Removed ${items} (${formatCents(d.valueCents ?? 0)})`;
    case "DISCOUNT":
      return `${formatCents(d.amountCents)} off ${d.item} on sale #${d.orderNumber}${d.reason ? `: ${d.reason}` : ""}${d.note ? ` (${d.note})` : ""}`;
    case "PRICE_OVERRIDE":
      return `Sold ${d.item} at ${formatCents(d.toCents)} instead of ${formatCents(d.fromCents)} (sale #${d.orderNumber})`;
    case "PRICE_CHANGE":
      return `Changed ${d.item} (${d.sku}) from ${formatCents(d.fromCents)} to ${formatCents(d.toCents)}`;
    case "REFUND":
      return `Refunded ${formatCents(d.amountCents)} on sale #${d.orderNumber}`;
    case "APPROVAL":
      return `PIN approval for ${(d.permissions as string[]).join(", ").toLowerCase().replace(/_/g, " ")}`;
    case "LOGIN":
      return `Signed in (${d.method})`;
    case "LOGIN_FAILED":
      return `Failed sign-in${d.email ? ` as ${d.email}` : ""}`;
    case "REQUEST":
      return `${d.route}${e.status && e.status >= 400 ? ` — refused (${e.status})` : ""}`;
    default:
      return e.action.replace(/_/g, " ").toLowerCase();
  }
}

/** Activity log: who did what, when, and who approved it. */
export function ActivityScreen() {
  const { location } = useSession();
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

  return (
    <View style={{ flex: 1, padding: 12, gap: 8 }}>
      <View style={[ui.row, { flexWrap: "wrap", gap: 6 }]}>
        {FILTERS.map(([key, label]) => (
          <Pressable key={key} onPress={() => setFilter(key)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: filter === key ? colors.accent : colors.panel }}>
            <Text style={ui.text}>{label}</Text>
          </Pressable>
        ))}
      </View>
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
