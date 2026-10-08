import { useEffect, useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import { api, ApiError, type Brand } from "../../../api";
import { Button } from "../../../components/Button";
import { useLayout } from "../../../layout";
import { useCan } from "../../../session";
import { colors, ui } from "../../../theme";
import { Card, Field, Input, Picker, Table, type Column } from "../../ui";

const small = { minHeight: 32, paddingVertical: 4, paddingHorizontal: 10 } as const;

/** Every brand in the catalog: rename (all its products follow), retire, or fold duplicates together. */
export function Brands({ onFind }: { onFind?: (b: Brand) => void }) {
  const can = useCan();
  const canEdit = can("MANAGE_CATALOG") !== "DENY";
  const { narrow } = useLayout();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [merge, setMerge] = useState<{ id: string; intoId: string; confirm: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<Brand[]>("GET", "/catalog/brands")
      .then(setBrands)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  useEffect(() => {
    load();
  }, []);

  const run = async <T,>(fn: () => Promise<T>, ok: (r: T) => string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(ok(await fn()));
      await load();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (await run(() => api<Brand>("POST", "/catalog/brands", { name: name.trim() }), (b) => `Added ${b.name}`)) setName("");
  };
  const rename = async () => {
    if (!editing) return;
    const before = brands.find((b) => b.id === editing.id);
    const next = editing.name.trim();
    if (!before || !next || next === before.name) return setEditing(null);
    if (await run(() => api<Brand>("PATCH", `/catalog/brands/${editing.id}`, { name: next }), (b) => `Renamed to ${b.name} on ${before.products ?? 0} products`)) setEditing(null);
  };
  const setActive = (b: Brand, active: boolean) => run(() => api<Brand>("PATCH", `/catalog/brands/${b.id}`, { active }), () => (active ? `${b.name} is active again` : `${b.name} retired`));
  const doMerge = async () => {
    if (!merge) return;
    if (await run(() => api<{ into: Brand; moved: number }>("POST", `/catalog/brands/${merge.id}/merge`, { intoId: merge.intoId }), (r) => `Moved ${r.moved} products into ${r.into.name}`)) setMerge(null);
  };

  const shown = brands.filter((b) => b.name.toLowerCase().includes(q.trim().toLowerCase()));
  const from = merge ? brands.find((b) => b.id === merge.id) : undefined;
  const into = merge ? brands.find((b) => b.id === merge.intoId) : undefined;

  const columns: Column<Brand>[] = [
    {
      key: "n",
      label: "Name",
      render: (b) =>
        editing && editing.id === b.id ? (
          <View style={{ minWidth: 160 }}>
            <Input value={editing.name} onChange={(v) => setEditing({ id: b.id, name: v })} />
          </View>
        ) : (
          <Text style={[ui.text, !b.active && { color: colors.muted }]}>
            {b.name}
            {b.active ? "" : " (inactive)"}
          </Text>
        ),
      width: 220,
    },
    { key: "p", label: "Products", render: (b) => b.products ?? 0, width: 90, align: "right" },
    { key: "a", label: "Active", render: (b) => <Switch value={b.active} disabled={!canEdit || busy} onValueChange={(active) => {
            setActive(b, active);
          }} />, width: 80 },
    {
      key: "x",
      label: "",
      render: (b) => (
        <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
          {onFind && <Button title="Find items" kind="secondary" onPress={() => onFind(b)} style={small} />}
          {canEdit &&
            (editing && editing.id === b.id ? (
              <>
                <Button title="Save" kind="good" busy={busy} onPress={rename} style={small} />
                <Button title="Cancel" kind="secondary" onPress={() => setEditing(null)} style={small} />
              </>
            ) : (
              <>
                <Button title="Rename" kind="secondary" disabled={busy} onPress={() => (setEditing({ id: b.id, name: b.name }), setMerge(null))} style={small} />
                <Button title="Merge into…" kind="secondary" disabled={busy} onPress={() => (setMerge({ id: b.id, intoId: "", confirm: false }), setEditing(null))} style={small} />
              </>
            ))}
        </View>
      ),
      width: 380,
    },
  ];

  return (
    <ScrollView contentContainerStyle={{ gap: 12 }}>
      <Card title="Brands" right={<Text style={ui.muted}>{brands.length} total</Text>}>
        <View style={narrow ? { gap: 8 } : [ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
          <Field label="Search">
            <Input value={q} onChange={setQ} placeholder="Filter by name" />
          </Field>
          {canEdit && (
            <>
              <Field label="New brand">
                <Input value={name} onChange={setName} placeholder="e.g. Jordan" />
              </Field>
              <Button title="+ New brand" kind="secondary" onPress={create} disabled={!name.trim()} busy={busy} />
            </>
          )}
        </View>
        <Text style={ui.muted}>Brands are matched by name, so "nike" and "Nike" are one brand. Renaming one updates every product that carries it.</Text>
        {error && <Text style={ui.error}>{error}</Text>}
        {message && <Text style={ui.text}>{message}</Text>}
        <Table rows={shown} columns={columns} keyOf={(b) => b.id} empty={q.trim() ? "No brands match." : "No brands yet — they're created as you add products."} />
      </Card>

      {merge && from && (
        <Card title={`Merge ${from.name} into…`}>
          <Text style={ui.muted}>
            Moves {from.products ?? 0} products onto the brand you pick and removes "{from.name}". This can't be undone.
          </Text>
          <View style={narrow ? { gap: 8 } : [ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
            <Picker label="Into" options={brands.filter((b) => b.id !== merge.id).map((b) => [b.id, b.name] as [string, string])} value={merge.intoId} onChange={(intoId) => setMerge({ ...merge, intoId, confirm: false })} placeholder="Choose a brand" allowNone={false} />
            {merge.confirm && into ? (
              <Button title={`Confirm merge ${from.products ?? 0} products into ${into.name}`} kind="danger" busy={busy} onPress={doMerge} />
            ) : (
              <Button title="Merge" kind="danger" disabled={!merge.intoId} onPress={() => setMerge({ ...merge, confirm: true })} />
            )}
            <Button title="Cancel" kind="secondary" onPress={() => setMerge(null)} />
          </View>
        </Card>
      )}
    </ScrollView>
  );
}
