import { useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { api, ApiError, getToken } from "../../api";
import { Button } from "../../components/Button";
import { useSession } from "../../session";
import { ui } from "../../theme";
import { Card, Chips, DateRangePicker, day, downloadCsv, money, pct, PRESETS, Table, when, type Column, type DateRange } from "../ui";

type Report = "summary" | "period" | "category" | "kind" | "employee" | "product" | "brand" | "game" | "tenders" | "discounts" | "tax" | "trade-ins" | "no-sales" | "valuation" | "low-stock" | "movements";

const REPORTS: [Report, string][] = [
  ["summary", "Sales summary"],
  ["period", "Sales over time"],
  ["category", "By category"],
  ["kind", "By product type"],
  ["product", "Top items"],
  ["employee", "By employee"],
  ["brand", "By brand"],
  ["game", "By game"],
  ["tenders", "Payment types"],
  ["discounts", "Discounts"],
  ["tax", "Sales tax"],
  ["trade-ins", "Trade-ins"],
  ["no-sales", "Dead stock"],
  ["valuation", "Inventory value"],
  ["low-stock", "Low stock"],
  ["movements", "Stock movements"],
];

const label = (k: string) => k.replace(/Cents$/, "").replace(/Bps$/, "").replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const fmt = (k: string, v: unknown) => (k.endsWith("Cents") ? money(v as number) : k.endsWith("Bps") ? pct(v as number) : typeof v === "object" && v ? JSON.stringify(v) : String(v ?? ""));

/** Any report over a date range and location, as a table, with CSV download. */
export function Reports() {
  const { location } = useSession();
  const [report, setReport] = useState<Report>("summary");
  const [range, setRange] = useState<DateRange>(PRESETS.today!());
  const [group, setGroup] = useState<"hour" | "day" | "week" | "month">("day");
  const [scope, setScope] = useState<"here" | "all">("here");
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const path = () => {
    const base = `from=${range.from.toISOString()}&to=${range.to.toISOString()}${scope === "here" ? `&locationId=${location.id}` : ""}`;
    const loc = scope === "here" ? `locationId=${location.id}` : "";
    switch (report) {
      case "summary": return `/reports/summary?${base}`;
      case "period": return `/reports/sales-by-period?${base}&group=${group}`;
      case "tenders": return `/reports/tenders?${base}`;
      case "discounts": return `/reports/discounts?${base}`;
      case "tax": return `/reports/tax?${base}`;
      case "trade-ins": return `/reports/trade-ins?${base}`;
      case "no-sales": return `/reports/no-sales?${base}`;
      case "valuation": return `/reports/inventory-valuation?${loc}`;
      case "low-stock": return `/reports/low-stock?${loc}`;
      case "movements": return `/reports/stock-movements?${base}`;
      default: return `/reports/sales-by/${report}?${base}&limit=500`;
    }
  };

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setData(await api("GET", path()));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const dated = !["valuation", "low-stock"].includes(report);
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card title="Report">
        <Chips options={REPORTS} value={report} onChange={(r) => (setReport(r as Report), setData(null))} />
        {dated && <DateRangePicker value={range} onChange={setRange} />}
        {report === "period" && <Chips options={[["hour", "By hour"], ["day", "By day"], ["week", "By week"], ["month", "By month"]]} value={group} onChange={(g) => setGroup(g as never)} />}
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Chips options={[["here", location.name], ["all", "All locations"]]} value={scope} onChange={(s) => setScope(s as never)} />
          <Button title="Run" onPress={run} busy={busy} />
          {Platform.OS === "web" && data != null && <Button title="Download CSV" kind="secondary" onPress={() => downloadCsv(path(), getToken())} />}
        </View>
        {error && <Text style={ui.error}>{error}</Text>}
      </Card>
      {data != null && <ReportView report={report} data={data} />}
    </ScrollView>
  );
}

function KeyValues({ obj }: { obj: Record<string, unknown> }) {
  return (
    <View style={{ gap: 4 }}>
      {Object.entries(obj)
        .filter(([, v]) => typeof v !== "object" || v === null)
        .map(([k, v]) => (
          <View key={k} style={[ui.row, { justifyContent: "space-between" }]}>
            <Text style={ui.muted}>{label(k)}</Text>
            <Text style={ui.text}>{fmt(k, v)}</Text>
          </View>
        ))}
    </View>
  );
}

function ReportView({ report, data }: { report: Report; data: any }) {
  const byDim: Column<any>[] = [
    { key: "label", label: "Name", render: (r) => r.label, width: 240 },
    { key: "units", label: "Units", render: (r) => r.units, width: 70, align: "right" },
    { key: "orders", label: "Sales", render: (r) => r.orders, width: 70, align: "right" },
    { key: "net", label: "Net", render: (r) => money(r.netCents), width: 100, align: "right" },
    { key: "cost", label: "Cost", render: (r) => money(r.costCents), width: 100, align: "right" },
    { key: "profit", label: "Profit", render: (r) => money(r.profitCents), width: 100, align: "right" },
  ];
  switch (report) {
    case "summary":
      return (
        <Card title="Summary">
          <KeyValues obj={data} />
          <Text style={ui.h2}>Trade-ins</Text>
          <KeyValues obj={data.tradeIns} />
        </Card>
      );
    case "period":
      return (
        <Card title="Sales over time">
          <Table<any> rows={data} keyOf={(r) => r.period} columns={[{ key: "p", label: "Period", render: (r) => (r.period.includes("T00:00") ? day(r.period) : when(r.period)), width: 180 }, { key: "o", label: "Sales", render: (r) => r.orders, width: 70, align: "right" }, { key: "u", label: "Units", render: (r) => r.units, width: 70, align: "right" }, { key: "n", label: "Net", render: (r) => money(r.netCents), width: 100, align: "right" }, { key: "t", label: "Tax", render: (r) => money(r.taxCents), width: 100, align: "right" }]} />
        </Card>
      );
    case "tenders":
      return <Card title="Payment types"><Table<any> rows={data} keyOf={(r) => r.tender} columns={[{ key: "t", label: "Tender", render: (r) => r.tender.replace("_", " "), width: 160 }, { key: "c", label: "Count", render: (r) => r.count, width: 70, align: "right" }, { key: "n", label: "Net", render: (r) => money(r.netCents), width: 110, align: "right" }]} /></Card>;
    case "discounts":
      return (
        <>
          <Card title="Manual discounts by reason"><Table<any> rows={data.manual} keyOf={(r) => r.reason} columns={[{ key: "r", label: "Reason", render: (r) => r.reason, width: 200 }, { key: "c", label: "Count", render: (r) => r.count, width: 70, align: "right" }, { key: "a", label: "Amount", render: (r) => money(r.amountCents), width: 110, align: "right" }]} empty="No manual discounts." /></Card>
          <Card title="Automated deals"><Table<any> rows={data.deals} keyOf={(r) => r.name} columns={[{ key: "n", label: "Deal", render: (r) => r.name, width: 200 }, { key: "c", label: "Times", render: (r) => r.count, width: 70, align: "right" }, { key: "a", label: "Amount", render: (r) => money(r.amountCents), width: 110, align: "right" }]} empty="No deals applied." /></Card>
        </>
      );
    case "tax":
      return <Card title="Sales tax"><KeyValues obj={data} /></Card>;
    case "trade-ins":
      return (
        <>
          <Card title="Trade-ins"><KeyValues obj={{ tickets: data.tickets, items: data.items, paidCents: data.paidCents, suggestedCents: data.suggestedCents, overSuggestedCents: data.overSuggestedCents, cashPaidCents: data.byPayout.CASH.paidCents, storeCreditPaidCents: data.byPayout.STORE_CREDIT.paidCents }} /></Card>
          <Card title="By employee"><Table<any> rows={data.byStaff} keyOf={(r) => r.staff} columns={[{ key: "s", label: "Employee", render: (r) => r.staff, width: 180 }, { key: "t", label: "Tickets", render: (r) => r.tickets, width: 70, align: "right" }, { key: "p", label: "Paid", render: (r) => money(r.paidCents), width: 110, align: "right" }]} /></Card>
        </>
      );
    case "no-sales":
      return <Card title="In stock but not sold in this range"><Table<any> rows={data} keyOf={(r) => r.variantId} columns={[{ key: "t", label: "Item", render: (r) => r.title, width: 240 }, { key: "s", label: "SKU", render: (r) => r.sku, width: 150 }, { key: "o", label: "On hand", render: (r) => r.onHand, width: 80, align: "right" }, { key: "r", label: "Retail value", render: (r) => money(r.retailCents), width: 110, align: "right" }, { key: "c", label: "At cost", render: (r) => money(r.costCents), width: 110, align: "right" }]} /></Card>;
    case "valuation":
      return (
        <Card title={`Inventory value · ${data.total.units} units · ${money(data.total.costCents)} cost · ${money(data.total.retailCents)} retail`}>
          <Table<any> rows={data.byCategory} keyOf={(r) => r.category} columns={[{ key: "c", label: "Category", render: (r) => r.category, width: 200 }, { key: "s", label: "SKUs", render: (r) => r.skus, width: 70, align: "right" }, { key: "u", label: "Units", render: (r) => r.units, width: 70, align: "right" }, { key: "k", label: "Cost", render: (r) => money(r.costCents), width: 110, align: "right" }, { key: "r", label: "Retail", render: (r) => money(r.retailCents), width: 110, align: "right" }]} />
        </Card>
      );
    case "low-stock":
      return <Card title="Low stock"><Table<any> rows={data} keyOf={(r) => `${r.variantId}-${r.location}`} columns={[{ key: "t", label: "Item", render: (r) => r.title, width: 240 }, { key: "s", label: "SKU", render: (r) => r.sku, width: 150 }, { key: "l", label: "Location", render: (r) => r.location, width: 120 }, { key: "o", label: "On hand / min", render: (r) => `${r.onHand} / ${r.lowStockQty}`, width: 110, align: "right" }]} empty="Nothing is low. Set low-stock levels on items to track them." /></Card>;
    case "movements":
      return <Card title="Stock movements"><Table<any> rows={data} keyOf={(r) => `${r.at}-${r.sku}-${r.delta}-${r.note ?? ""}`} columns={[{ key: "a", label: "When", render: (r) => when(r.at), width: 170 }, { key: "t", label: "Item", render: (r) => r.title, width: 220 }, { key: "d", label: "Change", render: (r) => (r.delta > 0 ? `+${r.delta}` : String(r.delta)), width: 70, align: "right" }, { key: "r", label: "Reason", render: (r) => `${r.reason}${r.note ? ` · ${r.note}` : ""}`, width: 220 }, { key: "s", label: "By", render: (r) => r.staff ?? "", width: 120 }]} /></Card>;
    default:
      return <Card title={REPORTS.find((r) => r[0] === report)?.[1]}><Table<any> rows={data} keyOf={(r) => r.key} columns={byDim} /></Card>;
  }
}
