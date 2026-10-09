import { canUsePin, PERMISSIONS, REGISTER_PERMISSIONS, scopeOf, type Permission, type PermissionLevel } from "@mypos/shared";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { api, ApiError } from "../api";
import { permissionColor } from "../approval";
import { Button } from "../components/Button";
import { useLayout } from "../layout";
import { useSession } from "../session";
import { colors, ui } from "../theme";

type Role = "OWNER" | "MANAGER" | "CASHIER";

/** A register employee as GET /staff returns it. Employees have a PIN and no password; website users are a separate list. */
interface StaffRow {
  id?: string;
  name: string;
  /** Optional: lets them sign in at the register with email + PIN. */
  email: string | null;
  role: Role;
  active: boolean;
  permissionOverrides: Partial<Record<Permission, PermissionLevel>>;
  discountMaxBps: number | null;
  hasPin?: boolean;
}

interface RoleRow {
  role: "CASHIER" | "MANAGER";
  permissions: Record<Permission, PermissionLevel>;
  discountMaxBps: number;
}

const LEVEL_LABEL: Record<PermissionLevel, string> = { ALLOW: "Allowed", PIN: "Needs PIN", DENY: "Not allowed" };
/** Employees only ever see the permissions that mean something at the register (never "Website users and their permissions"). */
const GROUPS = [...new Set(REGISTER_PERMISSIONS.map((k) => PERMISSIONS[k].group))];
const REGISTER_SET = new Set<string>(REGISTER_PERMISSIONS);
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;

/** Why a new website password won't be accepted, or null if it's fine. */
const passwordProblem = (p: string) =>
  p.length < PASSWORD_MIN ? `The new password must be at least ${PASSWORD_MIN} characters` : p.length > PASSWORD_MAX ? `The new password must be ${PASSWORD_MAX} characters or fewer` : null;

/** The levels a permission can cycle through: page and sign-in gates can't be PIN-approved. */
const levelsFor = (p: Permission): PermissionLevel[] => (canUsePin(p) ? ["ALLOW", "PIN", "DENY"] : ["ALLOW", "DENY"]);
/** A stored "PIN" on a permission that can't use one counts as Not allowed (the server treats it that way too). */
const shown = (p: Permission, level: PermissionLevel): PermissionLevel => (level === "PIN" && !canUsePin(p) ? "DENY" : level);

/**
 * An employee's overrides as POST/PATCH /staff take them: only register
 * permissions (the API refuses website-only keys like MANAGE_USERS, and a
 * stale map may still hold the retired BACK_OFFICE_LOGIN), saved as shown.
 */
const employeeOverrides = (o: StaffRow["permissionOverrides"]) =>
  Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (REGISTER_SET.has(k) && v ? [[k, shown(k as Permission, v)]] : [])));

/**
 * A role's levels as PUT /roles takes them: every current permission (the
 * website-only ones are kept as they are, since the role also covers website
 * users), without retired keys, saved as shown.
 */
const roleLevels = (o: RoleRow["permissions"]) =>
  Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (k in PERMISSIONS && v ? [[k, shown(k as Permission, v)]] : [])));

/** Whether this screen is open on the back-office website (a website user's session) rather than the register. */
const onWebsite = (kind: "EMPLOYEE" | "USER" | undefined) =>
  kind ? kind === "USER" : Platform.OS === "web" && !(typeof globalThis.location !== "undefined" && new URLSearchParams(globalThis.location.search).has("register"));

/** Where website access lives, phrased for where you are. */
function AccessNote({ website }: { website: boolean }) {
  return (
    <Text style={ui.muted}>
      Employees sign in at the register with their PIN. Website access is separate: owners add website users {website ? "under" : "on the back-office website under"} Settings → Website users.
    </Text>
  );
}

/** Employees, their PINs and roles, and what each role may do. */
export function StaffScreen() {
  const { compact } = useLayout();
  const { staff: me } = useSession();
  const [view, setView] = useState<"people" | "roles">("people");
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const website = onWebsite(me.kind);

  const load = useCallback(async () => {
    setStaff(await api<StaffRow[]>("GET", "/staff"));
    setRoles(await api<RoleRow[]>("GET", "/roles"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const list = (
    <View style={{ flex: 1, gap: 8 }}>
      {compact && <AccessNote website={website} />}
      <View style={[ui.row, { gap: 8 }]}>
        <Button title="Employees" kind={view === "people" ? "primary" : "secondary"} onPress={() => setView("people")} style={{ flex: 1 }} />
        <Button title="Role permissions" kind={view === "roles" ? "primary" : "secondary"} onPress={() => setView("roles")} style={{ flex: 1 }} />
      </View>
      {view === "people" ? (
        <>
          <Button title="+ Add employee" kind="good" onPress={() => setEditing({ name: "", email: null, role: "CASHIER", active: true, permissionOverrides: {}, discountMaxBps: null })} />
          <FlatList
            data={staff}
            keyExtractor={(s) => s.id!}
            renderItem={({ item: s }) => (
              <Pressable onPress={() => setEditing(s)} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, opacity: s.active ? 1 : 0.5 }}>
                <Text style={ui.text}>
                  {s.name}
                  {s.id === me.id ? " (you)" : ""}
                </Text>
                <Text style={ui.muted}>
                  {s.role.toLowerCase()}
                  {s.email ? ` · ${s.email}` : ""}
                  {Object.keys(s.permissionOverrides).length ? ` · ${Object.keys(s.permissionOverrides).length} custom` : ""}
                  {s.active ? "" : " · inactive"}
                  {s.hasPin ? "" : " · no PIN sign-in yet"}
                </Text>
              </Pressable>
            )}
          />
        </>
      ) : (
        <RolesEditor roles={roles} canEdit={me.role === "OWNER"} onSaved={load} />
      )}
    </View>
  );

  const form = editing ? (
    <StaffForm
      key={editing.id ?? "new"}
      initial={editing}
      roleDefaults={roles}
      onDone={() => {
        setEditing(null);
        load();
      }}
    />
  ) : (
    <Text style={ui.muted}>Pick an employee to edit, or add one. Each employee signs in with their own PIN.</Text>
  );

  if (compact) {
    return (
      <View style={[ui.panel, { flex: 1, margin: 8, gap: 8 }]}>{editing ? form : list}</View>
    );
  }
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <AccessNote website={website} />
      <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
        <View style={[ui.panel, { flex: view === "roles" ? 3 : 2 }]}>{list}</View>
        {view === "people" && <View style={[ui.panel, { flex: 3 }]}>{form}</View>}
      </View>
    </View>
  );
}

/**
 * A website user changes their own password, confirming with the current
 * one (POST /auth/password). Employees have no password, so this lives in
 * the back-office header, not on the register.
 */
export function ChangePasswordForm({ onClose }: { onClose?: () => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setError(null);
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    if (password !== again) return setError("The new passwords don't match");
    setBusy(true);
    try {
      await api("POST", "/auth/password", { current, password });
      setCurrent("");
      setPassword("");
      setAgain("");
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={ui.h2}>Change your website password</Text>
      <Text style={ui.muted}>Confirm with your current password, then choose a new one ({PASSWORD_MIN}–{PASSWORD_MAX} characters).</Text>
      <TextInput style={ui.input} value={current} onChangeText={setCurrent} placeholder="Current password" secureTextEntry autoCapitalize="none" autoComplete="current-password" placeholderTextColor={colors.muted} />
      <TextInput style={ui.input} value={password} onChangeText={setPassword} placeholder={`New password (${PASSWORD_MIN}–${PASSWORD_MAX} characters)`} secureTextEntry autoCapitalize="none" autoComplete="new-password" placeholderTextColor={colors.muted} />
      <TextInput style={ui.input} value={again} onChangeText={setAgain} placeholder="New password again" secureTextEntry autoCapitalize="none" autoComplete="new-password" onSubmitEditing={submit} placeholderTextColor={colors.muted} />
      {error && <Text style={ui.error}>{error}</Text>}
      {done && <Text style={ui.text}>Password changed. Use it next time you sign in to the website.</Text>}
      <View style={[ui.row, { gap: 8 }]}>
        {onClose && <Button title={done ? "Close" : "Cancel"} kind="secondary" onPress={onClose} />}
        <Button title="Change password" onPress={submit} busy={busy} disabled={!current || !password || !again} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

function StaffForm({ initial, roleDefaults, onDone }: { initial: StaffRow; roleDefaults: RoleRow[]; onDone: () => void }) {
  const [s, setS] = useState<StaffRow>(initial);
  const [pin, setPin] = useState("");
  const [limit, setLimit] = useState(initial.discountMaxBps == null ? "" : String(initial.discountMaxBps / 100));
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<StaffRow>) => setS((x) => ({ ...x, ...patch }));
  const roleRow = roleDefaults.find((r) => r.role === s.role);

  async function save() {
    setError(null);
    // A stored PIN on a page-gate permission shows as Not allowed, so save it that way.
    const permissionOverrides = employeeOverrides(s.permissionOverrides);
    const email = s.email?.trim() ? s.email.trim() : null;
    const body = {
      name: s.name.trim(),
      // Only send the email when it changed: resetting another manager's email is owner-only.
      ...(!s.id || email !== (initial.email ?? null) ? { email } : {}),
      role: s.role,
      active: s.active,
      permissionOverrides,
      discountMaxBps: limit.trim() === "" ? null : Math.round(Number(limit) * 100),
      ...(pin ? { pin } : {}),
    };
    try {
      if (s.id) await api("PATCH", `/staff/${s.id}`, body);
      else await api("POST", "/staff", body);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
      <Text style={ui.h1}>{s.id ? "Edit employee" : "New employee"}</Text>
      <TextInput style={ui.input} value={s.name} onChangeText={(name) => set({ name })} placeholder="Name" placeholderTextColor={colors.muted} />
      <TextInput style={ui.input} value={s.email ?? ""} onChangeText={(email) => set({ email })} placeholder="Email (optional)" autoCapitalize="none" keyboardType="email-address" placeholderTextColor={colors.muted} />
      <Text style={ui.muted}>Optional: lets them sign in at the register with email + PIN</Text>
      <TextInput
        style={ui.input}
        value={pin}
        onChangeText={(t) => setPin(t.replace(/\D/g, "").slice(0, 8))}
        placeholder={s.id ? "New PIN (leave empty to keep)" : "PIN (4–8 digits, unique)"}
        keyboardType="number-pad"
        secureTextEntry
        placeholderTextColor={colors.muted}
      />
      <View style={[ui.row, { gap: 8 }]}>
        {(["CASHIER", "MANAGER", "OWNER"] as const).map((r) => (
          <Button key={r} title={r[0] + r.slice(1).toLowerCase()} kind={s.role === r ? "primary" : "secondary"} onPress={() => set({ role: r })} style={{ flex: 1 }} />
        ))}
      </View>
      <View style={[ui.row, { justifyContent: "space-between" }]}>
        <Text style={ui.text}>Active</Text>
        <Switch value={s.active} onValueChange={(active) => set({ active })} />
      </View>
      {s.role !== "OWNER" ? (
        <>
          <Text style={ui.muted}>Discount limit without a PIN (% of an item). Empty = role default ({(roleRow?.discountMaxBps ?? 0) / 100}%).</Text>
          <TextInput style={ui.input} value={limit} onChangeText={setLimit} keyboardType="decimal-pad" placeholder="Role default" placeholderTextColor={colors.muted} />
          <Text style={ui.h2}>Permissions for this employee</Text>
          <Text style={ui.muted}>Tap to change. Faded = the role's setting; bold = set just for this person.</Text>
          {REGISTER_PERMISSIONS.map((p) => {
            const stored = s.permissionOverrides[p];
            const own = stored === undefined ? undefined : shown(p, stored);
            const level = shown(p, own ?? roleRow?.permissions[p] ?? "DENY");
            const cycle = () => {
              const next: (PermissionLevel | undefined)[] = [...levelsFor(p), undefined];
              const i = next.indexOf(own);
              const value = next[(i + 1) % next.length];
              const overrides = { ...s.permissionOverrides };
              if (value) overrides[p] = value;
              else delete overrides[p];
              set({ permissionOverrides: overrides });
            };
            return (
              <Pressable key={p} onPress={cycle} style={[ui.row, { justifyContent: "space-between", paddingVertical: 6 }]}>
                <Text style={[ui.text, { flex: 1 }]}>{PERMISSIONS[p].label}</Text>
                <Text style={{ color: permissionColor(level), fontWeight: own ? "700" : "400", opacity: own ? 1 : 0.6 }}>{LEVEL_LABEL[level]}</Text>
              </Pressable>
            );
          })}
        </>
      ) : (
        <Text style={ui.muted}>Owners can do everything.</Text>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={[ui.row, { gap: 8 }]}>
        <Button title="Cancel" kind="secondary" onPress={onDone} />
        <Button title="Save" kind="good" onPress={save} disabled={!s.name.trim() || (!s.id && pin.length < 4)} style={{ flex: 1 }} />
      </View>
    </ScrollView>
  );
}

function RolesEditor({ roles, canEdit, onSaved }: { roles: RoleRow[]; canEdit: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState<RoleRow[]>(roles);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setDraft(roles), [roles]);

  const cycle = (role: RoleRow["role"], p: Permission) =>
    setDraft((d) =>
      d.map((r) => {
        if (r.role !== role) return r;
        const levels = levelsFor(p);
        const next = levels[(levels.indexOf(shown(p, r.permissions[p])) + 1) % levels.length]!;
        return { ...r, permissions: { ...r.permissions, [p]: next } };
      }),
    );

  async function save() {
    try {
      for (const r of draft) {
        // Save what's shown: a stored PIN on a page-gate permission is Not allowed.
        const permissions = roleLevels(r.permissions);
        await api("PUT", `/roles/${r.role}`, { permissions, discountMaxBps: r.discountMaxBps });
      }
      setMessage("Saved. Changes apply right away, even to employees already signed in.");
      onSaved();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 6, paddingBottom: 24 }}>
      <Text style={ui.muted}>Permissions marked "also on the website" apply to website users with this role too.</Text>
      <View style={[ui.row, { paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
        <Text style={[ui.muted, { flex: 1 }]}>{canEdit ? "Tap a setting to change it" : "Only owners can change these"}</Text>
        {draft.map((r) => (
          <Text key={r.role} style={[ui.muted, { width: 110, textAlign: "center", fontWeight: "700" }]}>
            {r.role === "CASHIER" ? "Cashier" : "Manager"}
          </Text>
        ))}
      </View>
      {GROUPS.map((g) => (
        <View key={g} style={{ gap: 2 }}>
          <Text style={[ui.h2, { marginTop: 8 }]}>{g}</Text>
          {REGISTER_PERMISSIONS.filter((p) => PERMISSIONS[p].group === g).map((p) => (
            <View key={p} style={[ui.row, { paddingVertical: 4 }]}>
              <View style={{ flex: 1 }}>
                <Text style={ui.text}>{PERMISSIONS[p].label}</Text>
                {scopeOf(p) === "both" && <Text style={[ui.muted, { fontSize: 12 }]}>also on the website</Text>}
              </View>
              {draft.map((r) => (
                <Pressable key={r.role} disabled={!canEdit} onPress={() => cycle(r.role, p)} style={{ width: 110, alignItems: "center", paddingVertical: 6 }}>
                  <Text style={{ color: permissionColor(shown(p, r.permissions[p])), fontWeight: "600" }}>{LEVEL_LABEL[shown(p, r.permissions[p])]}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      ))}
      <View style={[ui.row, { paddingVertical: 8 }]}>
        <Text style={[ui.text, { flex: 1 }]}>Discount limit without a PIN (%)</Text>
        {draft.map((r) => (
          <TextInput
            key={r.role}
            editable={canEdit}
            style={[ui.input, { width: 100, marginHorizontal: 5, textAlign: "center" }]}
            keyboardType="decimal-pad"
            defaultValue={String(r.discountMaxBps / 100)}
            onChangeText={(t) => setDraft((d) => d.map((x) => (x.role === r.role ? { ...x, discountMaxBps: Math.max(0, Math.min(10_000, Math.round(Number(t) * 100) || 0)) } : x)))}
          />
        ))}
      </View>
      <Text style={ui.muted}>Owners can always do everything. "Needs PIN" means a manager (anyone allowed) enters their PIN at the register. Permissions that open a page or sign-in can only be Allowed or Not allowed.</Text>
      {message && <Text style={ui.text}>{message}</Text>}
      {canEdit && <Button title="Save role permissions" kind="good" onPress={save} />}
    </ScrollView>
  );
}
