import { formatCents } from "@mypos/shared";
import { useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { api, ApiError, type Customer } from "../api";
import { colors, ui } from "../theme";
import { Button } from "./Button";

export function CustomerPicker({ customer, onChange }: { customer: Customer | null; onChange: (c: Customer | null) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function pick(c: Customer) {
    // Re-fetch for the live store-credit balance.
    onChange(await api<Customer>("GET", `/customers/${c.id}`));
    setOpen(false);
  }

  async function create() {
    try {
      const c = await api<Customer>("POST", "/customers", q.includes("@") ? { name: q.split("@")[0], email: q } : { name: q });
      await pick(c);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <>
      <Pressable onPress={() => (customer ? onChange(null) : setOpen(true))} style={[ui.panel, { padding: 12 }]}>
        {customer ? (
          <View style={[ui.row, { justifyContent: "space-between" }]}>
            <Text style={ui.text}>{customer.name}</Text>
            <Text style={ui.muted}>Credit {formatCents(customer.storeCreditCents ?? 0)} · tap to remove</Text>
          </View>
        ) : (
          <Text style={ui.muted}>+ Attach customer</Text>
        )}
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: "#000a", justifyContent: "center", padding: 80 }}>
          <View style={[ui.panel, { maxHeight: "90%" }]}>
            <Text style={ui.h1}>Customer</Text>
            <TextInput
              style={[ui.input, { marginTop: 12 }]}
              placeholder="Name, email or phone"
              placeholderTextColor={colors.muted}
              value={q}
              onChangeText={setQ}
              autoFocus
              onSubmitEditing={async () => setResults(await api<Customer[]>("GET", `/customers?q=${encodeURIComponent(q)}`))}
            />
            {error && <Text style={ui.error}>{error}</Text>}
            <FlatList
              data={results}
              keyExtractor={(c) => c.id}
              style={{ marginVertical: 12 }}
              renderItem={({ item }) => (
                <Pressable onPress={() => pick(item)} style={{ paddingVertical: 12 }}>
                  <Text style={ui.text}>{item.name}</Text>
                  {item.email && <Text style={ui.muted}>{item.email}</Text>}
                </Pressable>
              )}
            />
            <View style={[ui.row, { gap: 8 }]}>
              <Button title={`New customer "${q}"`} kind="secondary" disabled={!q.trim()} onPress={create} style={{ flex: 1 }} />
              <Button title="Close" kind="secondary" onPress={() => setOpen(false)} />
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}
