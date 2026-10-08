import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { api } from "../api";
import { useSession } from "../session";
import { colors, ui } from "../theme";
import { Button } from "./Button";

export interface Terminal {
  id: string;
  name: string;
  model: string | null;
  gatewayRef: string;
}

/** The card terminal paired with this register, remembered on the device. */
export function useTerminal() {
  const { location } = useSession();
  const [terminals, setTerminals] = useState<Terminal[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const list = await api<Terminal[]>("GET", `/terminals?locationId=${location.id}`).catch(() => []);
      const saved = await SecureStore.getItemAsync(`terminal:${location.id}`);
      setTerminals(list);
      setSelectedId(list.find((t) => t.id === saved)?.id ?? (list.length === 1 ? list[0]!.id : null));
    })();
  }, [location.id]);

  const select = async (id: string) => {
    setSelectedId(id);
    await SecureStore.setItemAsync(`terminal:${location.id}`, id);
  };

  return { terminals, terminal: terminals?.find((t) => t.id === selectedId) ?? null, select };
}

export function TerminalPicker(props: { terminals: Terminal[]; selectedId?: string; onSelect: (id: string) => void; onClose: () => void }) {
  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: "#000b", justifyContent: "center", alignItems: "center" }}>
        <View style={[ui.panel, { width: 460, gap: 10 }]}>
          <Text style={ui.h1}>Card terminal for this register</Text>
          {props.terminals.length === 0 && (
            <Text style={ui.muted}>No terminals at this location yet. A manager can import them from Handpoint.</Text>
          )}
          {props.terminals.map((t) => (
            <Pressable
              key={t.id}
              onPress={() => {
                props.onSelect(t.id);
                props.onClose();
              }}
              style={[{ padding: 14, borderRadius: 8, backgroundColor: colors.panelAlt }, t.id === props.selectedId && { borderWidth: 2, borderColor: colors.accent }]}
            >
              <Text style={ui.text}>{t.name}</Text>
              <Text style={ui.muted}>
                {t.model ?? "Terminal"} · SN {t.gatewayRef}
              </Text>
            </Pressable>
          ))}
          <Button title="Close" kind="secondary" onPress={props.onClose} />
        </View>
      </View>
    </Modal>
  );
}
