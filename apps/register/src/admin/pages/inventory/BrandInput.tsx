import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { api, type Brand } from "../../../api";
import { colors, ui } from "../../../theme";
import { Field, Input } from "../../ui";

/** Brand name box that offers existing brands as you type; tapping one fills the name. */
export function BrandInput({ value, onChange, label = "Brand" }: { value: string; onChange: (v: string) => void; label?: string }) {
  const [matches, setMatches] = useState<Brand[]>([]);
  // The name last picked from the list (or the one we started with): no suggestions for it.
  const [chosen, setChosen] = useState<string | null>(value.trim() || null);
  const q = value.trim();

  useEffect(() => {
    if (!q || q === chosen) {
      setMatches([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api<Brand[]>("GET", `/catalog/brands?q=${encodeURIComponent(q)}`)
        .then((b) => {
          if (live) setMatches(b.slice(0, 8));
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, chosen]);

  const pick = (name: string) => {
    setChosen(name);
    onChange(name);
  };

  return (
    <Field label={label}>
      <Input value={value} onChange={onChange} placeholder="e.g. Nike" />
      {matches.length > 0 && (
        <View style={[ui.row, { flexWrap: "wrap", gap: 6 }]}>
          {matches.map((b) => (
            <Pressable key={b.id} onPress={() => pick(b.name)} style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 14, backgroundColor: colors.panelAlt }}>
              <Text style={ui.text}>
                {b.name}
                {b.active ? "" : " (inactive)"}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </Field>
  );
}
