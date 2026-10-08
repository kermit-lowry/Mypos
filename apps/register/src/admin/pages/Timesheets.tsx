import { useEffect, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { api, ApiError, getToken } from "../../api";
import { useGuard } from "../../approval";
import { Button } from "../../components/Button";
import { useCan, useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Badge, Card, Chips, DateRangePicker, day, downloadCsv, Field, Input, money, Picker, PRESETS, Table, when, type DateRange } from "../ui";

/** A row of GET /time/entries. */
interface Entry {
  id: string;
  staffId: string;
  staff?: { id: string; name: string } | null;
  locationId: string;
  location?: { name: string } | null;
  clockIn: string;
  clockOut?: string | null;
  breakMinutes: number;
  note?: string | null;
  /** "register", "web", or "edited" once a manager changed it. */
  source?: string;
  editedById?: string | null;
  minutes: number;
  /** Still open long enough that someone probably forgot to clock out. */
  long?: boolean;
}
interface Employee {
  staffId: string;
  name: string;
  entries: number;
  minutes: number;
  hours: number;
  openNow: boolean;
  long?: boolean;
}
interface ClockedIn {
  staffId: string;
  name: string;
  since: string;
  location?: string;
  long?: boolean;
}
/** A row of /reports/employee-shifts: one clock-in with the sales rung up during it. */
interface ShiftRow {
  id?: string;
  staff?: string;
  name?: string;
  clockIn: string;
  clockOut?: string | null;
  minutes: number;
  orders: number;
  units: number;
  netCents: number;
  netPerHourCents?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (m: number) => {
  const n = Math.max(0, Math.round(m));
  return `${Math.floor(n / 60)} h ${n % 60} m`;
};
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();
/** The clock-out as a time when it's the same day as the clock-in, else with its date. */
const outText = (e: { clockIn: string; clockOut?: string | null }) => (e.clockOut ? (sameDay(e.clockIn, e.clockOut) ? time(e.clockOut) : when(e.clockOut)) : "");
/** "2026-10-08 09:02" in local time, for the edit inputs. */
const toInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** ISO from "YYYY-MM-DD HH:mm": null when blank, undefined when malformed. */
const fromInput = (s: string): string | null | undefined => {
  const t = s.trim();
  if (!t) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return undefined;
  const d = new Date(`${m[1]}T${pad(Number(m[2]))}:${m[3]}:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** Who's on the clock, hours per employee, every entry (editable), and sales per shift. */
export function Timesheets() {
  const { location } = useSession();
  const can = useCan();
  const manage = can("MANAGE_TIMESHEETS") !== "DENY";
  const [view, setView] = useState<"hours" | "shifts">("hours");
  const [range, setRange] = useState<DateRange>(PRESETS.week!());
  const [scope, setScope] = useState<"here" | "all">("here");
  const [staffId, setStaffId] = useState("");
  /** Employee names by id, from /staff when allowed, else gathered from the entries. */
  const [staff, setStaff] = useState<Record<string, string>>({});
  const [clockedIn, setClockedIn] = useState<ClockedIn[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);
  const changed = () => setTick((t) => t + 1);
  const learn = (people: { id: string; name: string }[]) =>
    setStaff((s) => {
      const next = { ...s };
      for (const p of people) if (p.id && p.name) next[p.id] = p.name;
      return next;
    });

  const dates = `from=${range.from.toISOString()}&to=${range.to.toISOString()}`;
  const loc = scope === "here" ? `&locationId=${location.id}` : "";
  const who = staffId ? `&staffId=${staffId}` : "";
  const reportPath = `/reports/timesheets?${dates}${loc}${who}&detail=true`;
  const shiftsPath = `/reports/employee-shifts?${dates}${loc}${who}`;
  const entriesPath = `/time/entries?${dates}${loc}${who}&take=500`;

  useEffect(() => {
    if (can("MANAGE_STAFF") === "DENY") return;
    api<{ id: string; name: string }[]>("GET", "/staff")
      .then(learn)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    api<ClockedIn[]>("GET", `/time/clocked-in${scope === "here" ? `?locationId=${location.id}` : ""}`)
      .then(setClockedIn)
      .catch(() => undefined);
  }, [scope, location.id, tick]);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    const run =
      view === "hours"
        ? Promise.all([api<{ employees?: Employee[]; staff?: Employee[] }>("GET", reportPath), api<Entry[]>("GET", entriesPath)]).then(([r, e]) => {
            if (!live) return;
            const people = r.employees ?? r.staff ?? [];
            setEmployees(people);
            setEntries(e);
            learn([...people.map((p) => ({ id: p.staffId, name: p.name })), ...e.map((x) => ({ id: x.staffId, name: x.staff?.name ?? "" }))]);
          })
        : api<ShiftRow[]>("GET", shiftsPath).then((rows) => {
            if (live) setShifts(rows);
          });
    run.catch((e) => live && setError(e instanceof ApiError ? e.message : String(e))).finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [view, reportPath, entriesPath, shiftsPath, tick]);

  const people = Object.entries(staff).sort((a, b) => a[1].localeCompare(b[1]));
  const nameOf = (e: Entry) => e.staff?.name ?? staff[e.staffId] ?? "";
  const totalMinutes = employees.reduce((a, e) => a + e.minutes, 0);
  const closeForm = () => {
    setEditing(null);
    setAdding(false);
  };
  const form = (adding || editing) && (
    <EntryForm
      key={editing?.id ?? "new"}
      initial={editing ?? undefined}
      people={people}
      onCancel={closeForm}
      onDone={(m) => {
        closeForm();
        setMessage(m);
        changed();
      }}
    />
  );

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card title="Clocked in now">
        {clockedIn.length === 0 ? (
          <Text style={ui.muted}>Nobody is on the clock{scope === "here" ? ` at ${location.name}` : ""}.</Text>
        ) : (
          <View style={[ui.row, { flexWrap: "wrap", gap: 6 }]}>
            {clockedIn.map((c) => (
              <View key={c.staffId} style={[ui.row, { gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 16, backgroundColor: colors.panelAlt }]}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.long ? colors.warn : colors.good }} />
                <Text style={ui.text}>{c.name}</Text>
                <Text style={ui.muted}>
                  since {sameDay(c.since, new Date().toISOString()) ? time(c.since) : when(c.since)}
                  {scope === "all" && c.location ? ` · ${c.location}` : ""}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Card>

      <Card title="Timesheets" right={manage && view === "hours" ? <Button title="+ Add entry" kind="good" style={{ minHeight: 36, paddingVertical: 6 }} onPress={() => (setEditing(null), setAdding(true))} /> : undefined}>
        <Chips options={[["hours", "Hours"], ["shifts", "Sales by shift"]]} value={view} onChange={(v) => setView(v as never)} />
        <DateRangePicker value={range} onChange={setRange} />
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-end" }]}>
          <Chips options={[["here", location.name], ["all", "All locations"]]} value={scope} onChange={(s) => setScope(s as never)} />
          <Picker label="Employee" options={people} value={staffId} onChange={setStaffId} noneLabel="Everyone" />
          {Platform.OS === "web" && <Button title="Download CSV" kind="secondary" style={{ minHeight: 46, paddingVertical: 8 }} onPress={() => downloadCsv(view === "hours" ? reportPath : shiftsPath, getToken())} />}
        </View>
        {error && <Text style={ui.error}>{error}</Text>}
        {message && <Text style={ui.text}>{message}</Text>}
      </Card>

      {view === "hours" ? (
        <>
          <Card title={`Hours · ${hm(totalMinutes)} · ${range.label}`}>
            <Table<Employee>
              rows={employees}
              keyOf={(e) => e.staffId}
              onPress={(e) => setStaffId(e.staffId)}
              columns={[
                { key: "n", label: "Employee", render: (e) => e.name, width: 180 },
                { key: "e", label: "Entries", render: (e) => e.entries, width: 70, align: "right" },
                { key: "h", label: "Hours", render: (e) => e.hours.toFixed(2), width: 80, align: "right" },
                { key: "m", label: "Time", render: (e) => hm(e.minutes), width: 100, align: "right" },
                { key: "o", label: "Now", render: (e) => (e.openNow ? <Badge text={e.long ? "on the clock · long" : "on the clock"} tone={e.long ? "warn" : "good"} /> : ""), width: 150 },
              ]}
              empty={busy ? "Loading…" : "No time entries in this range."}
            />
          </Card>
          {form}
          <Card title={`${entries.length} entr${entries.length === 1 ? "y" : "ies"}`}>
            {manage && entries.length > 0 && <Text style={ui.muted}>Tap an entry to edit or delete it.</Text>}
            <Table<Entry>
              rows={entries}
              keyOf={(e) => e.id}
              onPress={manage ? (e) => (setAdding(false), setEditing(e)) : undefined}
              columns={[
                ...(staffId ? [] : [{ key: "n", label: "Employee", render: (e: Entry) => nameOf(e), width: 150 }]),
                ...(scope === "all" ? [{ key: "l", label: "Location", render: (e: Entry) => e.location?.name ?? "", width: 120 }] : []),
                { key: "d", label: "Date", render: (e) => day(e.clockIn), width: 100 },
                { key: "i", label: "In", render: (e) => time(e.clockIn), width: 90 },
                { key: "o", label: "Out", render: (e) => (e.clockOut ? outText(e) : <Badge text="open" tone={e.long ? "warn" : "good"} />), width: 110 },
                { key: "b", label: "Break", render: (e) => (e.breakMinutes ? `${e.breakMinutes} min` : "—"), width: 70, align: "right" },
                { key: "m", label: "Worked", render: (e) => hm(e.minutes), width: 90, align: "right" },
                { key: "t", label: "Note", render: (e) => e.note ?? "", width: 200 },
                {
                  key: "f",
                  label: "Flags",
                  render: (e) => (
                    <View style={[ui.row, { gap: 4, flexWrap: "wrap" }]}>
                      {(e.source === "edited" || e.editedById) && <Badge text="edited" tone="muted" />}
                      {e.long && <Badge text="long" tone="warn" />}
                    </View>
                  ),
                  width: 130,
                },
              ]}
              empty={busy ? "Loading…" : "No time entries in this range."}
            />
          </Card>
        </>
      ) : (
        <Card title={`Sales by shift · ${range.label}`}>
          <Table<ShiftRow>
            rows={shifts}
            keyOf={(r) => r.id ?? `${r.staff ?? r.name}-${r.clockIn}`}
            columns={[
              { key: "n", label: "Employee", render: (r) => r.staff ?? r.name ?? "", width: 150 },
              { key: "i", label: "Clock in", render: (r) => when(r.clockIn), width: 160 },
              { key: "o", label: "Clock out", render: (r) => (r.clockOut ? outText(r) : <Badge text="open" tone="warn" />), width: 110 },
              { key: "h", label: "Worked", render: (r) => hm(r.minutes), width: 90, align: "right" },
              { key: "s", label: "Sales", render: (r) => r.orders, width: 60, align: "right" },
              { key: "u", label: "Units", render: (r) => r.units, width: 60, align: "right" },
              { key: "v", label: "Net", render: (r) => money(r.netCents), width: 100, align: "right" },
              { key: "p", label: "Per hour", render: (r) => money(r.netPerHourCents ?? (r.minutes > 0 ? Math.round((r.netCents * 60) / r.minutes) : 0)), width: 100, align: "right" },
            ]}
            empty={busy ? "Loading…" : "No shifts in this range."}
          />
        </Card>
      )}
    </ScrollView>
  );
}

/** Add an entry by hand or fix one: times as YYYY-MM-DD HH:mm, break, note. */
function EntryForm({ initial, people, onDone, onCancel }: { initial?: Entry; people: [string, string][]; onDone: (message: string) => void; onCancel: () => void }) {
  const guard = useGuard();
  const { location } = useSession();
  const [staffId, setStaffId] = useState(initial?.staffId ?? "");
  const [clockIn, setClockIn] = useState(toInput(initial?.clockIn ?? new Date().toISOString()));
  const [clockOut, setClockOut] = useState(toInput(initial?.clockOut));
  const [breakMin, setBreakMin] = useState(String(initial?.breakMinutes ?? 0));
  const [note, setNote] = useState(initial?.note ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = (): string | null => {
    if (!initial && !staffId) return "Pick an employee";
    const i = fromInput(clockIn);
    if (!i) return "Clock in must be YYYY-MM-DD HH:mm";
    const o = fromInput(clockOut);
    if (o === undefined) return "Clock out must be YYYY-MM-DD HH:mm, or blank if still on the clock";
    if (o && o <= i) return "Clock out must be after clock in";
    const b = Number(breakMin);
    if (!Number.isInteger(b) || b < 0) return "Break must be a whole number of minutes";
    return null;
  };
  /** Runs an action; `done` fires unless the PIN prompt was cancelled (guard resolves undefined). */
  const run = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    setError(null);
    try {
      if ((await fn()) !== undefined) onDone(done);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const save = () => {
    const p = problem();
    if (p) return setError(p);
    const out = fromInput(clockOut);
    const body = { clockIn: fromInput(clockIn), clockOut: out ?? (initial ? null : undefined), breakMinutes: Math.floor(Number(breakMin)) || 0, note: note.trim() || (initial ? null : undefined) };
    return run(
      "save",
      () =>
        guard("MANAGE_TIMESHEETS", async (token) => {
          if (initial) await api("PATCH", `/time/entries/${initial.id}`, body, { approvalToken: token });
          else await api("POST", "/time/entries", { ...body, staffId, locationId: location.id }, { approvalToken: token });
          return true;
        }),
      initial ? "Time entry saved." : "Time entry added.",
    );
  };
  const remove = () =>
    run(
      "delete",
      () =>
        guard("MANAGE_TIMESHEETS", async (token) => {
          await api("DELETE", `/time/entries/${initial!.id}`, undefined, { approvalToken: token });
          return true;
        }),
      "Time entry deleted.",
    );

  return (
    <Card title={initial ? `Edit ${initial.staff?.name ?? "time entry"}` : "Add time entry"} right={<Button title="Cancel" kind="secondary" style={{ minHeight: 36, paddingVertical: 6 }} onPress={onCancel} />}>
      {!initial && <Picker label="Employee" options={people} value={staffId} onChange={setStaffId} allowNone={false} placeholder="Pick an employee" />}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
        <Field label="Clock in (YYYY-MM-DD HH:mm)">
          <Input value={clockIn} onChange={setClockIn} placeholder="2026-10-08 09:00" />
        </Field>
        <Field label="Clock out (blank = on the clock)">
          <Input value={clockOut} onChange={setClockOut} placeholder="2026-10-08 17:00" />
        </Field>
        <Field label="Break (minutes)">
          <Input value={breakMin} onChange={setBreakMin} keyboard="number-pad" />
        </Field>
      </View>
      <Field label="Note">
        <Input value={note} onChange={setNote} placeholder="e.g. Forgot to clock out" />
      </Field>
      {!initial && <Text style={ui.muted}>Recorded at {location.name}. Edits are logged with your name.</Text>}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button title={initial ? "Save" : "Add entry"} kind="good" onPress={save} busy={busy === "save"} disabled={!!busy} />
        {initial && (confirm ? <Button title="Really delete" kind="danger" onPress={remove} busy={busy === "delete"} disabled={!!busy} /> : <Button title="Delete" kind="danger" onPress={() => setConfirm(true)} disabled={!!busy} />)}
      </View>
    </Card>
  );
}
