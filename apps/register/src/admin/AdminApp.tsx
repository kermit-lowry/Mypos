import type { EffectivePermissions, Permission } from "@mypos/shared";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState, type ReactElement } from "react";
import { Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError, getApiUrl, getToken, loadSession, setApiUrl, setToken, type Location } from "../api";
import { ApprovalProvider } from "../approval";
import { Button } from "../components/Button";
import { useLayout } from "../layout";
import { ActivityScreen } from "../screens/ActivityScreen";
import { DealsScreen } from "../screens/DealsScreen";
import { LoyaltySettingsScreen } from "../screens/LoyaltySettingsScreen";
import { ChangePasswordForm, StaffScreen } from "../screens/StaffScreen";
import { StoreSettingsScreen } from "../screens/StoreSettingsScreen";
import { SessionContext, type Session, type Staff } from "../session";
import { colors, theme, ui } from "../theme";
import { Customers } from "./pages/Customers";
import { Dashboard } from "./pages/Dashboard";
import { Inventory } from "./pages/Inventory";
import { Orders } from "./pages/Orders";
import { Purchasing } from "./pages/Purchasing";
import { Reports } from "./pages/Reports";
import { Transfers } from "./pages/Transfers";

type PageId = "dashboard" | "orders" | "reports" | "products" | "brands" | "purchase-orders" | "vendors" | "purchase-report" | "transfers" | "transfer-report" | "customers" | "employees" | "deals" | "loyalty" | "store" | "activity";

interface NavItem {
  id: PageId;
  label: string;
  /** Any of these at a level other than DENY shows the page. */
  perms: Permission[];
}
/** A sidebar section. Without a label it is a single top-level item. */
interface NavGroup {
  label?: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  { items: [{ id: "dashboard", label: "Dashboard", perms: ["VIEW_REPORTS"] }] },
  { label: "Sales", items: [{ id: "orders", label: "Orders", perms: ["VIEW_REPORTS", "REFUND"] }, { id: "reports", label: "Reports", perms: ["VIEW_REPORTS"] }] },
  { label: "Inventory", items: [{ id: "products", label: "Products", perms: ["MANAGE_CATALOG", "INVENTORY_ADJUST"] }, { id: "brands", label: "Brands", perms: ["MANAGE_CATALOG"] }] },
  {
    label: "Purchase",
    items: [
      { id: "purchase-orders", label: "Purchase Orders", perms: ["MANAGE_PURCHASING", "RECEIVE_STOCK"] },
      { id: "vendors", label: "Vendors", perms: ["MANAGE_PURCHASING"] },
      { id: "purchase-report", label: "Purchase Report", perms: ["VIEW_REPORTS"] },
    ],
  },
  { label: "Transfers", items: [{ id: "transfers", label: "Transfers", perms: ["MANAGE_TRANSFERS", "RECEIVE_STOCK"] }, { id: "transfer-report", label: "Transfer Report", perms: ["VIEW_REPORTS"] }] },
  { items: [{ id: "customers", label: "Customers", perms: ["MANAGE_CUSTOMERS", "ADJUST_BALANCES"] }] },
  { items: [{ id: "employees", label: "Employees", perms: ["MANAGE_STAFF"] }] },
  { label: "Marketing", items: [{ id: "deals", label: "Deals", perms: ["MANAGE_DEALS"] }, { id: "loyalty", label: "Loyalty", perms: ["MANAGE_LOYALTY"] }] },
  { label: "Settings", items: [{ id: "store", label: "Store", perms: ["MANAGE_SETTINGS"] }, { id: "activity", label: "Activity log", perms: ["VIEW_REPORTS"] }] },
];

const PAGES: Record<PageId, (ctx: { onLocationSaved: (l: Location) => void }) => ReactElement> = {
  dashboard: () => <Dashboard />,
  orders: () => <Orders />,
  reports: () => <Reports />,
  products: () => <Inventory view="items" />,
  brands: () => <Inventory view="brands" />,
  "purchase-orders": () => <Purchasing view="orders" />,
  vendors: () => <Purchasing view="vendors" />,
  "purchase-report": () => <Reports initial="purchases" />,
  transfers: () => <Transfers />,
  "transfer-report": () => <Reports initial="transfers" />,
  customers: () => <Customers />,
  employees: () => <StaffScreen />,
  deals: () => <DealsScreen />,
  loyalty: () => <LoyaltySettingsScreen />,
  store: ({ onLocationSaved }) => <StoreSettingsScreen onSaved={onLocationSaved} />,
  activity: () => <ActivityScreen />,
};

const SIDEBAR_WIDTH = 240;
const PAGE_KEY = "adminPage";
const ALL_PAGES = NAV.flatMap((g) => g.items.map((i) => i.id));

// The last page visited, so a refresh lands back on it (browser only).
function savedPage(): PageId | null {
  try {
    const p = Platform.OS === "web" ? globalThis.localStorage?.getItem(PAGE_KEY) : null;
    return p && ALL_PAGES.includes(p as PageId) ? (p as PageId) : null;
  } catch {
    return null;
  }
}
function savePage(p: PageId) {
  try {
    if (Platform.OS === "web") globalThis.localStorage?.setItem(PAGE_KEY, p);
  } catch {
    // Private mode or storage disabled: the page just won't stick.
  }
}

interface Signed {
  staff: Staff;
  permissions: EffectivePermissions;
  locations: Location[];
  location: Location;
}

/**
 * The back-office website: sign in with email + password, then run the
 * store from any browser, phone included. Grouped navigation in a left
 * sidebar; on phones it slides in from the ☰ button.
 */
export function AdminApp() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Signed | null>(null);
  const [page, setPage] = useState<PageId>(() => savedPage() ?? "dashboard");
  const [menu, setMenu] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const { narrow, dialog } = useLayout();

  // Resume a session kept in the browser.
  useEffect(() => {
    (async () => {
      await loadSession();
      if (getToken()) {
        try {
          const me = await api<{ staff: Staff; permissions: EffectivePermissions }>("GET", "/auth/me");
          const locations = await api<Location[]>("GET", "/locations");
          if (locations[0] && me.permissions.levels.BACK_OFFICE_LOGIN !== "DENY") setSession({ ...me, locations, location: locations[0] });
        } catch {
          await setToken(null);
        }
      }
      setReady(true);
    })();
  }, []);

  const signOut = async () => {
    await setToken(null);
    setSession(null);
  };

  if (!ready) return <View style={ui.screen} />;
  if (!session) return <WebLogin onSignedIn={setSession} />;

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.perms.some((p) => session.permissions.levels[p] !== "DENY")) })).filter((g) => g.items.length > 0);
  const allowed = groups.flatMap((g) => g.items);
  const current = allowed.find((i) => i.id === page) ?? allowed[0];
  const value: Session = { staff: session.staff, location: session.location, permissions: session.permissions, signOut };
  const go = (id: PageId) => {
    setPage(id);
    savePage(id);
    setMenu(false);
  };
  const sidebar = <Sidebar groups={groups} current={current?.id} onGo={go} staff={session.staff} />;

  return (
    <SafeAreaProvider>
      <StatusBar style={theme === "light" ? "dark" : "light"} />
      <SessionContext.Provider value={value}>
        <ApprovalProvider>
          <SafeAreaView style={[ui.screen, { flexDirection: "row" }]}>
            {!narrow && sidebar}
            <View style={{ flex: 1 }}>
              <View style={[ui.row, { height: 56, paddingHorizontal: narrow ? 12 : 20, gap: 12, backgroundColor: colors.panel, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
                {narrow && (
                  <Pressable onPress={() => setMenu(true)} accessibilityRole="button" accessibilityLabel="Menu" style={{ paddingVertical: 4, paddingHorizontal: 6 }}>
                    <Text style={{ color: colors.text, fontSize: 22 }}>☰</Text>
                  </Pressable>
                )}
                <Text style={[ui.h2, { flex: 1 }]} numberOfLines={1}>
                  {current?.label ?? "Back Office"}
                </Text>
                {session.locations.length > 1 ? (
                  <LocationMenu locations={session.locations} current={session.location} onPick={(location) => setSession({ ...session, location })} />
                ) : (
                  <Text style={ui.muted} numberOfLines={1}>
                    {session.location.name}
                  </Text>
                )}
                {!narrow && (
                  <Text style={[ui.text, { fontSize: 14 }]} numberOfLines={1}>
                    {session.staff.name}
                  </Text>
                )}
                <Pressable onPress={() => setChangingPassword(true)} accessibilityRole="button">
                  <Text style={{ color: colors.link, fontSize: 14 }} numberOfLines={1}>
                    {narrow ? "Password" : "Change password"}
                  </Text>
                </Pressable>
                <Pressable onPress={signOut}>
                  <Text style={{ color: colors.link, fontSize: 14 }}>Sign out</Text>
                </Pressable>
              </View>
              <Modal visible={changingPassword} transparent animationType="fade" onRequestClose={() => setChangingPassword(false)}>
                <View style={{ flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center", padding: 12 }}>
                  <View style={[ui.panel, { width: dialog(420) }]}>
                    <ChangePasswordForm onClose={() => setChangingPassword(false)} />
                  </View>
                </View>
              </Modal>
              {current ? (
                <View style={{ flex: 1 }} key={`${current.id}-${session.location.id}`}>
                  {PAGES[current.id]({ onLocationSaved: (location) => setSession({ ...session, location, locations: session.locations.map((l) => (l.id === location.id ? location : l)) }) })}
                </View>
              ) : (
                <Text style={[ui.muted, { padding: 16 }]}>Your account can sign in here but has no back-office pages yet. Ask an owner for permissions.</Text>
              )}
            </View>
            {narrow && menu && (
              <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, flexDirection: "row", zIndex: 10 }}>
                {sidebar}
                <Pressable style={{ flex: 1, backgroundColor: colors.overlay }} onPress={() => setMenu(false)} accessibilityLabel="Close menu" />
              </View>
            )}
          </SafeAreaView>
        </ApprovalProvider>
      </SessionContext.Provider>
    </SafeAreaProvider>
  );
}

function Sidebar({ groups, current, onGo, staff }: { groups: NavGroup[]; current: PageId | undefined; onGo: (id: PageId) => void; staff: Staff }) {
  return (
    <View style={{ width: SIDEBAR_WIDTH, backgroundColor: colors.panel, borderRightWidth: 1, borderRightColor: colors.border }}>
      <View style={{ paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={[ui.h2, { fontSize: 16 }]}>MyPOS</Text>
        <Text style={ui.muted}>Back Office</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}>
        {groups.map((g) => (
          <View key={g.label ?? g.items[0]!.id} style={{ marginBottom: g.label ? 6 : 2, gap: 1 }}>
            {g.label && <Text style={{ color: colors.muted, fontSize: 11, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase", paddingHorizontal: 10, paddingTop: 8, paddingBottom: 3 }}>{g.label}</Text>}
            {g.items.map((item) => {
              const active = item.id === current;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => onGo(item.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={({ pressed }) => ({ paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8, backgroundColor: active ? colors.accent : pressed ? colors.panelAlt : "transparent" })}
                >
                  <Text style={{ color: colors.text, fontSize: 14, fontWeight: active ? "600" : "500" }}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
      <View style={{ paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Text style={[ui.text, { fontSize: 14, fontWeight: "600" }]} numberOfLines={1}>
          {staff.name}
        </Text>
        <Text style={ui.muted}>{staff.role.toLowerCase()}</Text>
      </View>
    </View>
  );
}

/** Which store you're looking at; pages remount when it changes. */
function LocationMenu({ locations, current, onPick }: { locations: Location[]; current: Location; onPick: (l: Location) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={[ui.row, { gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, maxWidth: 200 }]}>
        <Text style={[ui.text, { fontSize: 14, fontWeight: "500", flexShrink: 1 }]} numberOfLines={1}>
          {current.name}
        </Text>
        <Text style={ui.muted}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)}>
          <View style={[ui.panel, { position: "absolute", top: 50, right: 12, minWidth: 200, padding: 6, gap: 2 }]}>
            {locations.map((l) => (
              <Pressable key={l.id} onPress={() => (onPick(l), setOpen(false))} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, backgroundColor: l.id === current.id ? colors.accent : undefined }}>
                <Text style={ui.text}>{l.name}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

function WebLogin({ onSignedIn }: { onSignedIn: (s: Signed) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState(getApiUrl());
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dialog } = useLayout();

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await setApiUrl(url);
      const r = await api<{ token: string; staff: Staff; permissions: EffectivePermissions }>("POST", "/auth/web-login", { email: email.trim(), password });
      await setToken(r.token);
      const locations = await api<Location[]>("GET", "/locations");
      if (!locations[0]) throw new Error("No locations set up yet");
      onSignedIn({ staff: r.staff, permissions: r.permissions, locations, location: locations[0] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaProvider>
      <ScrollView style={ui.screen} contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 12 }}>
        <View style={[ui.panel, { width: dialog(420), gap: 12 }]}>
          <Text style={ui.h1}>MyPOS Back Office</Text>
          <Text style={ui.muted}>Sign in with your email and website password. Registers use PINs; this needs a password an owner set for you.</Text>
          <TextInput style={ui.input} value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor={colors.muted} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
          <TextInput style={ui.input} value={password} onChangeText={setPassword} placeholder="Password" placeholderTextColor={colors.muted} secureTextEntry onSubmitEditing={signIn} autoComplete="password" />
          {error && <Text style={ui.error}>{error}</Text>}
          <Button title="Sign in" onPress={signIn} busy={busy} disabled={!email || !password} />
          <Pressable onPress={() => setShowServer((x) => !x)}>
            <Text style={[ui.muted, { color: colors.link }]}>Server</Text>
          </Pressable>
          {showServer && <TextInput style={ui.input} value={url} onChangeText={setUrl} autoCapitalize="none" placeholderTextColor={colors.muted} />}
        </View>
      </ScrollView>
    </SafeAreaProvider>
  );
}
