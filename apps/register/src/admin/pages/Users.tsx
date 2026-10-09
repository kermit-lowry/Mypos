import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, WEB_PERMISSIONS, type Permission, type PermissionLevel } from "@mypos/shared";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { api, ApiError } from "../../api";
import { Button } from "../../components/Button";
import { useSession } from "../../session";
import { colors, ui } from "../../theme";
import { Badge, Card, Chips, Field, Input, Table, when, type Column } from "../ui";

type Role = "OWNER" | "MANAGER";
/** A website user has no PIN pad: everything is Allowed or Not allowed. */
type WebLevel = "ALLOW" | "DENY";
type Overrides = Partial<Record<Permission, PermissionLevel>>;
/** A role default and whether it came from the server (GET /roles or a manager with no override) rather than a guess. */
type RoleDefault = { level: WebLevel; known: boolean };

/** A website user as GET /users returns them. `permissions` is effective: role defaults with their overrides. */
interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  permissionOverrides: Overrides;
  permissions: Partial<Record<Permission, WebLevel>>;
  lastLoginAt: string | null;
  createdAt: string;
}
/** A role's defaults from GET /roles (only readable with MANAGE_STAFF). */
interface RoleRow {
  role: "CASHIER" | "MANAGER";
  permissions: Record<Permission, PermissionLevel>;
}

const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;
const ROLE_WORD: Record<Role, string> = { OWNER: "Owner", MANAGER: "Manager" };
const LEVELS: [WebLevel, string][] = [["ALLOW", "Allowed"], ["DENY", "Not allowed"]];
const GROUPS = [...new Set(WEB_PERMISSIONS.map((p) => PERMISSIONS[p].group))];
const NOTE = "Website users sign in to this website with an email and password. Register employees are separate: they sign in at the register with a PIN (Employees page). The same person can have both.";
/** A stored PIN level reads as Not allowed for a website user (the server treats it the same). */
const web = (l: PermissionLevel | undefined): WebLevel => (l === "ALLOW" ? "ALLOW" : "DENY");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Overrides with their keys sorted, so two maps with the same entries compare equal. */
const sorted = (o: Overrides): Overrides => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** The API's message as it sent it; a validation error also lists the fields it named. */
function message(e: unknown): string {
  if (!(e instanceof ApiError)) return String(e);
  const d = e.details as { fieldErrors?: Record<string, string[] | undefined> } | undefined;
  const fields = e.code === "VALIDATION" && d?.fieldErrors ? Object.entries(d.fieldErrors).map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`) : [];
  return fields.length ? `${e.message} (${fields.join("; ")})` : e.message;
}

const passwordProblem = (p: string, again: string) =>
  p.length < PASSWORD_MIN ? `The password must be at least ${PASSWORD_MIN} characters` : p.length > PASSWORD_MAX ? `The password must be ${PASSWORD_MAX} characters or fewer` : p !== again ? "The passwords don't match" : null;

/** Back-office website users: who can sign in here and what each may do. */
export function UsersPage() {
  const { staff: me } = useSession();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [editing, setEditing] = useState<UserRow | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api<UserRow[]>("GET", "/users"));
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    load();
    // Role defaults need MANAGE_STAFF; without it they are read off the users list (or the built-in defaults).
    api<RoleRow[]>("GET", "/roles")
      .then(setRoles)
      .catch(() => setRoles(null));
  }, [load]);

  /**
   * What a manager gets from their role on the website, for showing a permission with no override.
   * `known` is false when it's only the built-in default (an owner may have changed the Manager role).
   */
  const roleDefault = (p: Permission): RoleDefault => {
    const fromRoles = roles?.find((r) => r.role === "MANAGER")?.permissions[p];
    if (fromRoles) return { level: web(fromRoles), known: true };
    const plain = users?.find((u) => u.role === "MANAGER" && !(p in u.permissionOverrides) && u.permissions[p]);
    if (plain) return { level: web(plain.permissions[p]), known: true };
    return { level: web(DEFAULT_ROLE_PERMISSIONS.MANAGER[p]), known: false };
  };

  const columns: Column<UserRow>[] = [
    { key: "n", label: "Name", render: (u) => `${u.name}${u.id === me.id ? " (you)" : ""}`, width: 200 },
    { key: "e", label: "Email", render: (u) => u.email, width: 240 },
    { key: "r", label: "Role", render: (u) => ROLE_WORD[u.role] ?? u.role, width: 100 },
    { key: "s", label: "Status", render: (u) => <Badge text={u.active ? "Active" : "Inactive"} tone={u.active ? "good" : "muted"} />, width: 100 },
    { key: "l", label: "Last sign-in", render: (u) => (u.lastLoginAt ? when(u.lastLoginAt) : "Never"), width: 190 },
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card
        title="Website users"
        right={
          <Button
            title="Add website user"
            kind="good"
            style={{ minHeight: 36, paddingVertical: 6 }}
            onPress={() => {
              setNotice(null);
              setEditing("new");
            }}
          />
        }
      >
        <Text style={ui.muted}>{NOTE}</Text>
        {error && <Text style={ui.error}>{error}</Text>}
        {notice && <Text style={ui.text}>{notice}</Text>}
        <Table<UserRow>
          rows={users ?? []}
          keyOf={(u) => u.id}
          columns={columns}
          onPress={(u) => {
            setNotice(null);
            setEditing(u);
          }}
          empty={users ? "No website users yet." : "Loading…"}
        />
      </Card>
      {editing && (
        <UserEditor
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? undefined : editing}
          roleDefault={roleDefault}
          onCancel={() => setEditing(null)}
          onDone={(m) => {
            setEditing(null);
            setNotice(m);
            load();
          }}
        />
      )}
    </ScrollView>
  );
}

interface Form {
  name: string;
  email: string;
  role: Role;
  active: boolean;
  permissionOverrides: Overrides;
  password: string;
  again: string;
}

/** Add or change a website user: name, sign-in, role, access and website permissions. */
function UserEditor({ initial, roleDefault, onDone, onCancel }: { initial?: UserRow; roleDefault: (p: Permission) => RoleDefault; onDone: (message: string) => void; onCancel: () => void }) {
  const { staff: me } = useSession();
  const [f, setF] = useState<Form>(() => ({
    name: initial?.name ?? "",
    email: initial?.email ?? "",
    role: initial?.role ?? "MANAGER",
    active: initial?.active ?? true,
    permissionOverrides: Object.fromEntries(Object.entries(initial?.permissionOverrides ?? {}).map(([k, v]) => [k, web(v)])),
    password: "",
    again: "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));

  const self = !!initial && initial.id === me.id;
  const iAmOwner = me.role === "OWNER";
  /** Only an owner manages owners. */
  const locked = !!initial && initial.role === "OWNER" && !iAmOwner;
  /** Only an owner resets another manager's password or email. */
  const signInLocked = !!initial && !self && !iAmOwner && initial.role === "MANAGER";
  const accessLocked = self || locked;

  /** The level shown for a permission: this user's override, else the role's. */
  const levelOf = (p: Permission): WebLevel => {
    const own = f.permissionOverrides[p];
    if (own) return web(own);
    if (fromServer(p)) return web(initial!.permissions[p]);
    return roleDefault(p).level;
  };
  /** Unchanged role and no override: the server's effective level is the truth. */
  const fromServer = (p: Permission) => !!initial && initial.role === f.role && !(p in initial.permissionOverrides) && !!initial.permissions[p];
  /** The level shown is only the built-in default, which may not be what the user would get. */
  const guessed = (p: Permission) => !f.permissionOverrides[p] && !fromServer(p) && !roleDefault(p).known;
  const pick = (p: Permission, level: WebLevel) => {
    const next = { ...f.permissionOverrides };
    // Only drop the override when the role default is known to match; a guessed default may be wrong, so keep what was clicked.
    const d: RoleDefault = fromServer(p) ? { level: web(initial!.permissions[p]), known: true } : roleDefault(p);
    if (d.known && level === d.level) delete next[p];
    else next[p] = level;
    set({ permissionOverrides: next });
  };
  const clearOverride = (p: Permission) => {
    const next = { ...f.permissionOverrides };
    delete next[p];
    set({ permissionOverrides: next });
  };

  const problem = (): string | null => {
    if (!f.name.trim()) return "Give the user a name";
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) return "Enter a valid email";
    if (!initial || f.password || f.again) return passwordProblem(f.password, f.again);
    return null;
  };

  /** On create, everything; on edit, only the fields that changed (overrides as the whole map). */
  const body = (): Record<string, unknown> => {
    const email = f.email.trim();
    const name = f.name.trim();
    if (!initial) return { name, email, password: f.password, role: f.role, permissionOverrides: f.permissionOverrides };
    const b: Record<string, unknown> = {};
    if (name !== initial.name) b.name = name;
    if (!signInLocked && email !== initial.email) b.email = email;
    if (!accessLocked) {
      if (f.role !== initial.role) b.role = f.role;
      if (f.active !== initial.active) b.active = f.active;
      if (!same(sorted(f.permissionOverrides), sorted(initial.permissionOverrides))) b.permissionOverrides = f.permissionOverrides;
    }
    if (!signInLocked && f.password) b.password = f.password;
    return b;
  };

  const save = async () => {
    const p = problem();
    if (p) return setError(p);
    const b = body();
    if (initial && Object.keys(b).length === 0) return onDone("Nothing changed.");
    setBusy(true);
    setError(null);
    try {
      if (initial) await api("PATCH", `/users/${initial.id}`, b);
      else await api("POST", "/users", b);
      onDone(initial ? `Saved ${f.name.trim()}.` : `Added ${f.name.trim()} as a website ${ROLE_WORD[f.role].toLowerCase()}.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const roleOptions: [Role, string][] = iAmOwner ? [["OWNER", "Owner"], ["MANAGER", "Manager"]] : [["MANAGER", "Manager"]];
  const small = { minHeight: 36, paddingVertical: 6 };
  const hint = self ? "Ask another owner to change your own access." : locked ? "Only an owner can change an owner's account." : null;

  return (
    <Card title={initial ? `Edit ${initial.name}` : "New website user"} right={<Button title="Cancel" kind="secondary" style={small} onPress={onCancel} />}>
      {hint && <Text style={[ui.muted, { color: colors.warn }]}>{hint}</Text>}
      <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
        <Field label="Name">
          <Input value={f.name} onChange={(name) => set({ name })} placeholder="e.g. Morgan Lee" />
        </Field>
        <Field label="Email">
          {signInLocked || locked ? <Text style={[ui.text, { paddingVertical: 10 }]}>{f.email}</Text> : <Input value={f.email} onChange={(email) => set({ email })} placeholder="name@example.com" keyboard="email-address" />}
        </Field>
      </View>

      <View style={{ gap: 4 }}>
        <Text style={ui.muted}>Role</Text>
        {accessLocked ? <Text style={ui.text}>{ROLE_WORD[f.role]}</Text> : <Chips options={roleOptions} value={f.role} onChange={(role) => set({ role: role as Role })} />}
      </View>

      {signInLocked || locked ? (
        <Text style={ui.muted}>Only an owner can reset another manager's password or email.</Text>
      ) : self ? (
        <Text style={ui.muted}>Change your own password with "Change password" at the top of the page.</Text>
      ) : (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap", alignItems: "flex-start" }]}>
          <Field label={initial ? "Set a new password (leave blank to keep)" : `Password (${PASSWORD_MIN}+ characters)`}>
            <Input value={f.password} onChange={(password) => set({ password })} secure placeholder={initial ? "Leave blank to keep" : "At least 10 characters"} />
          </Field>
          <Field label="Confirm password">
            <Input value={f.again} onChange={(again) => set({ again })} secure placeholder="Type it again" />
          </Field>
        </View>
      )}

      {initial && (
        <View style={[ui.row, { gap: 10 }]}>
          <Switch value={f.active} onValueChange={(active) => set({ active })} disabled={accessLocked} />
          <Text style={ui.text}>{f.active ? "Active: can sign in to the website" : "Inactive: can't sign in"}</Text>
        </View>
      )}

      <Text style={ui.h2}>Website permissions</Text>
      {f.role === "OWNER" ? (
        <Text style={ui.muted}>Owners can do everything on the website.</Text>
      ) : (
        <View style={{ gap: 4 }}>
          <Text style={ui.muted}>Defaults come from the Manager role (Employees → Role permissions). Changing one here sets it just for this user.</Text>
          {!accessLocked && WEB_PERMISSIONS.some(guessed) && (
            <Text style={[ui.muted, { color: colors.warn }]}>You can't see the Manager role's current settings, so some levels shown are the built-in defaults. Pick a level to set it for this user.</Text>
          )}
          {GROUPS.map((g) => (
            <View key={g} style={{ gap: 2 }}>
              <Text style={[ui.text, { fontWeight: "700", marginTop: 8 }]}>{g}</Text>
              {WEB_PERMISSIONS.filter((p) => PERMISSIONS[p].group === g).map((p) => {
                const own = p in f.permissionOverrides;
                return (
                  <View key={p} style={[ui.row, { gap: 8, flexWrap: "wrap", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
                    <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 200, gap: 2 }}>
                      <Text style={ui.text}>{PERMISSIONS[p].label}</Text>
                      {own && (
                        <View style={[ui.row, { gap: 6 }]}>
                          <Text style={[ui.muted, { fontSize: 12 }]}>set for this user</Text>
                          {!accessLocked && (
                            <Pressable onPress={() => clearOverride(p)} accessibilityRole="button">
                              <Text style={{ color: colors.link, fontSize: 12 }}>use role default</Text>
                            </Pressable>
                          )}
                        </View>
                      )}
                    </View>
                    {accessLocked ? <Text style={[ui.text, { color: levelOf(p) === "ALLOW" ? colors.good : colors.muted }]}>{levelOf(p) === "ALLOW" ? "Allowed" : "Not allowed"}</Text> : <Chips options={LEVELS} value={levelOf(p)} onChange={(v) => pick(p, v as WebLevel)} />}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      )}

      {error && <Text style={ui.error}>{error}</Text>}
      {!locked && (
        <View style={[ui.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button title={initial ? "Save" : "Add website user"} kind="good" onPress={save} busy={busy} disabled={busy} />
        </View>
      )}
    </Card>
  );
}
