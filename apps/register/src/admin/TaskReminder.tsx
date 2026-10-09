import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api } from "../api";
import { Button } from "../components/Button";
import { useSession } from "../session";
import { colors, ui } from "../theme";

/** The fields of GET /tasks/board the summary counts. */
interface Board {
  date: string;
  occurrences: { id: string; status: "OPEN" | "DONE" | "SKIPPED" }[];
  overdue: { id: string }[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The store's task summary for someone who manages tasks, shown when they
 * sign in to the website: how many of the store's tasks are open today and
 * how many are overdue. Website users have no tasks of their own, and tasks
 * are completed on the Tasks page, so there is nothing to tick off here.
 * Loads once per sign-in (for the store signed in to); the parent remembers
 * a dismissal. Without MANAGE_TASKS it renders nothing and asks for nothing.
 */
export function TaskReminder({ onOpenTasks, onDismiss }: { onOpenTasks: () => void; onDismiss: () => void }) {
  const { location, permissions } = useSession();
  const allowed = permissions.levels.MANAGE_TASKS === "ALLOW";
  const [board, setBoard] = useState<Board | null>(null);
  const [store] = useState(location);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    api<Board>("GET", `/tasks/board?locationId=${store.id}`)
      .then((b) => live && setBoard(b))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Once per sign-in: the summary is about the store you signed in to.
  }, []);

  if (!allowed || !board) return null;
  const open = board.occurrences.filter((o) => o.status === "OPEN").length;
  const overdue = board.overdue.length;
  if (open === 0 && overdue === 0) return null;
  const small = { minHeight: 32, paddingVertical: 4, paddingHorizontal: 12 };

  return (
    <View style={{ marginHorizontal: 12, marginTop: 12, backgroundColor: colors.panel, borderRadius: 12, borderWidth: 1, borderColor: overdue > 0 ? colors.warn : colors.accent, padding: 12 }}>
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Text style={[ui.text, { flexGrow: 1, fontWeight: "600" }]}>
          {store.name}: {plural(open, "task")} open today{overdue > 0 ? ` · ${overdue} overdue` : ""}
        </Text>
        <Button title="Open Tasks" style={small} onPress={onOpenTasks} />
        <Button title="Dismiss" kind="secondary" style={small} onPress={onDismiss} />
      </View>
    </View>
  );
}
