import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, Text } from "react-native";
import { api, type MyTasks, type TaskOccurrence } from "./api";
import { TaskBriefing } from "./components/TaskBriefing";
import { useSession } from "./session";
import { colors, ui } from "./theme";

const POLL_MS = 60_000;
const EMPTY_COUNTS: MyTasks["counts"] = { open: 0, overdue: 0, doneToday: 0 };
const COUNT_KEYS = Object.keys(EMPTY_COUNTS) as (keyof typeof EMPTY_COUNTS)[];

// ─── Formatting ──────────────────────────────────────────────────
// Days are store-local "YYYY-MM-DD" and times "HH:mm": shown as given, never
// through Date (new Date("YYYY-MM-DD") is UTC and can shift the day).

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "10:30 AM" from "HH:mm". */
export function timeLabel(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "Mon, Oct 6" from "YYYY-MM-DD" (parsed by parts, so the day never shifts). */
export function dayLabel(day: string, weekday = true): string {
  const [y, mo, d] = day.split("-").map(Number);
  if (!y || !mo || !d) return day;
  const wd = WEEKDAYS[new Date(y, mo - 1, d).getDay()];
  return `${weekday ? `${wd}, ` : ""}${MONTHS[mo - 1]} ${d}`;
}

/** "by 10:30 AM" or "any time today" for a task due today. */
export const dueLabel = (o: Pick<TaskOccurrence, "dueTime">, anyTime = "any time today") => (o.dueTime ? `by ${timeLabel(o.dueTime)}` : anyTime);

/** "You" / "Managers" / "Cashiers" / "Owners" / "Anyone", or the person's name when it is someone else. */
export function assigneeLabel(o: Pick<TaskOccurrence, "assignee">, meId?: string): string {
  const a = o.assignee;
  if (a.type === "EMPLOYEE") return a.employee ? (a.employee.id === meId ? "You" : a.employee.name) : "Someone";
  if (a.type === "ROLE") return a.role === "MANAGER" ? "Managers" : a.role === "CASHIER" ? "Cashiers" : a.role === "OWNER" ? "Owners" : "Role";
  return "Anyone";
}

/** "10:12 AM" from an ISO instant, in this device's time zone. */
export const clockLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// ─── Provider ────────────────────────────────────────────────────

interface Tasks {
  data: MyTasks | null;
  refresh: () => Promise<void>;
  /** Show the sign-in briefing (once per sign-in, when there is something to do). */
  briefing: boolean;
  dismissBriefing: () => void;
  /** Switch to the Tasks tab. */
  open: () => void;
}

const TasksContext = createContext<Tasks | null>(null);

export function useTasks(): Tasks {
  const t = useContext(TasksContext);
  if (!t) throw new Error("useTasks needs a TasksProvider");
  return t;
}

/**
 * Polls the signed-in employee's tasks for this store while they are signed
 * in, feeds the header badge and the Tasks tab, and shows the briefing once
 * after sign-in when there is something to do. `silent` holds the briefing
 * back (the customer display).
 */
export function TasksProvider({ children, onOpen, silent }: { children: ReactNode; onOpen: () => void; silent?: boolean }) {
  const { location } = useSession();
  const [data, setData] = useState<MyTasks | null>(null);
  const [briefing, setBriefing] = useState(false);
  // The briefing is decided on the first successful load of this sign-in, and never again.
  const decided = useRef(false);

  const refresh = useCallback(async () => {
    let r: MyTasks;
    try {
      r = await api<MyTasks>("GET", `/tasks/mine?locationId=${encodeURIComponent(location.id)}`);
    } catch {
      return;
    }
    const counts = { ...EMPTY_COUNTS, ...(r?.counts ?? {}) };
    const next: MyTasks = { today: r?.today ?? [], overdue: r?.overdue ?? [], upcoming: r?.upcoming ?? [], counts };
    // Same numbers, same counts object: the badge and tab don't re-render every poll.
    setData((prev) => (prev && COUNT_KEYS.every((k) => prev.counts[k] === counts[k]) ? { ...next, counts: prev.counts } : next));
    if (!decided.current) {
      decided.current = true;
      if (counts.open > 0) setBriefing(true);
    }
  }, [location.id]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, POLL_MS);
    // Back from the background (or the browser tab regains focus): catch up right away.
    const sub = AppState.addEventListener("change", (s) => s === "active" && void refresh());
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, [refresh]);

  const dismissBriefing = useCallback(() => setBriefing(false), []);
  const open = useCallback(() => onOpen(), [onOpen]);

  return (
    <TasksContext.Provider value={{ data, refresh, briefing, dismissBriefing, open }}>
      {children}
      {briefing && !silent && data && (
        <TaskBriefing
          data={data}
          onOpen={() => {
            setBriefing(false);
            onOpen();
          }}
          onLater={dismissBriefing}
        />
      )}
    </TasksContext.Provider>
  );
}

// ─── Header badge ────────────────────────────────────────────────

/** "Tasks · 3" in the header (wide layouts; on a phone the Tasks tab title carries the count): red while something is overdue, accent while there is work, muted when clear. Tap to open the tab. */
export function TaskBadge() {
  const { data, open } = useTasks();
  const n = data?.counts.open ?? 0;
  const overdue = (data?.counts.overdue ?? 0) > 0;
  const live = n > 0;
  const bg = overdue ? colors.bad : live ? colors.accent : colors.panelAlt;
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`Tasks, ${n} open${overdue ? `, ${data?.counts.overdue} overdue` : ""}`}
      style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 14, backgroundColor: bg }}
    >
      <Text style={[ui.muted, { fontWeight: "600" }, overdue ? { color: "#ffffff" } : live ? { color: colors.text } : null]}>{live ? `Tasks · ${n}` : "Tasks"}</Text>
    </Pressable>
  );
}
