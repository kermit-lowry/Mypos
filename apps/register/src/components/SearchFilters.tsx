import { CARD_CONDITION_LABELS, type CardCondition } from "@mypos/shared";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { api } from "../api";
import { colors, ui } from "../theme";

export interface Filters {
  sizes: string[];
  grades: string[];
  gradingCompanies: string[];
  conditions: string[];
  /** "NEW" | "USED_ANY" */
  itemConditions: string[];
  /** "true" = slabs only, "false" = raw only */
  graded: "true" | "false" | null;
  inStock: boolean;
  /** Brand ids; combine with sizes etc. ("every Nike in 10 and 10.5"). */
  brands: string[];
}

export const EMPTY_FILTERS: Filters = { sizes: [], grades: [], gradingCompanies: [], conditions: [], itemConditions: [], graded: null, inStock: false, brands: [] };

export const hasFilters = (f: Filters) =>
  f.sizes.length + f.grades.length + f.gradingCompanies.length + f.conditions.length + f.itemConditions.length + f.brands.length > 0 || f.graded !== null || f.inStock;

/** Query string for /catalog/search. */
export function filterParams(f: Filters): string {
  const p = new URLSearchParams();
  if (f.sizes.length) p.set("sizes", f.sizes.join(","));
  if (f.grades.length) p.set("grades", f.grades.join(","));
  if (f.gradingCompanies.length) p.set("gradingCompanies", f.gradingCompanies.join(","));
  if (f.conditions.length) p.set("conditions", f.conditions.join(","));
  if (f.itemConditions.length) p.set("itemConditions", f.itemConditions.join(","));
  if (f.graded) p.set("graded", f.graded);
  if (f.inStock) p.set("inStock", "true");
  if (f.brands.length) p.set("brands", f.brands.join(","));
  const s = p.toString();
  return s ? `&${s}` : "";
}

interface Facet {
  value: string;
  /** Display name (brands: the name; value is the id). */
  label?: string;
  variants: number;
  inStock: number;
}

export interface Facets {
  sizes: Facet[];
  grades: Facet[];
  gradingCompanies: Facet[];
  conditions: Facet[];
  itemConditions: Facet[];
  brands: Facet[];
}

/**
 * Multi-select filter chips: every size 10 and 10.5, every PSA 10, all NM and
 * LP... Choices come from what the store actually stocks.
 */
export function SearchFilters({ value, onChange, locationId }: { value: Filters; onChange: (f: Filters) => void; locationId: string }) {
  const [facets, setFacets] = useState<Facets | null>(null);
  useEffect(() => {
    api<Facets>("GET", `/catalog/facets?locationId=${locationId}`).then(setFacets).catch(() => setFacets(null));
  }, [locationId]);

  const toggle = (key: keyof Omit<Filters, "graded" | "inStock">, v: string) =>
    onChange({ ...value, [key]: value[key].includes(v) ? value[key].filter((x) => x !== v) : [...value[key], v] });

  const Chip = ({ on, label, onPress, dim }: { on: boolean; label: string; onPress: () => void; dim?: boolean }) => (
    <Pressable onPress={onPress} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: on ? colors.accent : colors.panelAlt, opacity: dim && !on ? 0.5 : 1 }}>
      <Text style={ui.text}>{label}</Text>
    </Pressable>
  );
  const Group = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <View style={{ gap: 6 }}>
      <Text style={ui.muted}>{title}</Text>
      <View style={[ui.row, { flexWrap: "wrap", gap: 6 }]}>{children}</View>
    </View>
  );

  return (
    <ScrollView style={{ maxHeight: 260 }} contentContainerStyle={{ gap: 10, paddingVertical: 8 }}>
      <Group title="Show">
        <Chip on={value.inStock} label="In stock here" onPress={() => onChange({ ...value, inStock: !value.inStock })} />
        <Chip on={value.itemConditions.includes("NEW")} label="New" onPress={() => toggle("itemConditions", "NEW")} />
        <Chip on={value.itemConditions.includes("USED_ANY")} label="Used" onPress={() => toggle("itemConditions", "USED_ANY")} />
        <Chip on={value.graded === "true"} label="Graded" onPress={() => onChange({ ...value, graded: value.graded === "true" ? null : "true" })} />
        <Chip on={value.graded === "false"} label="Raw" onPress={() => onChange({ ...value, graded: value.graded === "false" ? null : "false" })} />
        {hasFilters(value) && <Chip on={false} label="✕ Clear filters" onPress={() => onChange(EMPTY_FILTERS)} />}
      </Group>
      {!!facets?.brands.length && (
        <Group title="Brand (pick several)">
          {facets.brands.map((b) => (
            <Chip key={b.value} on={value.brands.includes(b.value)} label={b.label ?? b.value} dim={b.inStock === 0} onPress={() => toggle("brands", b.value)} />
          ))}
        </Group>
      )}
      {!!facets?.sizes.length && (
        <Group title="Size (pick several)">
          {facets.sizes.map((s) => (
            <Chip key={s.value} on={value.sizes.includes(s.value)} label={s.value} dim={s.inStock === 0} onPress={() => toggle("sizes", s.value)} />
          ))}
        </Group>
      )}
      {!!facets?.conditions.length && (
        <Group title="Card condition">
          {facets.conditions.map((c) => (
            <Chip
              key={c.value}
              on={value.conditions.includes(c.value)}
              label={`${c.value} · ${CARD_CONDITION_LABELS[c.value as CardCondition] ?? c.value}`}
              dim={c.inStock === 0}
              onPress={() => toggle("conditions", c.value)}
            />
          ))}
        </Group>
      )}
      {!!facets?.grades.length && (
        <Group title="Grade">
          {facets.gradingCompanies.map((g) => (
            <Chip key={g.value} on={value.gradingCompanies.includes(g.value)} label={g.value} onPress={() => toggle("gradingCompanies", g.value)} />
          ))}
          {facets.grades.map((g) => (
            <Chip key={g.value} on={value.grades.includes(g.value)} label={g.value} dim={g.inStock === 0} onPress={() => toggle("grades", g.value)} />
          ))}
        </Group>
      )}
    </ScrollView>
  );
}
