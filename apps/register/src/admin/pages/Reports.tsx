import { ProductKinds } from "@mypos/shared";
import { useEffect, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { api, ApiError, getToken, type Brand, type Vendor } from "../../api";
import { Button } from "../../components/Button";
import { useSession } from "../../session";
import { ui } from "../../theme";
import { Card, Chips, DateRangePicker, day, downloadCsv, money, pct, Picker, PRESETS, Table, when, type Column, type DateRange } from "../ui";

export type Report = "summary" | "period" | "category" | "kind" | "employee" | "product" | "brand" | "game" | "vendor" | "tenders" | "discounts" | "tax" | "trade-ins" | "no-sales" | "valuation" | "low-stock" | "movements" | "purchases" | "transfers";

/** Chips in the order they're shown, under a small heading per group. */
const GROUPS: [string, [Report, string][]][] = [
  ["Sales", [["summary", "Sales summary"], ["period", "Sales over time"], ["employee", "By employee"], ["tenders", "Payment types"], ["discounts", "Discounts"], ["tax", "Sales tax"], ["trade-ins", "Trade-ins"]]],
  ["Items", [["product", "Top items"], ["category", "By category"], ["kind", "By product type"], ["brand", "By brand"], ["game", "By game"], ["vendor", "By vendor"]]],
  ["Stock", [["no-sales", "Dead stock"], ["valuation", "Inventory value"], ["low-stock", "Low stock"], ["movements", "Stock movements"]]],
  ["Purchasing", [["purchases", "Purchases"], ["transfers", "Transfers"]]],
];
const REPORTS = GROUPS.flatMap(([, r]) => r);
/** Reports the server narrows by brand / vendor / category / product type. */
const ITEM_FILTERED: Report[] = ["summary", "period", "category", "kind", "employee", "product", "brand", "game", "vendor", "no-sales", "valuation", "low-stock", "movements"];
const KINDS: [string, string][] = ProductKinds.map((k) => [k, k === "TCG_SINGLE" ? "TCG singles" : k === "TCG_SEALED" ? "TCG sealed" : k.charAt(0) + k.slice(1).toLowerCase().replace("_", " ")]);

interface ItemFilter {
  brandId: string;
  vendorId: string;
  categoryId: string;
  kind: string;
}
const NO_FILTER: ItemFilter = { brandId: "", vendorId: "", categoryId: "", kind: "" };

const label = (k: string) => k.replace(/Cents$/, "").replace(/Bps$/, "").replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const fmt = (k: string, v: unknown) => (k.endsWith("Cents") ? money(v as number) : k.endsWith("Bps") ? pct(v as number) : typeof v === "object" && v ? JSON.stringify(v) : String(v ?? ""));

/** Any report over a date range and location, as a table, with CSV download. */
export function Reports({ initial = "summary" }: { initial?: Report }) {
  const { location } = useSession();
  const [report, setReport] = useState<Report>(initial);
  const [range, setRange] = useState<DateRange>(PRESETS.today!());
  const [group, setGroup] = useState<"hour" | "day" | "week" | "month">("day");
  const [by, setBy] = useState<"category" | "brand">("category");
  const [scope, setScope] = useState<"here" | "all">("here");
  const [filter, setFilter] = useState<ItemFilter>(NO_FILTER);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [categories, setCategories] = useState<{ id: string; path: string }[]>([]);
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Brand[]>("GET", "/catalog/brands").then(setBrands).catch(() => undefined);
    api<Vendor[]>("GET", "/vendors").then(setVendors).catch(() => undefined);
    api<{ id: string; path: string }[]>("GET", "/categories").then(setCategories).catch(() => undefined);
  }, []);

  const filtered = ITEM_FILTERED.includes(report);
  const vendorOnly = report === "purchases";
  // The filters this report takes, as query pairs; purchases only know vendors.
  const pairs: [string, string][] = (filtered ? Object.entries(filter) : vendorOnly ? [["vendorId", filter.vendorId]] : []).filter(([, v]) => v) as [string, string][];
  const nameOf = (k: string, v: string) =>
    k === "brandId" ? brands.find((b) => b.id === v)?.name : k === "vendorId" ? vendors.find((x) => x.id === v)?.name : k === "categoryId" ? categories.find((c) => c.id === v)?.path : KINDS.find(([x]) => x === v)?.[1];
  const active = pairs.map(([k, v]) => nameOf(k, v) ?? v).join(" · ");

  const path = () => {
    const dates = `from=${range.from.toISOString()}&to=${range.to.toISOString()}`;
    const loc = scope === "here" ? `locationId=${location.id}` : "";
    const items = pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    const q = (...parts: string[]) => `?${[...parts, ...items].filter(Boolean).join("&")}`;
    switch (report) {
      case "summary": return `/reports/summary${q(dates, loc)}`;
      case "period": return `/reports/sales-by-period${q(dates, loc, `group=${group}`)}`;
      case "tenders": return `/reports/tenders${q(dates, loc)}`;
      case "discounts": return `/reports/discounts${q(dates, loc)}`;
      case "tax": return `/reports/tax${q(dates, loc)}`;
      case "trade-ins": return `/reports/trade-ins${q(dates, loc)}`;
      case "no-sales": return `/reports/no-sales${q(dates, loc)}`;
      case "valuation": return `/reports/inventory-valuation${q(loc, `by=${by}`)}`;
      case "low-stock": return `/reports/low-stock${q(loc)}`;
      case "movements": return `/reports/stock-movements${q(dates, loc)}`;
      case "purchases": return `/reports/purchases${q(dates, loc)}`;
      case "transfers": return `/reports/transfers${q(dates, loc)}`;
      default: return `/reports/sales-by/${report}${q(dates, loc, "limit=500")}`;
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
        {GROUPS.map(([name, options]) => (
          <View key={name} style={{ gap: 4 }}>
            <Text style={[ui.muted, { fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 }]}>{name}</Text>
            <Chips options={options} value={report} onChange={(r) => (setReport(r as Report), setData(null))} />
          </View>
        ))}
        {dated && <DateRangePicker value={range} onChange={setRange} />}
        {report === "period" && <Chips options={[["hour", "By hour"], ["day", "By day"], ["week", "By week"], ["month", "By month"]]} value={group} onChange={(g) => setGroup(g as never)} />}
        {report === "valuation" && <Chips options={[["category", "By category"], ["brand", "By brand"]]} value={by} onChange={(b) => setBy(b as never)} />}
        {(filtered || vendorOnly) && (
          <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
            {filtered && <Picker label="Brand" options={brands.map((b) => [b.id, b.name])} value={filter.brandId} onChange={(brandId) => setFilter({ ...filter, brandId })} noneLabel="Any brand" />}
            <Picker label="Vendor" options={vendors.map((v) => [v.id, v.name])} value={filter.vendorId} onChange={(vendorId) => setFilter({ ...filter, vendorId })} noneLabel="Any vendor" />
            {filtered && <Picker label="Category" options={categories.map((c) => [c.id, c.path])} value={filter.categoryId} onChange={(categoryId) => setFilter({ ...filter, categoryId })} noneLabel="Any category" />}
            {filtered && <Picker label="Product type" options={KINDS} value={filter.kind} onChange={(kind) => setFilter({ ...filter, kind })} noneLabel="Any type" />}
            {active !== "" && <Button title="Clear" kind="secondary" style={{ minHeight: 46, paddingVertical: 8 }} onPress={() => setFilter(NO_FILTER)} />}
          </View>
        )}
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Chips options={[["here", location.name], ["all", "All locations"]]} value={scope} onChange={(s) => setScope(s as never)} />
          <Button title="Run" onPress={run} busy={busy} />
          {Platform.OS === "web" && data != null && <Button title="Download CSV" kind="secondary" onPress={() => downloadCsv(path(), getToken())} />}
        </View>
        {error && <Text style={ui.error}>{error}</Text>}
      </Card>
      {data != null && <ReportView report={report} data={data} filters={active} by={by} />}
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

const TRANSFER_SUMS = ["qtySent", "qtyReceived", "costSentCents", "costReceivedCents", "priceSentCents", "priceReceivedCents"] as const;
type TransferRow = Record<(typeof TRANSFER_SUMS)[number], number> & { key: string; destination: string; category: string; transfers: number | string; total?: boolean };

function ReportView({ report, data, filters, by }: { report: Report; data: any; filters: string; by: "category" | "brand" }) {
  const t = (s: string) => (filters ? `${s} · ${filters}` : s);
  const byDim: Column<any>[] = [
    { key: "label", label: "Name", render: (r) => r.label, width: 240 },
    { key: "units", label: "Units", render: (r) => r.units, width: 70, align: "right" },
    { key: "orders", label: "Sales", render: (r) => r.orders, width: 70, align: "right" },
    { key: "net", label: "Net", render: (r) => money(r.netCents), width: 100, align: "right" },
    { key: "cost", label: "Cost", render: (r) => money(r.costCents), width: 100, align: "right" },
    { key: "profit", label: "Profit", render: (r) => money(r.profitCents), width: 100, align: "right" },
  ];
  const brandCol: Column<any> = { key: "b", label: "Brand", render: (r) => r.brand ?? "", width: 130 };
  switch (report) {
    case "summary":
      return (
        <Card title={t("Summary")}>
          <KeyValues obj={data} />
          <Text style={ui.h2}>Trade-ins</Text>
          <KeyValues obj={data.tradeIns} />
        </Card>
      );
    case "period":
      return (
        <Card title={t("Sales over time")}>
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
      return <Card title={t("In stock but not sold in this range")}><Table<any> rows={data} keyOf={(r) => r.variantId} columns={[{ key: "t", label: "Item", render: (r) => r.title, width: 240 }, brandCol, { key: "s", label: "SKU", render: (r) => r.sku, width: 150 }, { key: "o", label: "On hand", render: (r) => r.onHand, width: 80, align: "right" }, { key: "r", label: "Retail value", render: (r) => money(r.retailCents), width: 110, align: "right" }, { key: "c", label: "At cost", render: (r) => money(r.costCents), width: 110, align: "right" }]} /></Card>;
    case "valuation":
      return (
        <Card title={t(`Inventory value · ${data.total.units} units · ${money(data.total.costCents)} cost · ${money(data.total.retailCents)} retail`)}>
          <Table<any> rows={data.byCategory} keyOf={(r) => r.category} columns={[{ key: "c", label: by === "brand" ? "Brand" : "Category", render: (r) => r.category, width: 200 }, { key: "s", label: "SKUs", render: (r) => r.skus, width: 70, align: "right" }, { key: "u", label: "Units", render: (r) => r.units, width: 70, align: "right" }, { key: "k", label: "Cost", render: (r) => money(r.costCents), width: 110, align: "right" }, { key: "r", label: "Retail", render: (r) => money(r.retailCents), width: 110, align: "right" }]} />
        </Card>
      );
    case "low-stock":
      return <Card title={t("Low stock")}><Table<any> rows={data} keyOf={(r) => `${r.variantId}-${r.location}`} columns={[{ key: "t", label: "Item", render: (r) => r.title, width: 240 }, brandCol, { key: "s", label: "SKU", render: (r) => r.sku, width: 150 }, { key: "l", label: "Location", render: (r) => r.location, width: 120 }, { key: "o", label: "On hand / min", render: (r) => `${r.onHand} / ${r.lowStockQty}`, width: 110, align: "right" }]} empty="Nothing is low. Set low-stock levels on items to track them." /></Card>;
    case "movements":
      return <Card title={t("Stock movements")}><Table<any> rows={data} keyOf={(r) => `${r.at}-${r.sku}-${r.delta}-${r.note ?? ""}`} columns={[{ key: "a", label: "When", render: (r) => when(r.at), width: 170 }, { key: "t", label: "Item", render: (r) => r.title, width: 220 }, brandCol, { key: "d", label: "Change", render: (r) => (r.delta > 0 ? `+${r.delta}` : String(r.delta)), width: 70, align: "right" }, { key: "r", label: "Reason", render: (r) => `${r.reason}${r.note ? ` · ${r.note}` : ""}`, width: 220 }, { key: "s", label: "By", render: (r) => r.staff ?? "", width: 120 }]} /></Card>;
    case "purchases":
      return (
        <>
          <Card title={t("Purchases")}>
            <KeyValues obj={{ orders: data.orders, openOrders: data.openOrders, finishedOrders: data.finishedOrders, receivedQty: data.receivedQty, receiptSpendCents: data.receiptSpendCents }} />
          </Card>
          <Card title="By vendor">
            <Table<any> rows={data.byVendor} keyOf={(r) => r.vendor} columns={[{ key: "v", label: "Vendor", render: (r) => r.vendor, width: 200 }, { key: "o", label: "Orders", render: (r) => r.orders, width: 70, align: "right" }, { key: "p", label: "Open", render: (r) => r.openOrders, width: 70, align: "right" }, { key: "a", label: "Ordered", render: (r) => money(r.orderedCents), width: 110, align: "right" }, { key: "q", label: "Received", render: (r) => r.receivedQty, width: 90, align: "right" }, { key: "s", label: "Spend", render: (r) => money(r.spendCents), width: 110, align: "right" }]} empty="No purchase orders in this range." />
          </Card>
          <Card title="Deliveries">
            <Table<any> rows={data.receipts} keyOf={(r) => r.receiptId} columns={[{ key: "d", label: "Received", render: (r) => when(r.receivedAt), width: 170 }, { key: "n", label: "PO #", render: (r) => `#${r.poNumber}`, width: 70 }, { key: "v", label: "Vendor", render: (r) => r.vendor, width: 160 }, { key: "l", label: "Location", render: (r) => r.location, width: 120 }, { key: "r", label: "Reference", render: (r) => r.reference ?? "", width: 140 }, { key: "i", label: "Items", render: (r) => r.items, width: 60, align: "right" }, { key: "q", label: "Qty", render: (r) => r.quantity, width: 60, align: "right" }, { key: "u", label: "Unit cost", render: (r) => money(r.quantity ? Math.round(r.costCents / r.quantity) : 0), width: 100, align: "right" }, { key: "c", label: "Cost", render: (r) => money(r.costCents), width: 110, align: "right" }]} empty="Nothing received in this range." />
          </Card>
        </>
      );
    case "transfers": {
      // Rows per destination, a subtotal when it got more than one category, then everything.
      const sum = (list: TransferRow[]) => Object.fromEntries(TRANSFER_SUMS.map((k) => [k, list.reduce((a, r) => a + r[k], 0)])) as Record<(typeof TRANSFER_SUMS)[number], number>;
      const rows: TransferRow[] = [];
      for (const destination of [...new Set<string>(data.rows.map((r: any) => r.destination))]) {
        const mine: TransferRow[] = data.rows.filter((r: any) => r.destination === destination).map((r: any) => ({ ...r, key: `${destination}|${r.category}` }));
        rows.push(...mine);
        if (mine.length > 1) rows.push({ ...sum(mine), key: `${destination}|all`, destination, category: "All categories", transfers: "", total: true });
      }
      rows.push({ ...data.total, key: "total", destination: "Total", category: "", transfers: data.transfers, total: true });
      const cell = (r: TransferRow, v: string | number, right = false) => (r.total ? <Text style={[ui.text, { fontWeight: "700" }, right && { textAlign: "right" }]}>{v}</Text> : v);
      return (
        <Card title={`Transfers · ${data.transfers} received`}>
          <Table<TransferRow>
            rows={rows}
            keyOf={(r) => r.key}
            columns={[
              { key: "d", label: "Destination", render: (r) => cell(r, r.destination), width: 160 },
              { key: "c", label: "Category", render: (r) => cell(r, r.category), width: 160 },
              { key: "n", label: "Transfers", render: (r) => cell(r, r.transfers, true), width: 80, align: "right" },
              { key: "qs", label: "Qty sent", render: (r) => cell(r, r.qtySent, true), width: 80, align: "right" },
              { key: "qr", label: "Qty received", render: (r) => cell(r, r.qtyReceived, true), width: 100, align: "right" },
              { key: "cs", label: "Cost sent", render: (r) => cell(r, money(r.costSentCents), true), width: 110, align: "right" },
              { key: "cr", label: "Cost received", render: (r) => cell(r, money(r.costReceivedCents), true), width: 110, align: "right" },
              { key: "ps", label: "Price sent", render: (r) => cell(r, money(r.priceSentCents), true), width: 110, align: "right" },
              { key: "pr", label: "Price received", render: (r) => cell(r, money(r.priceReceivedCents), true), width: 110, align: "right" },
            ]}
            empty="No transfers were received in this range."
          />
        </Card>
      );
    }
    default:
      return <Card title={t(REPORTS.find((r) => r[0] === report)?.[1] ?? "Report")}><Table<any> rows={data} keyOf={(r) => r.key} columns={byDim} /></Card>;
  }
}
