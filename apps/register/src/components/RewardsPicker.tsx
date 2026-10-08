import { useEffect, useState } from "react";
import { FlatList, Modal, Pressable, Text, View } from "react-native";
import { api, type Reward } from "../api";
import { useLayout } from "../layout";
import { colors, ui } from "../theme";
import { Button } from "./Button";

/** Pick points rewards to redeem on this sale. Rewards the customer can't afford are disabled. */
export function RewardsPicker(props: { points: number; selected: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const { dialog } = useLayout();
  useEffect(() => {
    api<Reward[]>("GET", "/loyalty/rewards").then(setRewards);
  }, []);

  const spent = rewards.filter((r) => props.selected.includes(r.id)).reduce((a, r) => a + r.pointsCost, 0);
  const left = props.points - spent;

  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: "#000b", justifyContent: "center", alignItems: "center" }}>
        <View style={[ui.panel, { width: dialog(520), maxHeight: "85%", gap: 12 }]}>
          <Text style={ui.h1}>Redeem rewards</Text>
          <Text style={ui.muted}>{left.toLocaleString()} points available</Text>
          <FlatList
            data={rewards}
            keyExtractor={(r) => r.id}
            ListEmptyComponent={<Text style={ui.muted}>The owner hasn't set up any rewards yet.</Text>}
            renderItem={({ item: r }) => {
              const on = props.selected.includes(r.id);
              const affordable = on || r.pointsCost <= left;
              return (
                <Pressable
                  disabled={!affordable}
                  onPress={() => props.onChange(on ? props.selected.filter((id) => id !== r.id) : [...props.selected, r.id])}
                  style={[ui.row, { justifyContent: "space-between", padding: 12, borderRadius: 8, opacity: affordable ? 1 : 0.4 }, on && { backgroundColor: colors.panelAlt }]}
                >
                  <Text style={ui.text}>
                    {on ? "✓ " : ""}
                    {r.name}
                  </Text>
                  <Text style={ui.muted}>{r.pointsCost.toLocaleString()} pts</Text>
                </Pressable>
              );
            }}
          />
          <Button title="Done" onPress={props.onClose} />
        </View>
      </View>
    </Modal>
  );
}
