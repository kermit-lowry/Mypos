import { discountBps, formatCents } from "@mypos/shared";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { api } from "../api";
import { useLayout } from "../layout";
import { useCan, useSession } from "../session";
import { colors, ui } from "../theme";
import { Button } from "./Button";

export interface DiscountReason {
  id: string;
  name: string;
  requiresNote: boolean;
}

export interface DiscountPreset {
  id: string;
  label: string;
  kind: "PERCENT" | "AMOUNT";
  value: number;
  reasonId: string | null;
}

export interface AppliedDiscount {
  /** Cents off each target line, same order as `targets`. */
  amounts: number[];
  presetId?: string;
  reasonId?: string;
  reasonName?: string;
  note?: string;
  /** Largest discount as a share of its line, for limit checks. */
  maxBps: number;
}

/** Spread `cents` across lines by their value (whole-cart $ discounts). */
function spread(cents: number, grosses: number[]): number[] {
  const total = grosses.reduce((a, b) => a + b, 0);
  if (total <= 0) return grosses.map(() => 0);
  const capped = Math.min(cents, total);
  const out = grosses.map((g) => Math.floor((capped * g) / total));
  let left = capped - out.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % out.length) {
    if (out[i]! < grosses[i]!) {
      out[i]!++;
      left--;
    }
  }
  return out;
}

/**
 * Manual discount: tap a store discount button or type an amount (if allowed),
 * pick a reason (required when the store has reasons), apply to one item or
 * the whole cart.
 */
export function DiscountSheet(props: {
  title: string;
  /** Gross (price x qty) of each line the discount applies to. */
  grosses: number[];
  onApply: (d: AppliedDiscount) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const { dialog } = useLayout();
  const can = useCan();
  const { permissions } = useSession();
  const [presets, setPresets] = useState<DiscountPreset[]>([]);
  const [reasons, setReasons] = useState<DiscountReason[]>([]);
  const [preset, setPreset] = useState<DiscountPreset | null>(null);
  const [kind, setKind] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  const [value, setValue] = useState("");
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    api<DiscountPreset[]>("GET", "/discount-presets").then(setPresets);
    api<DiscountReason[]>("GET", "/discount-reasons").then(setReasons);
  }, []);

  const customAllowed = can("DISCOUNT_CUSTOM") !== "DENY";
  const k = preset?.kind ?? kind;
  const raw = preset ? preset.value : Math.round(Number(value) * 100);
  const amounts = !Number.isFinite(raw) || raw <= 0 ? props.grosses.map(() => 0) : k === "PERCENT" ? props.grosses.map((g) => Math.min(g, Math.floor((g * raw) / 10_000))) : spread(raw, props.grosses);
  const total = amounts.reduce((a, b) => a + b, 0);
  const maxBps = Math.max(0, ...amounts.map((a, i) => discountBps(a, props.grosses[i]!)));
  const reason = reasons.find((r) => r.id === reasonId);
  const needsReason = reasons.length > 0;
  const ready = total > 0 && (!needsReason || !!reason) && (!reason?.requiresNote || note.trim().length > 0);
  const overLimit = maxBps > permissions.discountMaxBps || can("DISCOUNT_LINE") === "PIN";

  const pick = (p: DiscountPreset) => {
    setPreset(p);
    if (p.reasonId) setReasonId(p.reasonId);
  };

  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: dialog(520), maxHeight: "90%", flexGrow: 0 }]} contentContainerStyle={{ gap: 12 }}>
          <Text style={ui.h1}>{props.title}</Text>

          {presets.length > 0 && (
            <View style={[ui.row, { flexWrap: "wrap", gap: 8 }]}>
              {presets.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => pick(p)}
                  style={{ paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10, backgroundColor: preset?.id === p.id ? colors.accent : colors.panelAlt, minWidth: 90, alignItems: "center" }}
                >
                  <Text style={[ui.text, { fontWeight: "700" }]}>{p.label}</Text>
                  <Text style={ui.muted}>{p.kind === "PERCENT" ? `${p.value / 100}%` : formatCents(p.value)}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {customAllowed ? (
            <View style={[ui.row, { gap: 8 }]}>
              {(["PERCENT", "AMOUNT"] as const).map((x) => (
                <Button key={x} title={x === "PERCENT" ? "%" : "$"} kind={!preset && kind === x ? "primary" : "secondary"} onPress={() => (setPreset(null), setKind(x))} />
              ))}
              <TextInput
                style={[ui.input, { flex: 1 }]}
                keyboardType="decimal-pad"
                placeholder={kind === "PERCENT" ? "Custom %" : "Custom $"}
                placeholderTextColor={colors.muted}
                value={value}
                onChangeText={(t) => (setPreset(null), setValue(t))}
              />
            </View>
          ) : (
            presets.length === 0 && <Text style={ui.muted}>No discount buttons are set up, and custom amounts are turned off for you.</Text>
          )}

          {needsReason && (
            <>
              <Text style={ui.muted}>Reason</Text>
              <View style={[ui.row, { flexWrap: "wrap", gap: 8 }]}>
                {reasons.map((r) => (
                  <Pressable key={r.id} onPress={() => setReasonId(r.id)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: reasonId === r.id ? colors.accent : colors.panelAlt }}>
                    <Text style={ui.text}>{r.name}</Text>
                  </Pressable>
                ))}
              </View>
              {reason?.requiresNote && (
                <TextInput style={ui.input} value={note} onChangeText={setNote} placeholder={`Note for "${reason.name}"`} placeholderTextColor={colors.muted} />
              )}
            </>
          )}

          <Text style={ui.h2}>{total > 0 ? `−${formatCents(total)}` : " "}</Text>
          {total > 0 && overLimit && <Text style={[ui.muted, { color: colors.warn }]}>This needs a manager's PIN.</Text>}

          <View style={[ui.row, { gap: 8 }]}>
            <Button title="Cancel" kind="secondary" onPress={props.onClose} />
            {props.onRemove && <Button title="Remove discount" kind="secondary" onPress={() => (props.onRemove!(), props.onClose())} />}
            <Button
              title="Apply"
              kind="good"
              disabled={!ready}
              style={{ flex: 1 }}
              onPress={() => {
                props.onApply({ amounts, presetId: preset?.id, reasonId: reason?.id, reasonName: reason?.name, note: note.trim() || undefined, maxBps });
                props.onClose();
              }}
            />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
