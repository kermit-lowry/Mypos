import { formatCents, ProductKinds, type ProductKind } from "@mypos/shared";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { api, ApiError, type Product, type Variant } from "../api";
import { Button } from "../components/Button";
import { ProductSearch, variantLabel } from "../components/ProductSearch";
import { useLayout } from "../layout";
import { colors, ui } from "../theme";

interface Program {
  enabled: boolean;
  type: "CASHBACK" | "POINTS";
  cashbackBps: number;
  pointsPerDollar: number;
  excludedKinds: ProductKind[];
  earnOnCredit: boolean;
}

interface RewardRow {
  id: string;
  name: string;
  type: "PERCENT_OFF" | "AMOUNT_OFF" | "ITEM";
  pointsCost: number;
  percentBps: number | null;
  amountCents: number | null;
  maxDiscountCents: number | null;
  active: boolean;
}

const KIND_LABELS: Record<ProductKind, string> = {
  TCG_SINGLE: "Singles",
  TCG_SEALED: "Sealed",
  SNEAKER: "Sneakers",
  APPAREL: "Apparel",
  COLLECTIBLE: "Collectibles",
  ACCESSORY: "Accessories",
  EVENT_ENTRY: "Event entries",
};

/** Owner-only: choose cashback vs points, set earn rates, and manage the rewards menu. */
export function LoyaltySettingsScreen() {
  const { compact } = useLayout();
  const [program, setProgram] = useState<Program | null>(null);
  const [rewards, setRewards] = useState<RewardRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setProgram(await api<Program>("GET", "/loyalty/program"));
    setRewards(await api<RewardRow[]>("GET", "/loyalty/rewards?all=true"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    try {
      setProgram(await api<Program>("PUT", "/loyalty/program", program));
      setMessage("Saved");
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (!program) return <View style={ui.screen} />;
  const set = (patch: Partial<Program>) => setProgram({ ...program, ...patch });

  return (
    <View style={{ flex: 1, flexDirection: compact ? "column" : "row", gap: compact ? 8 : 16, padding: compact ? 8 : 16 }}>
      <ScrollView style={[ui.panel, { flex: 1 }]} contentContainerStyle={{ gap: 14 }}>
        <View style={[ui.row, { justifyContent: "space-between" }]}>
          <Text style={ui.h1}>Loyalty program</Text>
          <Switch value={program.enabled} onValueChange={(enabled) => set({ enabled })} />
        </View>

        <View style={[ui.row, { gap: 8 }]}>
          {(["CASHBACK", "POINTS"] as const).map((t) => (
            <Button key={t} title={t === "CASHBACK" ? "% back on every dollar" : "Points"} kind={program.type === t ? "primary" : "secondary"} onPress={() => set({ type: t })} style={{ flex: 1 }} />
          ))}
        </View>

        {program.type === "CASHBACK" ? (
          <Field label="Customers earn (% of pre-tax spend) as rewards dollars">
            <NumberInput value={program.cashbackBps / 100} onChange={(n) => set({ cashbackBps: Math.round(n * 100) })} suffix="%" />
          </Field>
        ) : (
          <Field label="Points earned per $1 spent (pre-tax, whole dollars)">
            <NumberInput value={program.pointsPerDollar} onChange={(n) => set({ pointsPerDollar: Math.round(n) })} suffix="pts" />
          </Field>
        )}

        <Field label="Product types that don't earn (or take store-wide rewards)">
          <View style={[ui.row, { flexWrap: "wrap", gap: 8 }]}>
            {ProductKinds.map((k) => {
              const on = program.excludedKinds.includes(k);
              return (
                <Pressable
                  key={k}
                  onPress={() => set({ excludedKinds: on ? program.excludedKinds.filter((x) => x !== k) : [...program.excludedKinds, k] })}
                  style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: on ? colors.warn : colors.panelAlt }}
                >
                  <Text style={ui.text}>{KIND_LABELS[k]}</Text>
                </Pressable>
              );
            })}
          </View>
        </Field>

        <View style={[ui.row, { justifyContent: "space-between" }]}>
          <Text style={[ui.text, { flex: 1 }]}>Earn on purchases paid with store credit or rewards</Text>
          <Switch value={program.earnOnCredit} onValueChange={(earnOnCredit) => set({ earnOnCredit })} />
        </View>

        {message && <Text style={ui.muted}>{message}</Text>}
        <Button title="Save program" kind="good" onPress={save} />
        <Text style={ui.muted}>Switching types keeps everyone's existing points and rewards dollars.</Text>
      </ScrollView>

      <View style={[ui.panel, { flex: 1, gap: 12 }]}>
        <Text style={ui.h1}>Points rewards</Text>
        {program.type !== "POINTS" && <Text style={ui.muted}>Rewards are redeemable while the program is set to Points.</Text>}
        <FlatList
          data={rewards}
          keyExtractor={(r) => r.id}
          style={{ flex: 1 }}
          renderItem={({ item: r }) => (
            <View style={[ui.row, { justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, opacity: r.active ? 1 : 0.45 }]}>
              <View style={{ flex: 1 }}>
                <Text style={ui.text}>{r.name}</Text>
                <Text style={ui.muted}>
                  {r.pointsCost.toLocaleString()} pts ·{" "}
                  {r.type === "PERCENT_OFF" ? `${(r.percentBps ?? 0) / 100}% off` : r.type === "AMOUNT_OFF" ? `${formatCents(r.amountCents ?? 0)} off` : "Item"}
                  {r.maxDiscountCents ? ` (max ${formatCents(r.maxDiscountCents)})` : ""}
                </Text>
              </View>
              <Button
                title={r.active ? "Turn off" : "Turn on"}
                kind="secondary"
                onPress={async () => {
                  await api("PATCH", `/loyalty/rewards/${r.id}`, { active: !r.active });
                  load();
                }}
              />
            </View>
          )}
        />
        <NewReward onCreated={load} />
      </View>
    </View>
  );
}

function NewReward({ onCreated }: { onCreated: () => void }) {
  const [type, setType] = useState<"PERCENT_OFF" | "AMOUNT_OFF" | "ITEM">("PERCENT_OFF");
  const [name, setName] = useState("");
  const [points, setPoints] = useState(0);
  const [value, setValue] = useState(0);
  const [cap, setCap] = useState(0);
  const [item, setItem] = useState<{ product: Product; variant: Variant } | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      await api("POST", "/loyalty/rewards", {
        name,
        type,
        pointsCost: points,
        ...(type === "PERCENT_OFF" ? { percentBps: Math.round(value * 100) } : {}),
        ...(type === "AMOUNT_OFF" ? { amountCents: Math.round(value * 100) } : {}),
        ...(type === "ITEM" ? { variantId: item?.variant.id } : {}),
        ...(cap > 0 ? { maxDiscountCents: Math.round(cap * 100) } : {}),
      });
      setName("");
      setPoints(0);
      setValue(0);
      setCap(0);
      setItem(null);
      onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (picking) {
    return (
      <View style={{ height: 360 }}>
        <ProductSearch
          onPick={(product, variant) => {
            setItem({ product, variant });
            if (!name) setName(`Free ${product.title}`);
            setPicking(false);
          }}
        />
      </View>
    );
  }

  return (
    <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
      <View style={[ui.row, { gap: 6 }]}>
        {(["PERCENT_OFF", "AMOUNT_OFF", "ITEM"] as const).map((t) => (
          <Button key={t} title={{ PERCENT_OFF: "% off", AMOUNT_OFF: "$ off", ITEM: "Item" }[t]} kind={type === t ? "primary" : "secondary"} onPress={() => setType(t)} style={{ flex: 1 }} />
        ))}
      </View>
      <TextInput style={ui.input} placeholder="Reward name (e.g. 10% off your order)" placeholderTextColor={colors.muted} value={name} onChangeText={setName} />
      <View style={[ui.row, { gap: 8 }]}>
        <NumberInput value={points} onChange={setPoints} suffix="pts" />
        {type === "PERCENT_OFF" && <NumberInput value={value} onChange={setValue} suffix="% off" />}
        {type === "AMOUNT_OFF" && <NumberInput value={value} onChange={setValue} suffix="$ off" />}
        <NumberInput value={cap} onChange={setCap} suffix={type === "ITEM" ? "$ max (0 = free)" : "$ max (0 = none)"} />
      </View>
      {type === "ITEM" && (
        <Button
          title={item ? `${item.product.title} ${variantLabel(item.variant)}` : "Choose the item…"}
          kind="secondary"
          onPress={() => setPicking(true)}
        />
      )}
      {error && <Text style={ui.error}>{error}</Text>}
      <Button title="Add reward" onPress={create} disabled={!name || points <= 0 || (type === "ITEM" ? !item : value <= 0)} />
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={ui.muted}>{label}</Text>
      {children}
    </View>
  );
}

function NumberInput({ value, onChange, suffix }: { value: number; onChange: (n: number) => void; suffix: string }) {
  return (
    <View style={[ui.row, { gap: 6, flex: 1 }]}>
      <TextInput
        style={[ui.input, { flex: 1 }]}
        keyboardType="decimal-pad"
        defaultValue={value ? String(value) : ""}
        onChangeText={(t) => {
          const n = Number(t);
          if (Number.isFinite(n) && n >= 0) onChange(n);
        }}
      />
      <Text style={ui.muted}>{suffix}</Text>
    </View>
  );
}
