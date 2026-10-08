import { useState } from "react";
import { Modal, Text, TextInput, View } from "react-native";
import { useLayout } from "../layout";
import { colors, ui } from "../theme";
import { Button } from "./Button";

/** Cross-platform number entry (Alert.prompt only exists on iOS). */
export function NumberPrompt(props: { title: string; message?: string; initial?: string; onSubmit: (n: number) => void; onClose: () => void }) {
  const { dialog } = useLayout();
  const [text, setText] = useState(props.initial ?? "");
  const n = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(n) && n >= 0;
  const submit = () => {
    if (!valid) return;
    props.onSubmit(n);
    props.onClose();
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: "#000b", justifyContent: "center", alignItems: "center" }}>
        <View style={[ui.panel, { width: dialog(380), gap: 12 }]}>
          <Text style={ui.h1}>{props.title}</Text>
          {props.message && <Text style={ui.muted}>{props.message}</Text>}
          <TextInput
            style={ui.input}
            value={text}
            onChangeText={setText}
            keyboardType="decimal-pad"
            autoFocus
            selectTextOnFocus
            onSubmitEditing={submit}
            placeholderTextColor={colors.muted}
          />
          <View style={[ui.row, { gap: 8 }]}>
            <Button title="Cancel" kind="secondary" onPress={props.onClose} />
            <Button title="OK" onPress={submit} disabled={!valid} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
