import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, RefreshControl, ScrollView, SectionList, Text, TextInput, View } from "react-native";
import { api, ApiError, type TaskOccurrence } from "../api";
import { NotPermitted, useGuard } from "../approval";
import { Button } from "../components/Button";
import { SplitPane } from "../components/SplitPane";
import { Tag } from "../components/TaskBriefing";
import { useLayout } from "../layout";
import { useCan, useSession } from "../session";
import { assigneeLabel, clockLabel, dayLabel, dueLabel, timeLabel, useTasks } from "../tasks";
import { colors, ui } from "../theme";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** The weekday of a "YYYY-MM-DD" day, parsed by parts. */
const weekdayOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).getDay();
};
const priorityColor = (p: TaskOccurrence["priority"]) => (p === "HIGH" ? colors.bad : p === "LOW" ? colors.border : colors.accent);
const priorityLabel = (p: TaskOccurrence["priority"]) => (p === "HIGH" ? "High priority" : p === "LOW" ? "Low priority" : "Normal priority");
const steps = (o: TaskOccurrence) => o.checklist.length;
const stepsDone = (o: TaskOccurrence, done: Iterable<number> = o.checklistDone) => [...done].filter((i) => i >= 0 && i < o.checklist.length).length;

/**
 * "Every day" / "Weekly on Mon, Thu" / "Monthly on the 1st" / "One time". An
 * older API leaves the schedule off the occurrence; then only this one's day
 * is known, and the label says so rather than reading as the whole schedule.
 */
function repeatsLabel(o: TaskOccurrence): string {
  switch (o.recurrence) {
    case "DAILY":
      return "Every day";
    case "WEEKLY": {
      const days = o.daysOfWeek?.filter((d) => d >= 0 && d < 7).sort((a, b) => a - b);
      if (days?.length) return `Weekly on ${days.map((d) => WEEKDAY_LONG[d]!.slice(0, 3)).join(", ")}`;
      return `Weekly (this one on ${WEEKDAY_LONG[weekdayOf(o.dueOn)]})`;
    }
    case "MONTHLY": {
      if (o.dayOfMonth === 31) return "Monthly on the last day";
      if (o.dayOfMonth) return `Monthly on the ${ordinal(o.dayOfMonth)}`;
      const d = Number(o.dueOn.slice(8, 10));
      return `Monthly (this one on the ${ordinal(d)})`;
    }
    default:
      return "One time";
  }
}

/** The local calendar day of an ISO instant as "YYYY-MM-DD", so it agrees with the clock time shown beside it. */
function localDayOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Done · Sam · 10:12 AM · late" / "Skipped · Sam" for the list and the detail. */
function outcomeLabel(o: TaskOccurrence): { text: string; late: boolean } | null {
  if (o.status === "OPEN") return null;
  const who = o.completedBy?.name;
  const when = o.completedAt ? clockLabel(o.completedAt) : null;
  const head = o.status === "DONE" ? "Done" : "Skipped";
  return { text: [head, who, o.status === "DONE" ? when : null].filter(Boolean).join(" · "), late: o.status === "DONE" && o.late };
}

/** Friendlier wording for the task errors an employee can act on. */
function taskError(e: unknown, o: TaskOccurrence, meId: string): string {
  if (e instanceof ApiError) {
    if (e.code === "TASK_NOT_YOURS") return `This task is for ${assigneeLabel(o, meId)}; a manager can complete it`;
    if (e.code === "TASK_NOT_OPEN") return "This task was already completed on another register.";
    if (e.code === "NOTE_REQUIRED") return "A note is required to complete this task.";
  }
  return errorMessage(e);
}

// ─── List ────────────────────────────────────────────────────────

type Filter = "TODO" | "UPCOMING" | "DONE" | "EVERYONE";
interface Row {
  o: TaskOccurrence;
  /** Show the day it is due (overdue rows); rows under a day header or due today show just the time. */
  showDay: boolean;
}
interface Section {
  key: string;
  title: string;
  color?: string;
  data: Row[];
}
interface Board {
  date: string;
  occurrences: TaskOccurrence[];
  overdue: TaskOccurrence[];
}

/** Group what is coming up by day: "Thu, Oct 9", "Fri, Oct 10"… */
function byDay(rows: TaskOccurrence[]): Section[] {
  const out: Section[] = [];
  for (const o of rows) {
    const last = out[out.length - 1];
    if (last && last.key === o.dueOn) last.data.push({ o, showDay: false });
    else out.push({ key: o.dueOn, title: dayLabel(o.dueOn), data: [{ o, showDay: false }] });
  }
  return out;
}

/**
 * The employee's tasks for this store: what is overdue and due today, what is
 * coming up, what was done today, and (managers) everyone's day. Tap a task
 * to tick its checklist, complete it with a note, or skip it with a reason.
 */
export function TasksScreen() {
  const { location, staff } = useSession();
  const can = useCan();
  const { narrow } = useLayout();
  const { data, refresh: refreshMine } = useTasks();
  const manage = can("MANAGE_TASKS") === "ALLOW";
  const [filter, setFilter] = useState<Filter>("TODO");
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  /** Tasks finished on this register this sign-in, for "Done today" when the board isn't ours to see. */
  const [finished, setFinished] = useState<Record<string, TaskOccurrence>>({});
  /** The last copy of the selected task seen in any list. */
  const lastSelected = useRef<TaskOccurrence | null>(null);
  const useBoard = manage && (filter === "EVERYONE" || filter === "DONE");

  const loadBoard = useCallback(async () => {
    if (!manage) return;
    try {
      const b = await api<Board>("GET", `/tasks/board?locationId=${encodeURIComponent(location.id)}`);
      setBoard({ date: b?.date ?? "", occurrences: b?.occurrences ?? [], overdue: b?.overdue ?? [] });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [location.id, manage]);
  // The board is loaded when a manager looks at it, and again each time the employee's own poll lands.
  useEffect(() => {
    if (useBoard) void loadBoard();
  }, [useBoard, loadBoard, data]);

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([refreshMine(), useBoard ? loadBoard() : Promise.resolve()]);
    setRefreshing(false);
  };
  /** After any step on a task: the badge, the lists, and the done-today record. */
  const changed = (o?: TaskOccurrence) => {
    if (o && o.status !== "OPEN") setFinished((f) => ({ ...f, [o.id]: o }));
    if (o && o.status === "OPEN") setFinished(({ [o.id]: _, ...f }) => f);
    void refreshMine();
    if (manage) void loadBoard();
  };

  const counts = data?.counts;
  // Without the board, "Done today" lists what this register finished this sign-in, so its count comes from the same place.
  const doneToday = manage ? counts?.doneToday : Object.keys(finished).length;
  let sections: Section[] = [];
  let empty = data ? "Nothing to do right now" : "Loading…";
  if (filter === "TODO" && data) {
    if (data.overdue.length) sections.push({ key: "overdue", title: "Overdue", color: colors.bad, data: data.overdue.map((o) => ({ o, showDay: true })) });
    if (data.today.length) sections.push({ key: "today", title: "Today", data: data.today.map((o) => ({ o, showDay: false })) });
  } else if (filter === "UPCOMING" && data) {
    sections = byDay(data.upcoming);
    empty = "Nothing coming up this week";
  } else if (filter === "DONE") {
    const rows = board && manage ? board.occurrences.filter((o) => o.status !== "OPEN") : Object.values(finished).sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
    if (rows.length) sections = [{ key: "done", title: "Done today", data: rows.map((o) => ({ o, showDay: !!board && o.dueOn !== board.date })) }];
    empty = counts?.doneToday && !manage ? `${counts.doneToday} done today; nothing finished on this sign-in yet` : "Nothing done yet today";
  } else if (filter === "EVERYONE") {
    if (board) {
      if (board.overdue.length) sections.push({ key: "overdue", title: "Overdue", color: colors.bad, data: board.overdue.map((o) => ({ o, showDay: true })) });
      if (board.occurrences.length) sections.push({ key: "today", title: `Today · ${dayLabel(board.date)}`, data: board.occurrences.map((o) => ({ o, showDay: false })) });
      empty = "No tasks at this store today";
    } else empty = "Loading…";
  }

  const chipDefs: [Filter, string, number | undefined][] = [
    ["TODO", "To do", counts ? counts.open : undefined],
    ["UPCOMING", "Upcoming", data?.upcoming.length || undefined],
    ["DONE", "Done today", doneToday || undefined],
    ...(manage ? ([["EVERYONE", "Everyone", undefined]] as [Filter, string, number | undefined][]) : []),
  ];
  const chips = chipDefs.map(([key, title, n]) => (
    <Pressable key={key} onPress={() => setFilter(key)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: filter === key ? colors.accent : colors.panelAlt }}>
      <Text style={ui.text}>
        {title}
        {n ? ` ${n}` : ""}
      </Text>
    </Pressable>
  ));

  // The open task's latest copy from whichever list it came from, so a poll or a step elsewhere shows through.
  const all = [...(data ? [...data.overdue, ...data.today, ...data.upcoming] : []), ...(board ? [...board.overdue, ...board.occurrences] : []), ...Object.values(finished)];
  const found = selectedId ? all.find((o) => o.id === selectedId) ?? null : null;
  if (found) lastSelected.current = found;
  // A task that left the lists (completed on another register, say) stays open, so the detail can say what happened.
  const selected = found ?? (selectedId && lastSelected.current?.id === selectedId ? lastSelected.current : null);

  const list = (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={[ui.row, { gap: 8 }]}>
        {narrow ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 1 }} contentContainerStyle={{ gap: 6 }}>
            {chips}
          </ScrollView>
        ) : (
          <View style={[ui.row, { flex: 1, flexWrap: "wrap", gap: 6 }]}>{chips}</View>
        )}
        <Pressable onPress={refreshAll} disabled={refreshing} style={{ padding: 10 }}>
          <Text style={{ color: colors.link }}>Refresh</Text>
        </Pressable>
      </View>
      {error && <Text style={ui.error}>{error}</Text>}
      <SectionList
        style={{ flex: 1 }}
        sections={sections}
        keyExtractor={(r) => r.o.id}
        stickySectionHeadersEnabled={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={colors.muted} />}
        ListEmptyComponent={<Text style={[ui.muted, { padding: 16, textAlign: "center" }]}>{empty}</Text>}
        renderSectionHeader={({ section }) => (
          <Text style={[ui.muted, { fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, paddingTop: 10, paddingBottom: 4, paddingHorizontal: 8 }, section.color ? { color: section.color } : null]}>{section.title}</Text>
        )}
        renderItem={({ item: r }) => (
          <TaskRow
            occurrence={r.o}
            showDay={r.showDay}
            meId={staff.id}
            selected={r.o.id === selectedId}
            onPress={() => {
              setSelectedId(r.o.id);
              setShowDetail(true);
            }}
          />
        )}
      />
    </View>
  );

  return (
    <SplitPane
      leftLabel="Tasks"
      rightLabel="Task"
      showRight={showDetail}
      onToggle={setShowDetail}
      left={list}
      right={
        selected ? (
          <TaskDetail key={selected.id} occurrence={selected} onChanged={changed} />
        ) : (
          <Text style={[ui.muted, { textAlign: "center", marginTop: 40 }]}>{selectedId ? "That task isn't in this list any more." : "Pick a task to see its steps."}</Text>
        )
      }
    />
  );
}

function TaskRow({ occurrence: o, showDay, meId, selected, onPress }: { occurrence: TaskOccurrence; showDay: boolean; meId: string; selected: boolean; onPress: () => void }) {
  const n = steps(o);
  const outcome = outcomeLabel(o);
  const due = showDay ? `${dayLabel(o.dueOn)}${o.dueTime ? ` by ${timeLabel(o.dueTime)}` : ""}` : dueLabel(o, "any time");
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${o.title}, ${due}`}
      style={[ui.row, { gap: 10, paddingVertical: 10, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.border, borderRadius: 8, backgroundColor: selected ? colors.panelAlt : "transparent" }]}
    >
      <View style={{ width: 4, alignSelf: "stretch", borderRadius: 2, backgroundColor: priorityColor(o.priority) }} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={[ui.row, { gap: 8 }]}>
          <Text style={[ui.text, { flex: 1, fontWeight: "600" }, o.status !== "OPEN" ? { color: colors.muted } : null]} numberOfLines={1}>
            {o.title}
          </Text>
          {n > 0 && <Text style={[ui.muted, stepsDone(o) === n ? { color: colors.good } : null]}>{`${stepsDone(o)}/${n}`}</Text>}
          <Tag label={assigneeLabel(o, meId)} />
        </View>
        <Text style={ui.muted} numberOfLines={1}>
          {outcome ? (
            <>
              {outcome.text}
              {outcome.late && <Text style={{ color: colors.warn }}> · late</Text>}
            </>
          ) : (
            due
          )}
        </Text>
      </View>
    </Pressable>
  );
}

// ─── Detail ──────────────────────────────────────────────────────

const TICK_DEBOUNCE_MS = 400;

function TaskDetail({ occurrence, onChanged }: { occurrence: TaskOccurrence; onChanged: (o?: TaskOccurrence) => void }) {
  const { staff } = useSession();
  const can = useCan();
  const guard = useGuard();
  const skipLevel = can("TASK_SKIP");
  const manage = can("MANAGE_TASKS") === "ALLOW";
  const pin = skipLevel === "PIN" ? " · PIN" : "";
  const [o, setO] = useState(occurrence);
  const [done, setDone] = useState<Set<number>>(new Set(occurrence.checklistDone));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | "skip">(null);
  /** The server said this task is no longer open (done on another register): nothing more can be done to it from here. */
  const [closed, setClosed] = useState(false);
  const live = useRef(true);
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickSeq = useRef(0);
  /** A tick waiting on its debounce (so Done can send it first) and the last request sent. */
  const pendingTick = useRef<{ send: () => Promise<void> } | null>(null);
  const inFlight = useRef<Promise<void>>(Promise.resolve());

  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const apply = (next: TaskOccurrence) => {
    setO(next);
    setDone(new Set(next.checklistDone));
    setClosed(false);
  };
  // A poll (or another register) changed this task: show the newer copy unless a tick of ours is still on its way.
  useEffect(() => {
    if (occurrence === o || pendingTick.current || tickTimer.current) return;
    if (occurrence.status !== o.status || occurrence.checklistDone.join() !== o.checklistDone.join() || occurrence.note !== o.note) apply(occurrence);
    else setO(occurrence);
  }, [occurrence]);

  /** Completed elsewhere: refresh the lists (the detail stays up, with the message) and take the buttons away. */
  const notOpen = (e: unknown) => {
    if (!(e instanceof ApiError && e.code === "TASK_NOT_OPEN")) return;
    if (live.current) setClosed(true);
    onChanged();
  };
  const fail = (e: unknown) => {
    if (!live.current) return;
    notOpen(e);
    setError(taskError(e, o, staff.id));
  };

  /** Sends the ticked set; shared by the debounce timer and flushTick(). */
  const sendTick = async (next: Set<number>, seq: number, before: number[]) => {
    try {
      const r = await api<{ occurrence: TaskOccurrence }>("POST", `/tasks/occurrences/${o.id}/checklist`, { done: [...next].sort((a, b) => a - b) });
      if (!live.current || seq !== tickSeq.current) return;
      setO(r.occurrence);
      setDone(new Set(r.occurrence.checklistDone ?? [...next]));
      onChanged();
    } catch (e) {
      if (!live.current || seq !== tickSeq.current) return;
      setDone(new Set(before));
      fail(e);
    }
  };

  /** Send a tick that is still waiting on its debounce, and wait for any tick in flight. */
  const flushTick = async () => {
    const waiting = pendingTick.current;
    if (waiting) {
      if (tickTimer.current) clearTimeout(tickTimer.current);
      tickTimer.current = null;
      pendingTick.current = null;
      await waiting.send();
    }
    await inFlight.current;
  };

  /** Tick a step: shown at once, sent after a short pause so a run of taps is one request. */
  function toggle(i: number) {
    const next = new Set(done);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setDone(next);
    setError(null);
    if (tickTimer.current) clearTimeout(tickTimer.current);
    const seq = ++tickSeq.current;
    const before = o.checklistDone;
    const send = () => {
      pendingTick.current = null;
      const p = sendTick(next, seq, before);
      inFlight.current = p;
      return p;
    };
    pendingTick.current = { send };
    tickTimer.current = setTimeout(() => {
      tickTimer.current = null;
      void send();
    }, TICK_DEBOUNCE_MS);
  }

  /** One step of the task. Throws so a sheet can show the error; undefined if the PIN prompt was cancelled. */
  const run = async (name: string, fn: () => Promise<{ occurrence: TaskOccurrence } | undefined>, doneNotice: string) => {
    await flushTick();
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      if (!r) return false;
      if (live.current) {
        apply(r.occurrence);
        setNotice(doneNotice);
      }
      onChanged(r.occurrence);
      return true;
    } finally {
      if (live.current) setBusy(null);
    }
  };
  const press = (name: string, fn: () => Promise<{ occurrence: TaskOccurrence } | undefined>, doneNotice: string) => run(name, fn, doneNotice).catch(fail);

  const complete = () =>
    press("done", () => api("POST", `/tasks/occurrences/${o.id}/complete`, { note: note.trim() || undefined, checklistDone: o.checklist.map((_, i) => i) }), "Done");
  const skip = (reason: string) =>
    run("skip", () => guard("TASK_SKIP", (approvalToken) => api("POST", `/tasks/occurrences/${o.id}/skip`, { reason }, { approvalToken })), "Skipped").catch((e) => {
      notOpen(e);
      throw new Error(taskError(e, o, staff.id));
    });
  const reopen = () => press("reopen", () => api("POST", `/tasks/occurrences/${o.id}/reopen`), "Reopened");

  const n = steps(o);
  const ticked = stepsDone(o, done);
  const outcome = outcomeLabel(o);
  const open = o.status === "OPEN" && !closed;
  const needsNote = o.requireNote && note.trim() === "";
  const isOverdue = open && new Date(o.dueAt).getTime() < Date.now();

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 4 }}>
          <View style={[ui.row, { gap: 8, alignItems: "flex-start" }]}>
            <View style={{ width: 4, alignSelf: "stretch", borderRadius: 2, backgroundColor: priorityColor(o.priority) }} />
            <Text style={[ui.h1, { flex: 1 }]}>{o.title}</Text>
          </View>
          <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
            <Tag label={priorityLabel(o.priority)} color={o.priority === "HIGH" ? colors.bad : undefined} />
            <Tag label={`For: ${assigneeLabel(o, staff.id)}`} />
          </View>
        </View>

        {!!o.instructions && <Text style={ui.text}>{o.instructions}</Text>}

        <View style={{ gap: 2 }}>
          <Text style={[ui.text, isOverdue ? { color: colors.bad, fontWeight: "600" } : null]}>
            Due {dayLabel(o.dueOn)}
            {o.dueTime ? ` by ${timeLabel(o.dueTime)}` : ", any time"}
            {isOverdue ? " · overdue" : ""}
          </Text>
          <Text style={ui.muted}>Repeats: {repeatsLabel(o)}</Text>
        </View>

        {outcome && (
          <View style={{ backgroundColor: colors.panelAlt, borderLeftWidth: 3, borderLeftColor: o.status === "DONE" ? colors.good : colors.warn, borderRadius: 8, padding: 10, gap: 2 }}>
            <Text style={[ui.text, { fontWeight: "600", color: o.status === "DONE" ? colors.good : colors.warn }]}>
              {outcome.text}
              {outcome.late && <Text style={{ color: colors.warn }}> · late</Text>}
            </Text>
            {o.status === "DONE" && o.completedAt && <Text style={ui.muted}>{dayLabel(localDayOf(o.completedAt))}</Text>}
            {!!o.note && <Text style={ui.text}>Note: {o.note}</Text>}
            {!!o.skipReason && <Text style={ui.text}>Reason: {o.skipReason}</Text>}
          </View>
        )}

        {n > 0 && (
          <View>
            <View style={[ui.row, { justifyContent: "space-between", gap: 8 }]}>
              <Text style={ui.h2}>Steps</Text>
              <Text style={[ui.muted, ticked === n ? { color: colors.good } : null]}>
                {ticked} of {n} done
              </Text>
            </View>
            {o.checklist.map((label, i) => (
              <Step key={i} label={label} checked={done.has(i)} enabled={open} onToggle={() => toggle(i)} />
            ))}
          </View>
        )}

        {open && (
          <TextInput
            style={ui.input}
            value={note}
            onChangeText={setNote}
            placeholder={o.requireNote ? "Note (required)" : "Note (optional)"}
            placeholderTextColor={colors.muted}
            multiline
          />
        )}

        {notice && <Text style={[ui.text, { color: colors.good }]}>{notice}</Text>}
        {error && <Text style={ui.error}>{error}</Text>}

        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          {open && <Button title="Done" kind="good" disabled={needsNote} busy={busy === "done"} onPress={complete} style={{ flexGrow: 1 }} />}
          {open && <Button title={`Skip…${pin}`} kind="secondary" disabled={skipLevel === "DENY"} busy={busy === "skip"} onPress={() => setSheet("skip")} style={{ flexGrow: 1 }} />}
          {o.status !== "OPEN" && manage && <Button title="Reopen" kind="secondary" busy={busy === "reopen"} onPress={reopen} style={{ flexGrow: 1 }} />}
        </View>
      </ScrollView>

      {sheet === "skip" && (
        <SkipSheet
          title={`Skip "${o.title}"`}
          message={`Why is this task being skipped today?${pin ? " Needs a manager's PIN." : ""}`}
          confirmLabel={`Skip${pin}`}
          onSubmit={skip}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}

function Step({ label, checked, enabled, onToggle }: { label: string; checked: boolean; enabled: boolean; onToggle: () => void }) {
  return (
    <Pressable
      onPress={onToggle}
      disabled={!enabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !enabled }}
      style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", gap: 10 }}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 7,
          borderWidth: 2,
          borderColor: checked ? colors.good : enabled ? colors.muted : colors.border,
          backgroundColor: checked ? colors.good : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Text style={{ color: "#ffffff", fontSize: 18, fontWeight: "700" }}>✓</Text>}
      </View>
      <Text style={[ui.text, { flex: 1 }, checked ? { color: colors.muted, textDecorationLine: "line-through" } : null]} numberOfLines={3}>
        {label}
      </Text>
    </Pressable>
  );
}

// ─── Sheets ──────────────────────────────────────────────────────

function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const { dialog } = useLayout();
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center" }}>
        <ScrollView style={[ui.panel, { width: dialog(460), maxHeight: "90%", flexGrow: 0 }]} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
          <Text style={ui.h1}>{title}</Text>
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** A reason, then "Skip"; the PIN pad comes up in between for cashiers. Stays open if the PIN is cancelled. */
function SkipSheet(props: { title: string; message: string; confirmLabel: string; onSubmit: (reason: string) => Promise<boolean>; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (await props.onSubmit(reason.trim())) props.onClose();
    } catch (e) {
      setError(e instanceof NotPermitted || e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={props.title} onClose={props.onClose}>
      <Text style={ui.muted}>{props.message}</Text>
      <TextInput style={ui.input} value={reason} onChangeText={setReason} placeholder="Reason" placeholderTextColor={colors.muted} autoFocus multiline />
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8 }]}>
        <Button title="Cancel" kind="secondary" onPress={props.onClose} disabled={busy} />
        <Button title={props.confirmLabel} kind="danger" onPress={submit} busy={busy} disabled={reason.trim() === ""} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}
