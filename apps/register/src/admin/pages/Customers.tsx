import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { api, ApiError, type Customer } from "../../api";
import { useGuard } from "../../approval";
import { Button } from "../../components/Button";
import { SplitPane } from "../../components/SplitPane";
import { useCan } from "../../session";
import { colors, ui } from "../../theme";
import { Badge, Card, day, Field, Input, money, Table, when } from "../ui";

interface Detail extends Customer {
  phone: string | null;
  storeCreditCents: number;
  loyalty: { points: number; rewardsCents: number };
  createdAt: string;
}
/** A row from GET /layaways?customerId=… (page-local; the Layaways page owns the full shape). */
interface CustomerLayaway {
  id: string;
  number: number;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  overdue?: boolean;
  dueAt: string;
}
const LAYAWAY_STATUS: Record<string, { text: string; tone: "good" | "bad" | "warn" | "muted" }> = { ACTIVE: { text: "active", tone: "warn" }, COMPLETED: { text: "picked up", tone: "good" }, CANCELLED: { text: "cancelled", tone: "muted" } };
const layawayOverdue = (l: CustomerLayaway) => l.status === "ACTIVE" && (l.overdue ?? new Date(l.dueAt).getTime() < Date.now());

/** Find a customer; see and adjust balances; recent sales. */
export function Customers() {
  const can = useCan();
  const guard = useGuard();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [picked, setPicked] = useState<Detail | null>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [layaways, setLayaways] = useState<CustomerLayaway[]>([]);
  const [showRight, setShowRight] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [credit, setCredit] = useState("");
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");

  const search = async () => {
    if (!q.trim()) return;
    setResults(await api("GET", `/customers?q=${encodeURIComponent(q.trim())}`));
  };
  const open = async (c: Customer) => {
    const d = await api<Detail>("GET", `/customers/${c.id}`);
    setPicked(d);
    setName(d.name);
    setEmail(d.email ?? "");
    setPhone(d.phone ?? "");
    setOrders(await api("GET", `/orders?customerId=${c.id}&take=20`));
    // An older server without layaways shouldn't stop the customer from opening.
    setLayaways(await api<CustomerLayaway[]>("GET", `/layaways?customerId=${c.id}&take=50`).then((r) => (Array.isArray(r) ? r : [])).catch(() => []));
    setShowRight(true);
    setMessage(null);
  };
  /** Runs an action and refreshes the customer. `fn` resolving to false means it was cancelled at the PIN pad: refresh, but no "done" message. */
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      const r = await fn();
      if (picked) await open(picked);
      if (r !== false) setMessage(ok);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <SplitPane
      leftLabel="Find"
      rightLabel="Customer"
      showRight={showRight}
      onToggle={setShowRight}
      left={
        <View style={{ flex: 1, gap: 8 }}>
          <View style={[ui.row, { gap: 8 }]}>
            <View style={{ flex: 1 }}>
              <Input value={q} onChange={setQ} placeholder="Name, email, or phone" />
            </View>
            <Button title="Search" onPress={search} />
            {can("MANAGE_CUSTOMERS") !== "DENY" && <Button title="+ New" kind="secondary" onPress={() => run(async () => open(await api("POST", "/customers", { name: q.trim() || "New customer" })), "Customer added")} disabled={!q.trim()} />}
          </View>
          <Table rows={results} keyOf={(c) => c.id} onPress={open} columns={[{ key: "n", label: "Name", render: (c) => c.name, width: 200 }, { key: "e", label: "Email", render: (c) => c.email ?? "", width: 220 }]} empty="Search for a customer." />
        </View>
      }
      right={
        picked ? (
          <ScrollView contentContainerStyle={{ gap: 12 }}>
            <Card title={picked.name}>
              <View style={[ui.row, { gap: 16, flexWrap: "wrap" }]}>
                <Text style={ui.text}>Store credit {money(picked.storeCreditCents)}</Text>
                <Text style={ui.text}>{picked.loyalty.points.toLocaleString()} points</Text>
                <Text style={ui.text}>Rewards {money(picked.loyalty.rewardsCents)}</Text>
                <Text style={ui.muted}>Since {when(picked.createdAt)}</Text>
              </View>
              {can("MANAGE_CUSTOMERS") !== "DENY" && (
                <>
                  <Field label="Name"><Input value={name} onChange={setName} /></Field>
                  <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
                    <Field label="Email"><Input value={email} onChange={setEmail} keyboard="email-address" /></Field>
                    <Field label="Phone"><Input value={phone} onChange={setPhone} /></Field>
                  </View>
                  <Button title="Save" kind="secondary" onPress={() => run(() => api("PATCH", `/customers/${picked.id}`, { name: name.trim(), email: email.trim() || null, phone: phone.trim() || null }), "Saved")} />
                </>
              )}
            </Card>
            {can("ADJUST_BALANCES") !== "DENY" && (
              <Card title="Adjust balances">
                <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
                  <Field label="Store credit ($, + or −)"><Input value={credit} onChange={setCredit} keyboard="default" /></Field>
                  <Field label="Points (+ or −)"><Input value={points} onChange={setPoints} keyboard="default" /></Field>
                  <Field label="Reason"><Input value={reason} onChange={setReason} placeholder="e.g. Goodwill" /></Field>
                  <Button title={can("ADJUST_BALANCES") === "PIN" ? "Apply · PIN" : "Apply"} disabled={!reason.trim() || (!credit && !points)} onPress={() => run(async () => {
                    const c = Math.round(Number(credit) * 100);
                    const p = Math.round(Number(points));
                    // Approval grants are single-use, so each call asks on its own; a field is cleared once its change is in.
                    if (credit && Number.isFinite(c) && c !== 0) {
                      const r = await guard("ADJUST_BALANCES", async (t) => (await api("POST", `/customers/${picked.id}/credit`, { amountCents: c, reason: reason.trim() }, { approvalToken: t }), true));
                      if (r === undefined) return false;
                      setCredit("");
                    }
                    if (points && Number.isFinite(p) && p !== 0) {
                      const r = await guard("ADJUST_BALANCES", async (t) => (await api("POST", `/customers/${picked.id}/loyalty`, { unit: "POINTS", amount: p, reason: reason.trim() }, { approvalToken: t }), true));
                      if (r === undefined) return false;
                      setPoints("");
                    }
                    setReason("");
                    return true;
                  }, "Balances updated")} />
                </View>
              </Card>
            )}
            {message && <Text style={ui.text}>{message}</Text>}
            <Card title="Recent sales">
              <Table rows={orders} keyOf={(o) => o.id} columns={[{ key: "n", label: "Sale", render: (o) => `#${o.number}`, width: 80 }, { key: "w", label: "When", render: (o) => when(o.createdAt), width: 170 }, { key: "i", label: "Items", render: (o) => o.lines.map((l: any) => `${l.quantity}× ${l.title}`).join(", "), width: 300 }, { key: "t", label: "Total", render: (o) => money(o.totalCents + (o.cardAdjustmentCents ?? 0)), width: 90, align: "right" }, { key: "s", label: "Status", render: (o) => o.status.toLowerCase().replace("_", " "), width: 120 }]} empty="No sales yet." />
            </Card>
            <Card title="Layaways">
              <Table<CustomerLayaway>
                rows={layaways}
                keyOf={(l) => l.id}
                columns={[
                  { key: "n", label: "Layaway", render: (l) => `#${l.number}`, width: 90 },
                  { key: "s", label: "Status", render: (l) => <Badge text={LAYAWAY_STATUS[l.status]?.text ?? String(l.status).toLowerCase()} tone={LAYAWAY_STATUS[l.status]?.tone} />, width: 100 },
                  { key: "t", label: "Total", render: (l) => money(l.totalCents), width: 90, align: "right" },
                  { key: "p", label: "Paid", render: (l) => money(l.paidCents), width: 90, align: "right" },
                  { key: "b", label: "Balance", render: (l) => money(l.balanceCents), width: 90, align: "right" },
                  { key: "d", label: "Due", render: (l) => <Text style={[ui.text, layawayOverdue(l) && { color: colors.bad }]}>{day(l.dueAt)}{layawayOverdue(l) ? " · overdue" : ""}</Text>, width: 160 },
                ]}
                empty="No layaways."
              />
              <Text style={ui.muted}>Take payments at a register; extend, cancel or print statements from Sales › Layaways.</Text>
            </Card>
          </ScrollView>
        ) : (
          <Text style={ui.muted}>Pick a customer.</Text>
        )
      }
    />
  );
}
