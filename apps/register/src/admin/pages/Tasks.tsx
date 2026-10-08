import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { api, ApiError, getToken } from "../../api";
import { NotPermitted, useGuard } from "../../approval";
import { Button } from "../../components/Button";
import { useCan, useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Badge, Card, Chips, DateRangePicker, downloadCsv, Field, Input, Picker, PRESETS, Table, when, type Column, type DateRange } from "../ui";
import { KeyValues } from "./Reports";

type Priority = "LOW" | "NORMAL" | "HIGH";
type Recurrence = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";
type Status = "OPEN" | "DONE" | "SKIPPED";
type AssigneeType = "ANYONE" | "ROLE" | "EMPLOYEE";
type Role = "OWNER" | "MANAGER" | "CASHIER";

/** One day's instance of a task, as every /tasks/occurrences endpoint returns it. */
interface Occ {
  id: string;
  taskId: string;
  locationId: string;
  title: string;
  instructions: string | null;
  checklist: string[];
  checklistDone: number[];
  priority: Priority;
  recurrence: Recurrence;
  requireNote: boolean;
  dueOn: string;
  dueAt: string;
  dueTime: string | null;
  status: Status;
  assignee: { type: AssigneeType; role?: Role | null; employee?: { id: string; name: string } | null };
  completedBy: { id: string; name: string } | null;
  completedAt: string | null;
  late: boolean;
  note: string | null;
  skipReason: string | null;
}
/** A task definition from GET /tasks. */
interface TaskDef {
  id: string;
  locationId: string | null;
  title: string;
  instructions: string | null;
  checklist: string[];
  priority: Priority;
  recurrence: Recurrence;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  dueTime: string | null;
  startsOn: string;
  endsOn: string | null;
  assigneeType: AssigneeType;
  assigneeRole: Role | null;
  assigneeId: string | null;
  requireNote: boolean;
  active: boolean;
  nextDueOn: string | null;
  location?: { id: string; name: string } | null;
  assignee?: { id: string; name: string } | null;
}
interface Board {
  date: string;
  occurrences: Occ[];
  overdue: Occ[];
}
interface Report {
  byTask: { taskId: string; title: string; recurrence: Recurrence; due: number; done: number; late: number; skipped: number; missed: number; completionRate: number }[];
  byEmployee: { staffId: string; name: string; done: number; late: number; skipped: number }[];
  totals: { due: number; done: number; late: number; skipped: number; missed: number; completionRate: number };
}
interface Store {
  id: string;
  name: string;
}
/** Someone a task can be for: from the employee list when it could be loaded, else a name seen on a task (then `active` is unknown). */
interface Person {
  id: string;
  name: string;
  active?: boolean;
}
type Named = { id: string; name: string } | null | undefined;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RECURRENCE: [Recurrence, string][] = [["ONCE", "One time"], ["DAILY", "Every day"], ["WEEKLY", "Weekly"], ["MONTHLY", "Monthly"]];
const PRIORITY: [Priority, string][] = [["LOW", "Low"], ["NORMAL", "Normal"], ["HIGH", "High"]];
const ASSIGN: [string, string][] = [["ANYONE", "Anyone"], ["OWNER", "Owners"], ["MANAGER", "Managers"], ["CASHIER", "Cashiers"], ["EMPLOYEE", "A specific employee"]];
const ROLE_WORD: Record<Role, string> = { OWNER: "Owners", MANAGER: "Managers", CASHIER: "Cashiers" };
const isRole = (s: string): s is Role => s in ROLE_WORD;
const PEOPLE_NOTE = "Your account can't list every employee; only people already on tasks are offered.";
const MAX_STEPS = 30;

const pad = (n: number) => String(n).padStart(2, "0");
/** Local "YYYY-MM-DD" (an ISO slice would give the UTC day). */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime());
const shiftDay = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};
/** "Oct 12" from "2026-10-12". */
const shortDay = (s: string | null | undefined) => {
  if (!s || !isDay(s)) return "—";
  const [, m, d] = s.split("-").map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}`;
};
/** "10:30 AM" from "10:30"; "End of day" when there is no time. */
const clockOf = (t: string | null | undefined) => {
  if (!t) return "End of day";
  const [h, m] = t.split(":").map(Number) as [number, number];
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10]}`;
const forText = (a: Occ["assignee"]) => (a.type === "ROLE" && a.role ? ROLE_WORD[a.role] : a.type === "EMPLOYEE" ? (a.employee?.name ?? "An employee") : "Anyone");
const taskFor = (t: TaskDef) => forText({ type: t.assigneeType, role: t.assigneeRole, employee: t.assignee });
/** "Every day", "Weekly · Mon, Thu", "Monthly · 15th", "One time · Oct 12". */
function repeatsText(t: Pick<TaskDef, "recurrence" | "daysOfWeek" | "dayOfMonth" | "startsOn">): string {
  switch (t.recurrence) {
    case "DAILY":
      return "Every day";
    case "WEEKLY":
      return `Weekly · ${[...t.daysOfWeek].sort((a, b) => a - b).map((d) => DAY_NAMES[d] ?? "").filter(Boolean).join(", ") || "no days"}`;
    case "MONTHLY":
      return `Monthly · ${t.dayOfMonth === 31 ? "last day" : t.dayOfMonth ? ordinal(t.dayOfMonth) : "—"}`;
    default:
      return `One time · ${shortDay(t.startsOn)}`;
  }
}
const steps = (o: Occ) => (o.checklist.length ? `${Math.min(o.checklistDone.length, o.checklist.length)}/${o.checklist.length}` : "—");
const message = (e: unknown) => (e instanceof ApiError || e instanceof NotPermitted ? e.message : String(e));
/**
 * The inclusive days of a range whose `to` is the following midnight. The
 * presets step by 24 hours, so across a DST change a bound can sit an hour
 * off midnight; the day is read at noon so it never slips to the wrong one.
 */
const rangeDays = (r: DateRange) => {
  const noonDay = (d: Date) => localDay(new Date(d.getTime() + 12 * 3_600_000));
  return { from: noonDay(r.from), to: shiftDay(noonDay(r.to), -1) };
};

/** Download rows built here as a CSV file (browser only); fields are quoted. */
function saveCsv(name: string, header: string[], rows: (string | number | null | undefined)[][]) {
  if (Platform.OS !== "web") return;
  const cell = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const text = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function TitleCell({ o }: { o: Pick<Occ, "title" | "priority"> }) {
  return (
    <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
      <Text style={ui.text}>{o.title}</Text>
      {o.priority === "HIGH" && <Badge text="HIGH" tone="bad" />}
    </View>
  );
}

function StatusCell({ o }: { o: Occ }) {
  if (o.status === "DONE") {
    return (
      <View style={{ gap: 2 }}>
        <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
          <Badge text="Done" tone="good" />
          {o.late && <Badge text="late" tone="warn" />}
        </View>
        <Text style={ui.muted}>
          by {o.completedBy?.name ?? "—"}
          {o.completedAt ? ` at ${timeOf(o.completedAt)}` : ""}
        </Text>
      </View>
    );
  }
  if (o.status === "SKIPPED") {
    return (
      <View style={{ gap: 2 }}>
        <Badge text="Skipped" tone="warn" />
        {o.skipReason ? <Text style={ui.muted}>{o.skipReason}</Text> : null}
      </View>
    );
  }
  return <Badge text="Open" tone="muted" />;
}

/** Everything about employee tasks: today's board, the definitions, the history and the completion report. */
export function TasksPage() {
  const can = useCan();
  const [view, setView] = useState<"today" | "tasks" | "history" | "report">("today");
  const [stores, setStores] = useState<Store[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  /** Whether the employee list came from the server; otherwise it is only the names seen on tasks. */
  const [listed, setListed] = useState(true);
  /** Add people seen on tasks (assignees, who completed them), so the pickers can name them even without the full list. */
  const learn = useCallback((found: (Person | Named)[]) => {
    setPeople((prev) => {
      const next = [...prev];
      let changed = false;
      for (const p of found) {
        if (!p?.id || !p.name) continue;
        const active = "active" in p ? Boolean(p.active) : undefined;
        const i = next.findIndex((x) => x.id === p.id);
        if (i < 0) next.push({ id: p.id, name: p.name, ...(active === undefined ? {} : { active }) });
        else if (active !== undefined && next[i]!.active === undefined) next[i] = { ...next[i]!, active };
        else continue;
        changed = true;
      }
      return changed ? next.sort((a, b) => a.name.localeCompare(b.name)) : prev;
    });
  }, []);
  useEffect(() => {
    api<Store[]>("GET", "/locations")
      .then((l) => setStores(l.map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => undefined);
    // Managing tasks doesn't need the staff pages: /tasks/assignees lists the active employees; /staff is for those who may see it.
    api<{ employees: Person[] }>("GET", "/tasks/assignees")
      .then((r) => r.employees.map((p) => ({ ...p, active: true })))
      .catch(() => (can("MANAGE_STAFF") === "DENY" ? Promise.reject(new Error("no employee list")) : api<Person[]>("GET", "/staff")))
      .then(learn)
      .catch(() => setListed(false));
  }, []);

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Chips options={[["today", "Today"], ["tasks", "Tasks"], ["history", "History"], ["report", "Report"]]} value={view} onChange={(v) => setView(v as never)} />
      {view === "today" && <TodayBoard />}
      {view === "tasks" && <Definitions stores={stores} people={people} listed={listed} learn={learn} />}
      {view === "history" && <History stores={stores} people={people} listed={listed} learn={learn} />}
      {view === "report" && <ReportView stores={stores} />}
    </ScrollView>
  );
}

// ── Today ────────────────────────────────────────────────────────

/** What is pending in the actions column: a note before completing, or a reason before skipping. */
interface Pending {
  id: string;
  kind: "complete" | "skip";
  text: string;
}

function TodayBoard() {
  const { location } = useSession();
  const guard = useGuard();
  /** The day asked for; "" means the store's today, which the API resolves (the browser's calendar day may differ from the store's). */
  const [date, setDate] = useState("");
  const [today, setToday] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [tick, setTick] = useState(0);
  const shown = date || today;

  useEffect(() => {
    if (date && !isDay(date)) return;
    let live = true;
    setError(null);
    api<Board>("GET", `/tasks/board?locationId=${location.id}${date ? `&date=${date}` : ""}`)
      .then((b) => {
        if (!live) return;
        setBoard(b);
        if (!date) setToday(b.date);
      })
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [location.id, date, tick]);

  const refresh = () => setTick((t) => t + 1);
  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      if ((await fn()) !== undefined) {
        setPending(null);
        refresh();
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };
  const complete = (o: Occ, note?: string) => run(o.id, () => api("POST", `/tasks/occurrences/${o.id}/complete`, note ? { note } : {}));
  const skip = (o: Occ, reason: string) => run(o.id, () => guard("TASK_SKIP", (token) => api("POST", `/tasks/occurrences/${o.id}/skip`, { reason }, { approvalToken: token })));
  const reopen = (o: Occ) => run(o.id, () => api("POST", `/tasks/occurrences/${o.id}/reopen`));

  const actions = (o: Occ) => {
    const small = { minHeight: 34, paddingVertical: 4, paddingHorizontal: 12 };
    if (pending?.id === o.id) {
      const isSkip = pending.kind === "skip";
      return (
        <View style={{ gap: 6 }}>
          <Input value={pending.text} onChange={(text) => setPending({ ...pending, text })} placeholder={isSkip ? "Why is it being skipped?" : "Note (required)"} />
          <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
            <Button title={isSkip ? "Confirm skip" : "Complete"} kind={isSkip ? "danger" : "good"} style={small} busy={busy === o.id} disabled={!pending.text.trim() || !!busy} onPress={() => (isSkip ? skip(o, pending.text.trim()) : complete(o, pending.text.trim()))} />
            <Button title="Cancel" kind="secondary" style={small} onPress={() => setPending(null)} />
          </View>
        </View>
      );
    }
    if (o.status === "OPEN") {
      return (
        <View style={[ui.row, { gap: 6, flexWrap: "wrap" }]}>
          <Button title="Complete" kind="good" style={small} busy={busy === o.id} disabled={!!busy} onPress={() => (o.requireNote ? setPending({ id: o.id, kind: "complete", text: "" }) : complete(o))} />
          <Button title="Skip" kind="secondary" style={small} disabled={!!busy} onPress={() => setPending({ id: o.id, kind: "skip", text: "" })} />
        </View>
      );
    }
    return <Button title="Reopen" kind="secondary" style={small} busy={busy === o.id} disabled={!!busy} onPress={() => reopen(o)} />;
  };
  const columns: Column<Occ>[] = [
    { key: "t", label: "Task", render: (o) => <TitleCell o={o} />, width: 220 },
    { key: "d", label: "Due by", render: (o) => clockOf(o.dueTime), width: 100 },
    { key: "f", label: "For", render: (o) => forText(o.assignee), width: 120 },
    { key: "c", label: "Steps", render: (o) => steps(o), width: 60, align: "right" },
    { key: "s", label: "Status", render: (o) => <StatusCell o={o} />, width: 200 },
    { key: "a", label: "Actions", render: (o) => actions(o), width: 260 },
  ];
  const overdueColumns: Column<Occ>[] = [{ key: "o", label: "Was due", render: (o) => `${shortDay(o.dueOn)} · ${clockOf(o.dueTime)}`, width: 150 }, ...columns.filter((c) => c.key !== "d")];
  const rows = board?.occurrences ?? [];
  const counts = { open: rows.filter((o) => o.status === "OPEN").length, done: rows.filter((o) => o.status === "DONE").length, skipped: rows.filter((o) => o.status === "SKIPPED").length };
  const nav = { minHeight: 36, paddingVertical: 6, paddingHorizontal: 12 };

  return (
    <>
      <Card title={`Tasks at ${location.name}`}>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button title="◀" kind="secondary" style={nav} onPress={() => isDay(shown) && setDate(shiftDay(shown, -1))} />
          <Button title="Today" kind={shown === today ? "primary" : "secondary"} style={nav} onPress={() => setDate("")} />
          <Button title="▶" kind="secondary" style={nav} onPress={() => isDay(shown) && setDate(shiftDay(shown, 1))} />
          <View style={{ width: 150 }}>
            <Input value={shown} onChange={setDate} placeholder="YYYY-MM-DD" />
          </View>
          <Text style={ui.muted}>{isDay(shown) ? new Date(`${shown}T00:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) : shown ? "Enter a date as YYYY-MM-DD" : "Loading…"}</Text>
        </View>
        {error && <Text style={ui.error}>{error}</Text>}
      </Card>
      {board && board.overdue.length > 0 && (
        <Card title={`Overdue (${board.overdue.length})`}>
          <Text style={ui.muted}>Still open from earlier days.</Text>
          <Table<Occ> rows={board.overdue} keyOf={(o) => o.id} columns={overdueColumns} />
        </Card>
      )}
      <Card title={shown === today ? "Today" : shortDay(shown)}>
        <Text style={ui.muted}>{`${counts.open} open · ${counts.done} done · ${counts.skipped} skipped`}</Text>
        <Table<Occ> rows={rows} keyOf={(o) => o.id} columns={columns} empty={board ? "No tasks fall on this day." : "Loading…"} />
      </Card>
    </>
  );
}

// ── Tasks (definitions) ──────────────────────────────────────────

function Definitions({ stores, people, listed, learn }: { stores: Store[]; people: Person[]; listed: boolean; learn: (found: Named[]) => void }) {
  const { location } = useSession();
  const [active, setActive] = useState<"true" | "false">("true");
  const [recurrence, setRecurrence] = useState("");
  const [store, setStore] = useState(location.id);
  const [tasks, setTasks] = useState<TaskDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskDef | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    const q = new URLSearchParams({ active, ...(store ? { locationId: store } : {}), ...(recurrence ? { recurrence } : {}) });
    api<{ tasks: TaskDef[] }>("GET", `/tasks?${q}`)
      .then((r) => {
        if (!live) return;
        setTasks(r.tasks);
        learn(r.tasks.map((t) => t.assignee));
      })
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [active, recurrence, store, tick]);

  const columns: Column<TaskDef>[] = [
    { key: "t", label: "Title", render: (t) => <TitleCell o={t} />, width: 220 },
    { key: "r", label: "Repeats", render: (t) => repeatsText(t), width: 170 },
    { key: "d", label: "Due by", render: (t) => clockOf(t.dueTime), width: 100 },
    { key: "f", label: "For", render: (t) => taskFor(t), width: 120 },
    { key: "s", label: "Store", render: (t) => (t.locationId ? (t.location?.name ?? stores.find((s) => s.id === t.locationId)?.name ?? "Store") : "Every store"), width: 130 },
    { key: "n", label: "Next due", render: (t) => shortDay(t.nextDueOn), width: 90 },
    { key: "p", label: "Priority", render: (t) => (PRIORITY.find(([k]) => k === t.priority)?.[1] ?? t.priority), width: 80 },
    { key: "a", label: "Active", render: (t) => <Badge text={t.active ? "Active" : "Inactive"} tone={t.active ? "good" : "muted"} />, width: 80 },
  ];

  return (
    <>
      <Card title="Tasks" right={<Button title="New task" kind="good" style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => setEditing("new")} />}>
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
          <Chips options={[["true", "Active"], ["false", "Inactive"]]} value={active} onChange={(v) => setActive(v as never)} />
          <Picker label="Repeats" options={RECURRENCE} value={recurrence} onChange={setRecurrence} noneLabel="Any" />
          <Picker label="Store" options={stores.map((s) => [s.id, s.name])} value={store} onChange={setStore} noneLabel="Every store" />
        </View>
        {error && <Text style={ui.error}>{error}</Text>}
        {notice && <Text style={ui.text}>{notice}</Text>}
        <Text style={ui.muted}>Tap a task to edit it.</Text>
        <Table<TaskDef> rows={tasks ?? []} keyOf={(t) => t.id} columns={columns} onPress={(t) => setEditing(t)} empty={tasks ? "No tasks match." : "Loading…"} />
      </Card>
      {editing && (
        <TaskEditor
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? undefined : editing}
          stores={stores}
          people={people}
          listed={listed}
          onCancel={() => setEditing(null)}
          onDone={(m) => {
            setEditing(null);
            setNotice(m);
            setTick((t) => t + 1);
          }}
        />
      )}
    </>
  );
}

interface Form {
  title: string;
  instructions: string;
  checklist: string[];
  priority: Priority;
  recurrence: Recurrence;
  daysOfWeek: number[];
  dayOfMonth: string;
  dueTime: string;
  startsOn: string;
  endsOn: string;
  locationId: string;
  assign: string;
  assigneeId: string;
  requireNote: boolean;
}

function formOf(t: TaskDef | undefined, locationId: string): Form {
  return {
    title: t?.title ?? "",
    instructions: t?.instructions ?? "",
    checklist: t?.checklist ?? [],
    priority: t?.priority ?? "NORMAL",
    recurrence: t?.recurrence ?? "DAILY",
    daysOfWeek: t?.daysOfWeek ?? [new Date().getDay()],
    dayOfMonth: t?.dayOfMonth ? String(t.dayOfMonth) : "1",
    dueTime: t?.dueTime ?? "",
    startsOn: t?.startsOn ?? localDay(new Date()),
    endsOn: t?.endsOn ?? "",
    locationId: t ? (t.locationId ?? "") : locationId,
    assign: t ? (t.assigneeType === "ROLE" ? (t.assigneeRole ?? "MANAGER") : t.assigneeType) : "ANYONE",
    assigneeId: t?.assigneeId ?? "",
    requireNote: t?.requireNote ?? false,
  };
}

/** Create or edit a task: words, checklist, schedule, where, who, and whether a note is needed. */
function TaskEditor({ initial, stores, people, listed, onDone, onCancel }: { initial?: TaskDef; stores: Store[]; people: Person[]; listed: boolean; onDone: (message: string) => void; onCancel: () => void }) {
  const { location } = useSession();
  const [f, setF] = useState<Form>(() => formOf(initial, location.id));
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const setStep = (i: number, text: string) => set({ checklist: f.checklist.map((s, j) => (j === i ? text : s)) });
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= f.checklist.length) return;
    const next = [...f.checklist];
    [next[i], next[j]] = [next[j]!, next[i]!];
    set({ checklist: next });
  };
  const toggleDay = (d: number) => set({ daysOfWeek: f.daysOfWeek.includes(d) ? f.daysOfWeek.filter((x) => x !== d) : [...f.daysOfWeek, d] });
  const employees = people.filter((p) => p.active !== false || p.id === initial?.assigneeId).map((p) => [p.id, p.name] as [string, string]);

  const problem = (): string | null => {
    if (!f.title.trim()) return "Give the task a title";
    if (f.checklist.some((s) => !s.trim())) return "Every checklist step needs some words (or remove it)";
    if (f.recurrence === "WEEKLY" && f.daysOfWeek.length === 0) return "Pick at least one day of the week";
    const dom = Number(f.dayOfMonth);
    if (f.recurrence === "MONTHLY" && (!Number.isInteger(dom) || dom < 1 || dom > 31)) return "Day of month is 1 to 31";
    if (f.dueTime.trim() && !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.dueTime.trim())) return "Due by is HH:mm (24-hour), or blank for the end of the day";
    if (!isDay(f.startsOn)) return "Starts on must be YYYY-MM-DD";
    if (f.recurrence !== "ONCE" && f.endsOn.trim() && !isDay(f.endsOn.trim())) return "Ends on must be YYYY-MM-DD, or blank";
    if (f.assign === "EMPLOYEE" && !f.assigneeId) return "Pick the employee this task is for";
    return null;
  };
  const body = () => ({
    locationId: f.locationId || null,
    title: f.title.trim(),
    instructions: f.instructions.trim() || null,
    checklist: f.checklist.map((s) => s.trim()),
    priority: f.priority,
    recurrence: f.recurrence,
    daysOfWeek: f.recurrence === "WEEKLY" ? [...f.daysOfWeek].sort((a, b) => a - b) : [],
    dayOfMonth: f.recurrence === "MONTHLY" ? Number(f.dayOfMonth) : null,
    dueTime: f.dueTime.trim() || null,
    startsOn: f.startsOn.trim(),
    endsOn: f.recurrence === "ONCE" ? null : f.endsOn.trim() || null,
    assigneeType: (f.assign === "EMPLOYEE" ? "EMPLOYEE" : f.assign === "ANYONE" ? "ANYONE" : "ROLE") as AssigneeType,
    assigneeRole: isRole(f.assign) ? f.assign : null,
    assigneeId: f.assign === "EMPLOYEE" ? f.assigneeId : null,
    requireNote: f.requireNote,
  });
  const run = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      onDone(done);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };
  const save = () => {
    const p = problem();
    if (p) return setError(p);
    return run("save", () => (initial ? api("PATCH", `/tasks/${initial.id}`, body()) : api("POST", "/tasks", body())), initial ? `Saved "${f.title.trim()}".` : `Created "${f.title.trim()}".`);
  };
  const deactivate = () => run("delete", () => api("DELETE", `/tasks/${initial!.id}`), `Deactivated "${initial!.title}".`);

  const small = { minHeight: 34, paddingVertical: 4, paddingHorizontal: 10 };
  return (
    <Card title={initial ? `Edit "${initial.title}"` : "New task"} right={<Button title="Cancel" kind="secondary" style={{ minHeight: 36, paddingVertical: 6 }} onPress={onCancel} />}>
      <Field label="Title">
        <Input value={f.title} onChange={(title) => set({ title })} placeholder="e.g. Opening checklist" />
      </Field>
      <Field label="Instructions">
        <Input value={f.instructions} onChange={(instructions) => set({ instructions })} placeholder="What to do, in a few lines" multiline />
      </Field>
      <View style={{ gap: 6 }}>
        <Text style={ui.muted}>Checklist</Text>
        {f.checklist.map((s, i) => (
          <View key={i} style={[ui.row, { gap: 6 }]}>
            <Text style={[ui.muted, { width: 22, textAlign: "right" }]}>{i + 1}.</Text>
            <View style={{ flex: 1 }}>
              <Input value={s} onChange={(text) => setStep(i, text)} placeholder="A step" />
            </View>
            <Pressable onPress={() => moveStep(i, -1)} disabled={i === 0} accessibilityRole="button" accessibilityLabel={`Move step ${i + 1} up`} style={{ padding: 6, opacity: i === 0 ? 0.3 : 1 }}>
              <Text style={ui.text}>▲</Text>
            </Pressable>
            <Pressable onPress={() => moveStep(i, 1)} disabled={i === f.checklist.length - 1} accessibilityRole="button" accessibilityLabel={`Move step ${i + 1} down`} style={{ padding: 6, opacity: i === f.checklist.length - 1 ? 0.3 : 1 }}>
              <Text style={ui.text}>▼</Text>
            </Pressable>
            <Pressable onPress={() => set({ checklist: f.checklist.filter((_, j) => j !== i) })} accessibilityRole="button" accessibilityLabel={`Remove step ${i + 1}`} style={{ padding: 6 }}>
              <Text style={[ui.text, { color: colors.bad }]}>✕</Text>
            </Pressable>
          </View>
        ))}
        <View style={[ui.row, { gap: 8 }]}>
          <Button title="Add step" kind="secondary" style={small} disabled={f.checklist.length >= MAX_STEPS} onPress={() => set({ checklist: [...f.checklist, ""] })} />
          {f.checklist.length >= MAX_STEPS && <Text style={ui.muted}>At most {MAX_STEPS} steps.</Text>}
        </View>
      </View>
      <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
        <Picker label="Priority" options={PRIORITY} value={f.priority} onChange={(priority) => set({ priority: priority as Priority })} allowNone={false} />
        <Picker label="Repeats" options={RECURRENCE} value={f.recurrence} onChange={(recurrence) => set({ recurrence: recurrence as Recurrence })} allowNone={false} />
        <Field label="Due by (HH:mm, blank = end of the day)">
          <Input value={f.dueTime} onChange={(dueTime) => set({ dueTime })} placeholder="e.g. 10:30" />
        </Field>
      </View>
      {f.recurrence === "WEEKLY" && (
        <View style={{ gap: 4 }}>
          <Text style={ui.muted}>On these days</Text>
          <View style={[ui.row, { flexWrap: "wrap", gap: 6 }]}>
            {DAY_NAMES.map((name, d) => (
              <Pressable key={name} onPress={() => toggleDay(d)} accessibilityRole="button" accessibilityState={{ selected: f.daysOfWeek.includes(d) }} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, backgroundColor: f.daysOfWeek.includes(d) ? colors.accent : colors.panelAlt }}>
                <Text style={ui.text}>{name}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {f.recurrence === "MONTHLY" && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
          <View style={{ width: 140 }}>
            <Field label="Day of month">
              <Input value={f.dayOfMonth} onChange={(dayOfMonth) => set({ dayOfMonth })} keyboard="number-pad" placeholder="1–31" />
            </Field>
          </View>
          <Text style={[ui.muted, { paddingBottom: 12 }]}>31 counts as the last day of shorter months.</Text>
        </View>
      )}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
        <Field label={f.recurrence === "ONCE" ? "On (YYYY-MM-DD)" : "Starts on (YYYY-MM-DD)"}>
          <Input value={f.startsOn} onChange={(startsOn) => set({ startsOn })} placeholder="2026-10-08" />
        </Field>
        {f.recurrence !== "ONCE" && (
          <Field label="Ends on (blank = no end)">
            <Input value={f.endsOn} onChange={(endsOn) => set({ endsOn })} placeholder="YYYY-MM-DD" />
          </Field>
        )}
      </View>
      <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
        <Picker label="Store" options={stores.map((s) => [s.id, s.name])} value={f.locationId} onChange={(locationId) => set({ locationId })} noneLabel="Every store" />
        <Picker label="Assign to" options={ASSIGN} value={f.assign} onChange={(assign) => set({ assign })} allowNone={false} />
        {f.assign === "EMPLOYEE" && <Picker label="Employee" options={employees} value={f.assigneeId} onChange={(assigneeId) => set({ assigneeId })} allowNone={false} placeholder="Pick an employee" />}
      </View>
      {f.assign === "EMPLOYEE" && !listed && <Text style={ui.muted}>{PEOPLE_NOTE}</Text>}
      <View style={[ui.row, { gap: 10 }]}>
        <Switch value={f.requireNote} onValueChange={(requireNote) => set({ requireNote })} />
        <Text style={ui.text}>Needs a note to complete</Text>
      </View>
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button title={initial ? "Save" : "Create task"} kind="good" onPress={save} busy={busy === "save"} disabled={!!busy} />
        {initial?.active && (confirm ? <Button title="Really deactivate" kind="danger" onPress={deactivate} busy={busy === "delete"} disabled={!!busy} /> : <Button title="Deactivate" kind="danger" onPress={() => setConfirm(true)} disabled={!!busy} />)}
      </View>
      <Text style={ui.muted}>Changing the schedule, store or assignee recreates upcoming instances; completed history is kept.</Text>
    </Card>
  );
}

// ── History ──────────────────────────────────────────────────────

const STATUS_OPTIONS: [string, string][] = [["OPEN", "Open"], ["DONE", "Done"], ["SKIPPED", "Skipped"]];

function History({ stores, people, listed, learn }: { stores: Store[]; people: Person[]; listed: boolean; learn: (found: Named[]) => void }) {
  const { location } = useSession();
  const [range, setRange] = useState<DateRange>(PRESETS.week!());
  const [store, setStore] = useState(location.id);
  const [status, setStatus] = useState("");
  const [staffId, setStaffId] = useState("");
  const [rows, setRows] = useState<Occ[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = rangeDays(range);
  const query = new URLSearchParams({ from: days.from, to: days.to, take: "500", ...(store ? { locationId: store } : {}), ...(status ? { status } : {}), ...(staffId ? { staffId } : {}) }).toString();
  useEffect(() => {
    let live = true;
    setError(null);
    api<{ occurrences: Occ[] }>("GET", `/tasks/occurrences?${query}`)
      .then((r) => {
        if (!live) return;
        setRows(r.occurrences);
        learn(r.occurrences.flatMap((o) => [o.completedBy, o.assignee.employee]));
      })
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [query]);

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? "";
  const statusText = (o: Occ) => (o.status === "DONE" ? "Done" : o.status === "SKIPPED" ? "Skipped" : "Open");
  const csv = () =>
    saveCsv(
      `tasks-${days.from}-to-${days.to}.csv`,
      ["Due on", "Due by", "Task", "Store", "Status", "Completed by", "When", "Late", "Note / reason"],
      (rows ?? []).map((o) => [o.dueOn, o.dueTime ?? "", o.title, storeName(o.locationId), statusText(o), o.completedBy?.name ?? "", o.completedAt ? when(o.completedAt) : "", o.late ? "yes" : "", o.note ?? o.skipReason ?? ""]),
    );
  const columns: Column<Occ>[] = [
    { key: "d", label: "Due", render: (o) => `${shortDay(o.dueOn)} · ${clockOf(o.dueTime)}`, width: 150 },
    { key: "t", label: "Task", render: (o) => <TitleCell o={o} />, width: 220 },
    { key: "l", label: "Store", render: (o) => storeName(o.locationId), width: 120 },
    { key: "s", label: "Status", render: (o) => <Badge text={statusText(o)} tone={o.status === "DONE" ? "good" : o.status === "SKIPPED" ? "warn" : "muted"} />, width: 90 },
    { key: "b", label: "Completed by", render: (o) => o.completedBy?.name ?? "", width: 130 },
    { key: "w", label: "When", render: (o) => (o.completedAt ? when(o.completedAt) : ""), width: 160 },
    { key: "late", label: "Late", render: (o) => (o.late ? <Badge text="late" tone="warn" /> : ""), width: 60 },
    { key: "n", label: "Note / reason", render: (o) => o.note ?? o.skipReason ?? "", width: 220 },
  ];

  return (
    <Card title="History" right={Platform.OS === "web" && rows && rows.length > 0 ? <Button title="CSV" kind="secondary" style={{ minHeight: 36, paddingVertical: 6 }} onPress={csv} /> : undefined}>
      <DateRangePicker value={range} onChange={setRange} />
      <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
        <Picker label="Store" options={stores.map((s) => [s.id, s.name])} value={store} onChange={setStore} noneLabel="Every store" />
        <Picker label="Status" options={STATUS_OPTIONS} value={status} onChange={setStatus} noneLabel="Any status" />
        <Picker label="Employee" options={people.map((p) => [p.id, p.name])} value={staffId} onChange={setStaffId} noneLabel="Everyone" />
      </View>
      {!listed && <Text style={ui.muted}>{PEOPLE_NOTE}</Text>}
      {error && <Text style={ui.error}>{error}</Text>}
      <Text style={ui.muted}>{rows ? `${rows.length} task${rows.length === 1 ? "" : "s"} · ${range.label}` : "Loading…"}</Text>
      <Table<Occ> rows={rows ?? []} keyOf={(o) => o.id} columns={columns} empty={rows ? "No tasks in this range." : "Loading…"} />
    </Card>
  );
}

// ── Report ───────────────────────────────────────────────────────

const percent = (r: number) => `${Math.round(r * 100)}%`;

function ReportView({ stores }: { stores: Store[] }) {
  const { location } = useSession();
  const [range, setRange] = useState<DateRange>(PRESETS.month!());
  const [store, setStore] = useState(location.id);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = rangeDays(range);
  const path = `/tasks/report?from=${days.from}&to=${days.to}${store ? `&locationId=${store}` : ""}`;
  useEffect(() => {
    let live = true;
    setError(null);
    api<Report>("GET", path)
      .then((r) => live && setData(r))
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [path]);

  const t = data?.totals;
  return (
    <>
      <Card title="Task completion" right={Platform.OS === "web" && data ? <Button title="CSV" kind="secondary" style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => downloadCsv(path, getToken())} /> : undefined}>
        <DateRangePicker value={range} onChange={setRange} />
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
          <Picker label="Store" options={stores.map((s) => [s.id, s.name])} value={store} onChange={setStore} noneLabel="Every store" />
        </View>
        {error && <Text style={ui.error}>{error}</Text>}
        {t ? <KeyValues obj={{ due: t.due, done: t.done, doneLate: t.late, skipped: t.skipped, missed: t.missed, completionRate: percent(t.completionRate) }} /> : <Text style={ui.muted}>Loading…</Text>}
      </Card>
      <Card title={`By task · ${range.label}`}>
        <Table
          rows={data?.byTask ?? []}
          keyOf={(r) => r.taskId}
          columns={[
            { key: "t", label: "Task", render: (r) => r.title, width: 220 },
            { key: "r", label: "Repeats", render: (r) => (RECURRENCE.find(([k]) => k === r.recurrence)?.[1] ?? r.recurrence), width: 100 },
            { key: "d", label: "Due", render: (r) => r.due, width: 60, align: "right" },
            { key: "o", label: "Done", render: (r) => r.done, width: 60, align: "right" },
            { key: "l", label: "Late", render: (r) => r.late, width: 60, align: "right" },
            { key: "s", label: "Skipped", render: (r) => r.skipped, width: 70, align: "right" },
            { key: "m", label: "Missed", render: (r) => r.missed, width: 70, align: "right" },
            { key: "c", label: "Completion", render: (r) => percent(r.completionRate), width: 90, align: "right" },
          ]}
          empty={data ? "No tasks were due in this range." : "Loading…"}
        />
      </Card>
      <Card title="By employee">
        <Table
          rows={data?.byEmployee ?? []}
          keyOf={(r) => r.staffId}
          columns={[
            { key: "n", label: "Employee", render: (r) => r.name, width: 200 },
            { key: "o", label: "Done", render: (r) => r.done, width: 60, align: "right" },
            { key: "l", label: "Late", render: (r) => r.late, width: 60, align: "right" },
            { key: "s", label: "Skipped", render: (r) => r.skipped, width: 70, align: "right" },
          ]}
          empty={data ? "Nobody completed a task in this range." : "Loading…"}
        />
      </Card>
    </>
  );
}
