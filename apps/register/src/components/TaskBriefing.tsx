import { Modal, ScrollView, Text, View } from "react-native";
import type { MyTasks, TaskOccurrence } from "../api";
import { useLayout } from "../layout";
import { useSession } from "../session";
import { assigneeLabel, dayLabel, dueLabel } from "../tasks";
import { colors, ui } from "../theme";
import { Button } from "./Button";

const MAX_ROWS = 8;

/**
 * The sign-in briefing: "Hi Sam — 3 tasks today", what is overdue, and the
 * first few tasks. Shown once per sign-in by the TasksProvider.
 */
export function TaskBriefing({ data, onOpen, onLater }: { data: MyTasks; onOpen: () => void; onLater: () => void }) {
  const { staff } = useSession();
  const { dialog } = useLayout();
  const first = staff.name.trim().split(/\s+/)[0] || staff.name;
  const n = data.counts.open;
  const overdue = data.counts.overdue;
  const all = [...data.overdue, ...data.today];
  const rows = all.slice(0, MAX_ROWS);
  const more = all.length - rows.length;

  return (
    <Modal transparent animationType="fade" onRequestClose={onLater}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
        <View style={[ui.panel, { width: dialog(520), maxHeight: "70%", gap: 12 }]}>
          <View style={{ gap: 2 }}>
            <Text style={ui.h1}>
              Hi {first} — {n} {n === 1 ? "task" : "tasks"} today
            </Text>
            <Text style={[ui.muted, overdue > 0 ? { color: colors.bad, fontWeight: "600" } : null]}>{overdue > 0 ? `${overdue} overdue` : "Nothing overdue"}</Text>
          </View>
          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 2 }}>
            {rows.map((o) => (
              <BriefingRow key={o.id} occurrence={o} overdue={data.overdue.some((x) => x.id === o.id)} meId={staff.id} />
            ))}
            {more > 0 && <Text style={[ui.muted, { paddingVertical: 8 }]}>+{more} more</Text>}
          </ScrollView>
          <View style={[ui.row, { gap: 8 }]}>
            <Button title="Later" kind="secondary" onPress={onLater} />
            <Button title="Open tasks" onPress={onOpen} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function BriefingRow({ occurrence: o, overdue, meId }: { occurrence: TaskOccurrence; overdue: boolean; meId: string }) {
  const steps = o.checklist.length;
  const done = o.checklistDone.filter((i) => i < steps).length;
  return (
    <View style={[ui.row, { gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
      <View style={{ width: 18, alignItems: "center" }}>
        {o.priority === "HIGH" && (
          <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: colors.bad, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "700" }}>!</Text>
          </View>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[ui.text, { fontWeight: "600" }]} numberOfLines={1}>
          {o.title}
        </Text>
        <Text style={[ui.muted, overdue ? { color: colors.bad } : null]} numberOfLines={2}>
          {overdue ? `due ${dayLabel(o.dueOn)}${o.dueTime ? ` ${dueLabel(o)}` : ""}` : dueLabel(o)}
          {steps > 0 ? ` · ✓ ${done}/${steps} steps` : ""}
        </Text>
      </View>
      <Tag label={assigneeLabel(o, meId)} />
    </View>
  );
}

/** A small "Anyone" / "You" / "Managers" tag. */
export function Tag({ label, color }: { label: string; color?: string }) {
  return (
    <View style={{ paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6, backgroundColor: colors.panelAlt, borderWidth: 1, borderColor: color ?? colors.border }}>
      <Text style={[ui.muted, { fontSize: 12, fontWeight: "700" }, color ? { color } : null]}>{label}</Text>
    </View>
  );
}
