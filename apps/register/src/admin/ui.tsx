import { formatCents } from "@mypos/shared";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { getApiUrl } from "../api";
import { Button } from "../components/Button";
import { useLayout } from "../layout";
import { colors, ui } from "../theme";

export const money = (c: number | null | undefined) => (c == null ? "" : formatCents(c));
export const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
export const when = (iso: string | Date) => new Date(iso).toLocaleString();
export const day = (iso: string | Date) => new Date(iso).toLocaleDateString();

export function Card({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <View style={[ui.panel, { gap: 10 }]}>
      {(title || right) && (
        <View style={[ui.row, { justifyContent: "space-between" }]}>
          {title && <Text style={ui.h2}>{title}</Text>}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

/** A number with a label, for the dashboard. */
export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? colors.good : tone === "bad" ? colors.bad : tone === "warn" ? colors.warn : colors.text;
  return (
    <View style={[ui.panel, { minWidth: 140, flexGrow: 1, gap: 2 }]}>
      <Text style={ui.muted}>{label}</Text>
      <Text style={[ui.h1, { color, fontSize: 24 }]}>{value}</Text>
      {sub && <Text style={ui.muted}>{sub}</Text>}
    </View>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode | string | number;
  align?: "right";
  width?: number;
}

/** Table on wide screens; a stack of label/value cards on phones. */
export function Table<T>({ rows, columns, keyOf, empty, onPress }: { rows: T[]; columns: Column<T>[]; keyOf: (r: T) => string; empty?: string; onPress?: (r: T) => void }) {
  const { narrow } = useLayout();
  const cell = (c: Column<T>, r: T) => {
    const v = c.render(r);
    return typeof v === "string" || typeof v === "number" ? <Text style={[ui.text, c.align === "right" && { textAlign: "right" }]}>{v}</Text> : v;
  };
  if (rows.length === 0) return <Text style={ui.muted}>{empty ?? "Nothing here."}</Text>;
  if (narrow) {
    return (
      <View style={{ gap: 8 }}>
        {rows.map((r) => (
          <Pressable key={keyOf(r)} onPress={onPress ? () => onPress(r) : undefined} style={{ backgroundColor: colors.panelAlt, borderRadius: 8, padding: 10, gap: 4 }}>
            {columns.map((c) => (
              <View key={c.key} style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
                <Text style={ui.muted}>{c.label}</Text>
                <View style={{ flexShrink: 1 }}>{cell(c, r)}</View>
              </View>
            ))}
          </Pressable>
        ))}
      </View>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ minWidth: "100%" }}>
        <View style={[ui.row, { borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 6, gap: 12 }]}>
          {columns.map((c) => (
            <Text key={c.key} style={[ui.muted, { width: c.width ?? 140, fontWeight: "600" }, c.align === "right" && { textAlign: "right" }]}>
              {c.label}
            </Text>
          ))}
        </View>
        {rows.map((r) => (
          <Pressable key={keyOf(r)} onPress={onPress ? () => onPress(r) : undefined} style={({ pressed }) => [ui.row, { paddingVertical: 8, gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border }, pressed && { backgroundColor: colors.panelAlt }]}>
            {columns.map((c) => (
              <View key={c.key} style={{ width: c.width ?? 140 }}>
                {cell(c, r)}
              </View>
            ))}
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

export function Chips({ options, value, onChange }: { options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={[ui.row, { flexWrap: "wrap", gap: 6 }]}>
      {options.map(([v, label]) => (
        <Pressable key={v} onPress={() => onChange(v)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: value === v ? colors.accent : colors.panelAlt }}>
          <Text style={ui.text}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 4, flexGrow: 1, minWidth: 140 }}>
      <Text style={ui.muted}>{label}</Text>
      {children}
    </View>
  );
}

export function Input(props: { value: string; onChange: (t: string) => void; placeholder?: string; keyboard?: "default" | "decimal-pad" | "number-pad" | "email-address"; secure?: boolean; multiline?: boolean }) {
  return (
    <TextInput
      style={[ui.input, props.multiline && { minHeight: 70 }]}
      value={props.value}
      onChangeText={props.onChange}
      placeholder={props.placeholder}
      placeholderTextColor={colors.muted}
      keyboardType={props.keyboard ?? "default"}
      secureTextEntry={props.secure}
      multiline={props.multiline}
      autoCapitalize="none"
      autoCorrect={false}
    />
  );
}

export interface DateRange {
  from: Date;
  to: Date;
  label: string;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
export const PRESETS: Record<string, () => DateRange> = {
  today: () => ({ from: startOfDay(new Date()), to: addDays(startOfDay(new Date()), 1), label: "Today" }),
  yesterday: () => ({ from: addDays(startOfDay(new Date()), -1), to: startOfDay(new Date()), label: "Yesterday" }),
  week: () => {
    const t = startOfDay(new Date());
    const from = addDays(t, -t.getDay());
    return { from, to: addDays(from, 7), label: "This week" };
  },
  month: () => {
    const n = new Date();
    return { from: new Date(n.getFullYear(), n.getMonth(), 1), to: new Date(n.getFullYear(), n.getMonth() + 1, 1), label: "This month" };
  },
  last30: () => ({ from: addDays(startOfDay(new Date()), -29), to: addDays(startOfDay(new Date()), 1), label: "Last 30 days" }),
  year: () => {
    const n = new Date();
    return { from: new Date(n.getFullYear(), 0, 1), to: new Date(n.getFullYear() + 1, 0, 1), label: "This year" };
  },
};

export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(value.from.toISOString().slice(0, 10));
  const [to, setTo] = useState(addDays(value.to, -1).toISOString().slice(0, 10));
  return (
    <View style={{ gap: 8 }}>
      <Chips
        options={[...Object.entries(PRESETS).map(([k, f]) => [k, f().label] as [string, string]), ["custom", "Custom"]]}
        value={custom ? "custom" : (Object.keys(PRESETS).find((k) => PRESETS[k]!().label === value.label) ?? "custom")}
        onChange={(k) => {
          if (k === "custom") return setCustom(true);
          setCustom(false);
          onChange(PRESETS[k]!());
        }}
      />
      {custom && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Field label="From (YYYY-MM-DD)">
            <Input value={from} onChange={setFrom} />
          </Field>
          <Field label="To (inclusive)">
            <Input value={to} onChange={setTo} />
          </Field>
          <Button
            title="Apply"
            kind="secondary"
            onPress={() => {
              const f = new Date(`${from}T00:00:00`);
              const t = addDays(new Date(`${to}T00:00:00`), 1);
              if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime()) && t > f) onChange({ from: f, to: t, label: `${from} to ${to}` });
            }}
          />
        </View>
      )}
    </View>
  );
}

/** Download a report as CSV (browser only). */
export async function downloadCsv(path: string, token: string | null) {
  if (Platform.OS !== "web") return;
  const res = await fetch(`${getApiUrl()}${path}${path.includes("?") ? "&" : "?"}format=csv`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "report.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
