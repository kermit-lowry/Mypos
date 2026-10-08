import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { api, type Location, type Vendor } from "../../api";
import { Button } from "../../components/Button";
import { useLayout } from "../../layout";
import { useCan, useSession } from "../../session";
import { ui } from "../../theme";
import { Card, Chips, type Column, day, Input, money, openDocument, Picker, Table } from "../ui";
import { fromServer, newPo, type Po, type PoStatus, qtyOf, receivedOf, small, StatusBadge, totalOf } from "./purchasing/common";
import { PoEditor } from "./purchasing/PoEditor";
import { VendorEditor, VendorList, type VendorPick } from "./purchasing/Vendors";

type StatusFilter = "open" | PoStatus | "all";
const STATUS_FILTERS: [StatusFilter, string][] = [
  ["open", "Open"],
  ["DRAFT", "Draft"],
  ["ORDERED", "Ordered"],
  ["PARTIAL", "Partial"],
  ["RECEIVED", "Received"],
  ["CANCELLED", "Cancelled"],
  ["all", "All"],
];

/** Vendors and purchase orders: build, order, receive. */
export function Purchasing({ view: initialView = "orders" }: { view?: "orders" | "vendors" }) {
  const { location } = useSession();
  const can = useCan();
  const { narrow } = useLayout();
  const [view, setView] = useState<"orders" | "vendors">(initialView);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [orders, setOrders] = useState<Po[]>([]);
  const [editing, setEditing] = useState<Po | null>(null);
  const [vendor, setVendor] = useState<VendorPick>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [vendorId, setVendorId] = useState("");
  const [locationId, setLocationId] = useState(location.id);
  const [error, setError] = useState<string | null>(null);
  const canManage = can("MANAGE_PURCHASING") !== "DENY";

  // The sidebar has an entry for each view.
  useEffect(() => setView(initialView), [initialView]);

  const loadVendors = useCallback(async () => setVendors(await api("GET", "/vendors")), []);
  useEffect(() => {
    loadVendors().catch(() => undefined);
    api<Location[]>("GET", "/locations").then(setLocations).catch(() => undefined);
  }, [loadVendors]);

  const query = [status === "open" ? "open=true" : status === "all" ? "" : `status=${status}`, vendorId && `vendorId=${vendorId}`, locationId && `locationId=${locationId}`, q.trim() && `q=${encodeURIComponent(q.trim())}`].filter(Boolean).join("&");
  const loadOrders = useCallback(async () => {
    try {
      setOrders((await api<any[]>("GET", `/purchase-orders${query ? `?${query}` : ""}`)).map(fromServer));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [query]);
  // Typing in the search box re-queries after a short pause.
  useEffect(() => {
    const t = setTimeout(loadOrders, 250);
    return () => clearTimeout(t);
  }, [loadOrders]);

  const openPo = (po: Po) => setEditing(po);
  const startPo = (forVendor: string) => setEditing(newPo(forVendor, locationId || location.id));
  const print = (po: Po) => openDocument(`/purchase-orders/${po.id}/print`).catch((e) => setError(e instanceof Error ? e.message : String(e)));

  if (editing) {
    return (
      <PoEditor
        key={editing.id ?? "new"}
        initial={editing}
        vendors={vendors}
        locations={locations}
        onDone={() => {
          setEditing(null);
          loadOrders();
          loadVendors().catch(() => undefined);
        }}
      />
    );
  }
  if (view === "vendors" && vendor) {
    return (
      <VendorEditor
        key={vendor === "new" ? "new" : vendor.id}
        initial={vendor === "new" ? null : vendor}
        onBack={() => setVendor(null)}
        onChanged={async (saved) => {
          await loadVendors();
          if (saved) setVendor(saved);
        }}
        onOpenPo={openPo}
        onNewPo={startPo}
      />
    );
  }

  const columns: Column<Po>[] = [
    { key: "n", label: "PO #", render: (o) => `#${o.number}`, width: 70 },
    { key: "v", label: "Vendor", render: (o) => o.vendor?.name ?? "", width: 170 },
    { key: "s", label: "Status", render: (o) => <StatusBadge status={o.status} />, width: 90 },
    { key: "r", label: "Reference", render: (o) => o.reference ?? "", width: 120 },
    { key: "loc", label: "Location", render: (o) => o.location?.name ?? "", width: 120 },
    { key: "c", label: "Created", render: (o) => (o.createdAt ? day(o.createdAt) : ""), width: 100 },
    { key: "e", label: "Expected", render: (o) => (o.expectedAt ? day(o.expectedAt) : ""), width: 100 },
    { key: "i", label: "Items", render: (o) => `${o.lines.length} / ${qtyOf(o.lines)}`, width: 80, align: "right" },
    { key: "t", label: "Total", render: (o) => money(totalOf(o)), width: 100, align: "right" },
    { key: "rc", label: "Received", render: (o) => `${receivedOf(o.lines)} / ${qtyOf(o.lines)}`, width: 90, align: "right" },
    { key: "d", label: "Deliveries", render: (o) => o.receipts?.length ?? 0, width: 80, align: "right" },
    ...(narrow
      ? []
      : [
          {
            key: "a",
            label: "",
            render: (o: Po) => (
              <View style={[ui.row, { gap: 6 }]}>
                <Button title={o.status === "DRAFT" && canManage ? "Edit" : "View"} kind="secondary" style={small} onPress={() => openPo(o)} />
                <Button title="Print" kind="secondary" style={small} onPress={() => print(o)} />
              </View>
            ),
            width: 150,
          },
        ]),
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Chips options={[["orders", "Purchase orders"], ["vendors", "Vendors"]]} value={view} onChange={(v) => setView(v as "orders" | "vendors")} />
      {view === "orders" ? (
        <Card title="Purchase orders" right={canManage ? <Button title={narrow ? "+ New" : "+ New purchase order"} kind="good" style={small} onPress={() => startPo(vendorId || vendors.find((v) => v.active)?.id || "")} /> : undefined}>
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            <View style={{ flexGrow: 2, flexBasis: 240, minWidth: 200 }}>
              <Input value={q} onChange={setQ} placeholder="Search PO #, reference or vendor…" />
            </View>
            <Picker options={vendors.map((v): [string, string] => [v.id, v.name])} value={vendorId} onChange={setVendorId} noneLabel="All vendors" />
            <Picker options={locations.map((l): [string, string] => [l.id, l.name])} value={locationId} onChange={setLocationId} noneLabel="All locations" />
          </View>
          <Chips options={STATUS_FILTERS} value={status} onChange={(s) => setStatus(s as StatusFilter)} />
          {error && <Text style={ui.error}>{error}</Text>}
          <Table rows={orders} keyOf={(o) => o.id ?? ""} onPress={openPo} columns={columns} empty={status === "open" && !q && !vendorId ? "No open purchase orders." : "No purchase orders match."} />
        </Card>
      ) : (
        <VendorList vendors={vendors} onSelect={setVendor} onChanged={loadVendors} />
      )}
    </ScrollView>
  );
}
