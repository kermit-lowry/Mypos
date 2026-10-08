import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { api, ApiError } from "../../api";
import { useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Card, money, pct, Stat, Table } from "../ui";

interface Data {
  date: string;
  today: { orders: number; units: number; netSalesCents: number; grossProfitCents: number; marginBps: number; averageTicketCents: number; refundedCents: number; discountCents: number; taxCents: number; tradeIns: { tickets: number; paidCents: number } };
  hourly: { period: string; netCents: number; orders: number }[];
  topItems: { key: string; label: string; units: number; netCents: number }[];
  tenders: { tender: string; count: number; netCents: number }[];
  lowStock: { variantId: string; sku: string; title: string; onHand: number; lowStockQty: number | null }[];
  lowStockCount: number;
  pendingPayments: number;
  openPurchaseOrders: number;
  transfersInTransit: number;
  /** Online orders still to fill (absent on servers without fulfillment). */
  onlineOrders?: { open?: number; new?: number; ready?: number } | null;
}

/** Today at a glance. */
export function Dashboard() {
  const { location } = useSession();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Data>("GET", `/dashboard?locationId=${location.id}`).then(setD).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [location.id]);

  if (error) return <Text style={[ui.error, { padding: 16 }]}>{error}</Text>;
  if (!d) return <Text style={[ui.muted, { padding: 16 }]}>Loading…</Text>;
  const t = d.today;
  const peak = Math.max(1, ...d.hourly.map((h) => h.netCents));
  const oo = d.onlineOrders ? { open: d.onlineOrders.open ?? 0, new: d.onlineOrders.new ?? 0, ready: d.onlineOrders.ready ?? 0 } : null;
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={[ui.row, { flexWrap: "wrap", gap: 10 }]}>
        <Stat label="Net sales today" value={money(t.netSalesCents)} sub={`${t.orders} sales · ${t.units} items`} />
        <Stat label="Gross profit" value={money(t.grossProfitCents)} sub={`${pct(t.marginBps)} margin`} tone="good" />
        <Stat label="Average sale" value={money(t.averageTicketCents)} />
        <Stat label="Refunds" value={money(t.refundedCents)} tone={t.refundedCents ? "warn" : undefined} />
        <Stat label="Trade-ins paid" value={money(t.tradeIns.paidCents)} sub={`${t.tradeIns.tickets} tickets`} />
        <Stat label="Needs attention" value={String(d.pendingPayments + d.lowStockCount)} sub={`${d.pendingPayments} card payments · ${d.lowStockCount} low stock`} tone={d.pendingPayments ? "bad" : d.lowStockCount ? "warn" : undefined} />
        {oo && <Stat label="Online orders" value={String(oo.open)} sub={`${oo.new} new online orders · ${oo.ready} ready for pickup`} tone={oo.new > 0 ? "bad" : oo.ready > 0 ? "good" : undefined} />}
        <Stat label="Purchasing" value={String(d.openPurchaseOrders)} sub={`open orders · ${d.transfersInTransit} transfers in transit`} />
      </View>

      <Card title="Sales by hour">
        {d.hourly.length === 0 ? (
          <Text style={ui.muted}>No sales yet today.</Text>
        ) : (
          <View style={[ui.row, { alignItems: "flex-end", gap: 4, height: 120 }]}>
            {d.hourly.map((h) => (
              <View key={h.period} style={{ flex: 1, alignItems: "center", gap: 2 }}>
                <View style={{ width: "100%", height: Math.max(2, (h.netCents / peak) * 100), backgroundColor: colors.accent, borderRadius: 3 }} />
                <Text style={[ui.muted, { fontSize: 10 }]}>{new Date(h.period).getHours()}h</Text>
              </View>
            ))}
          </View>
        )}
      </Card>

      <View style={[ui.row, { flexWrap: "wrap", gap: 12, alignItems: "flex-start" }]}>
        <View style={{ flex: 1, minWidth: 280 }}>
          <Card title="Top items">
            <Table rows={d.topItems} keyOf={(r) => r.key} columns={[{ key: "l", label: "Item", render: (r) => r.label, width: 220 }, { key: "u", label: "Sold", render: (r) => r.units, width: 60, align: "right" }, { key: "n", label: "Net", render: (r) => money(r.netCents), width: 90, align: "right" }]} empty="No sales yet today." />
          </Card>
        </View>
        <View style={{ flex: 1, minWidth: 280 }}>
          <Card title="Payments">
            <Table rows={d.tenders} keyOf={(r) => r.tender} columns={[{ key: "t", label: "Tender", render: (r) => r.tender.replace("_", " "), width: 140 }, { key: "c", label: "Count", render: (r) => r.count, width: 60, align: "right" }, { key: "n", label: "Net", render: (r) => money(r.netCents), width: 90, align: "right" }]} empty="No payments yet today." />
          </Card>
        </View>
      </View>

      {d.lowStock.length > 0 && (
        <Card title={`Low stock (${d.lowStockCount})`}>
          <Table rows={d.lowStock} keyOf={(r) => r.variantId} columns={[{ key: "t", label: "Item", render: (r) => r.title, width: 240 }, { key: "s", label: "SKU", render: (r) => r.sku, width: 150 }, { key: "o", label: "On hand", render: (r) => `${r.onHand} / min ${r.lowStockQty}`, width: 110, align: "right" }]} />
        </Card>
      )}
    </ScrollView>
  );
}
