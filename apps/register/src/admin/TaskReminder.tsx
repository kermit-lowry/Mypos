import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { api, ApiError } from "../api";
import { Button } from "../components/Button";
import { useCan, useSession } from "../session";
import { colors, ui } from "../theme";
import { Badge, Input } from "./ui";

/** A task occurrence as GET /tasks/mine returns it (the fields the banner shows). */
interface Occ {
  id: string;
  title: string;
  priority: "LOW" | "NORMAL" | "HIGH";
  requireNote: boolean;
  dueOn: string;
  dueTime: string | null;
  status: "OPEN" | "DONE" | "SKIPPED";
  assignee: { type: "ANYONE" | "ROLE" | "EMPLOYEE"; role?: "OWNER" | "MANAGER" | "CASHIER" | null; employee?: { id: string; name: string } | null };
}
interface Mine {
  today: Occ[];
  overdue: Occ[];
  upcoming: Occ[];
  counts: { open: number; overdue: number; doneToday: number };
}

const ROLE_WORD = { OWNER: "Owners", MANAGER: "Managers", CASHIER: "Cashiers" } as const;
const forText = (a: Occ["assignee"]) => (a.type === "ROLE" && a.role ? ROLE_WORD[a.role] : a.type === "EMPLOYEE" ? (a.employee?.name ?? "An employee") : "Anyone");
const clockOf = (t: string | null) => {
  if (!t) return "End of day";
  const [h, m] = t.split(":").map(Number) as [number, number];
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};
const shortDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString([], { month: "short", day: "numeric" });
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Tells an employee about their tasks when they sign in to the website: a
 * banner with the counts, expandable to the list, where each open task can be
 * marked done. Loads once per sign-in; the parent remembers a dismissal.
 */
export function TaskReminder({ onOpenTasks, onDismiss }: { onOpenTasks: () => void; onDismiss: () => void }) {
  const { location } = useSession();
  const can = useCan();
  const [mine, setMine] = useState<Mine | null>(null);
  const [open, setOpen] = useState(false);
  const [noteFor, setNoteFor] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<Mine>("GET", `/tasks/mine?locationId=${location.id}`)
      .then(setMine)
      .catch(() => undefined);
  useEffect(() => {
    load();
    // Once per sign-in: the banner is about the store you signed in to.
  }, []);

  if (!mine || mine.counts.open === 0) return null;
  const items = [...mine.overdue, ...mine.today].filter((o) => o.status === "OPEN");

  const done = async (o: Occ, note?: string) => {
    setBusy(o.id);
    setError(null);
    try {
      await api("POST", `/tasks/occurrences/${o.id}/complete`, note ? { note } : {});
      setNoteFor(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const small = { minHeight: 32, paddingVertical: 4, paddingHorizontal: 12 };

  return (
    <View style={{ marginHorizontal: 12, marginTop: 12, backgroundColor: colors.panel, borderRadius: 12, borderWidth: 1, borderColor: mine.counts.overdue > 0 ? colors.warn : colors.accent, padding: 12, gap: 8 }}>
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Text style={[ui.text, { flexGrow: 1, fontWeight: "600" }]}>
          You have {plural(mine.counts.open, "task")} today{mine.counts.overdue > 0 ? ` · ${mine.counts.overdue} overdue` : ""}
        </Text>
        <Button title={open ? "Hide" : "Show"} kind="secondary" style={small} onPress={() => setOpen((x) => !x)} />
        {can("MANAGE_TASKS") !== "DENY" && <Button title="Open Tasks" style={small} onPress={onOpenTasks} />}
        <Button title="Dismiss" kind="secondary" style={small} onPress={onDismiss} />
      </View>
      {open && (
        <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 6 }}>
          {items.map((o) => {
            const overdue = mine.overdue.includes(o);
            return (
              <View key={o.id} style={{ paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.border, gap: 6 }}>
                <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
                  <View style={{ flexGrow: 1, flexShrink: 1, gap: 2 }}>
                    <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
                      <Text style={ui.text}>{o.title}</Text>
                      {o.priority === "HIGH" && <Badge text="HIGH" tone="bad" />}
                      {overdue && <Badge text="overdue" tone="warn" />}
                    </View>
                    <Text style={ui.muted}>
                      Due {overdue ? `${shortDay(o.dueOn)} · ` : "by "}
                      {clockOf(o.dueTime)} · {forText(o.assignee)}
                    </Text>
                  </View>
                  {noteFor?.id !== o.id && <Button title="Done" kind="good" style={small} busy={busy === o.id} disabled={!!busy} onPress={() => (o.requireNote ? setNoteFor({ id: o.id, text: "" }) : done(o))} />}
                </View>
                {noteFor?.id === o.id && (
                  <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
                    <View style={{ flexGrow: 1, minWidth: 200 }}>
                      <Input value={noteFor.text} onChange={(text) => setNoteFor({ id: o.id, text })} placeholder="This task needs a note" />
                    </View>
                    <Button title="Mark done" kind="good" style={small} busy={busy === o.id} disabled={!noteFor.text.trim() || !!busy} onPress={() => done(o, noteFor.text.trim())} />
                    <Pressable onPress={() => setNoteFor(null)} style={{ paddingVertical: 6 }}>
                      <Text style={{ color: colors.link, fontSize: 14 }}>Cancel</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })}
          {items.length === 0 && <Text style={ui.muted}>All done.</Text>}
          {error && <Text style={ui.error}>{error}</Text>}
        </ScrollView>
      )}
    </View>
  );
}
