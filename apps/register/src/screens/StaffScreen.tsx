import { PermissionKeys, PERMISSIONS, type Permission, type PermissionLevel } from "@mypos/shared";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { api, ApiError } from "../api";
import { permissionColor } from "../approval";
import { Button } from "../components/Button";
import { useLayout } from "../layout";
import { useSession } from "../session";
import { colors, ui } from "../theme";

type Role = "OWNER" | "MANAGER" | "CASHIER";

interface StaffRow {
  id?: string;
  name: string;
  email: string;
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
const GROUPS = [...new Set(PermissionKeys.map((k) => PERMISSIONS[k].group))];

/** Employees, their PINs and roles, and what each role may do. */
export function StaffScreen() {
  const { compact } = useLayout();
  const { staff: me } = useSession();
  const [view, setView] = useState<"people" | "roles">("people");
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [editing, setEditing] = useState<StaffRow | null>(null);

  const load = useCallback(async () => {
    setStaff(await api<StaffRow[]>("GET", "/staff"));
    setRoles(await api<RoleRow[]>("GET", "/roles"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const list = (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={[ui.row, { gap: 8 }]}>
        <Button title="Employees" kind={view === "people" ? "primary" : "secondary"} onPress={() => setView("people")} style={{ flex: 1 }} />
        <Button title="Role permissions" kind={view === "roles" ? "primary" : "secondary"} onPress={() => setView("roles")} style={{ flex: 1 }} />
      </View>
      {view === "people" ? (
        <>
          <Button title="+ Add employee" kind="good" onPress={() => setEditing({ name: "", email: "", role: "CASHIER", active: true, permissionOverrides: {}, discountMaxBps: null })} />
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
                  {s.role.toLowerCase()} · {s.email}
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

  if (compact) return <View style={[ui.panel, { flex: 1, margin: 8 }]}>{editing ? form : list}</View>;
  return (
    <View style={{ flex: 1, flexDirection: "row", gap: 16, padding: 16 }}>
      <View style={[ui.panel, { flex: view === "roles" ? 3 : 2 }]}>{list}</View>
      {view === "people" && <View style={[ui.panel, { flex: 3 }]}>{form}</View>}
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
    const body = {
      name: s.name,
      email: s.email,
      role: s.role,
      active: s.active,
      permissionOverrides: s.permissionOverrides,
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
      <TextInput style={ui.input} value={s.email} onChangeText={(email) => set({ email })} placeholder="Email" autoCapitalize="none" keyboardType="email-address" placeholderTextColor={colors.muted} />
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
          {PermissionKeys.map((p) => {
            const own = s.permissionOverrides[p];
            const level = own ?? roleRow?.permissions[p] ?? "DENY";
            const cycle = () => {
              const next: (PermissionLevel | undefined)[] = ["ALLOW", "PIN", "DENY", undefined];
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
        <Button title="Save" kind="good" onPress={save} disabled={!s.name || !s.email || (!s.id && pin.length < 4)} style={{ flex: 1 }} />
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
      d.map((r) => (r.role === role ? { ...r, permissions: { ...r.permissions, [p]: ({ ALLOW: "PIN", PIN: "DENY", DENY: "ALLOW" } as const)[r.permissions[p]] } } : r)),
    );

  async function save() {
    try {
      for (const r of draft) await api("PUT", `/roles/${r.role}`, { permissions: r.permissions, discountMaxBps: r.discountMaxBps });
      setMessage("Saved. Changes apply right away, even to employees already signed in.");
      onSaved();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 6, paddingBottom: 24 }}>
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
          {PermissionKeys.filter((p) => PERMISSIONS[p].group === g).map((p) => (
            <View key={p} style={[ui.row, { paddingVertical: 4 }]}>
              <Text style={[ui.text, { flex: 1 }]}>{PERMISSIONS[p].label}</Text>
              {draft.map((r) => (
                <Pressable key={r.role} disabled={!canEdit} onPress={() => cycle(r.role, p)} style={{ width: 110, alignItems: "center", paddingVertical: 6 }}>
                  <Text style={{ color: permissionColor(r.permissions[p]), fontWeight: "600" }}>{LEVEL_LABEL[r.permissions[p]]}</Text>
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
      <Text style={ui.muted}>Owners can always do everything. "Needs PIN" means a manager (anyone allowed) enters their PIN at the register.</Text>
      {message && <Text style={ui.text}>{message}</Text>}
      {canEdit && <Button title="Save role permissions" kind="good" onPress={save} />}
    </ScrollView>
  );
}
