import type { EffectivePermissions, Permission } from "@mypos/shared";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError, getApiUrl, getToken, loadSession, setApiUrl, setToken, type Location } from "../api";
import { ApprovalProvider } from "../approval";
import { Button } from "../components/Button";
import { useLayout } from "../layout";
import { ActivityScreen } from "../screens/ActivityScreen";
import { DealsScreen } from "../screens/DealsScreen";
import { LoyaltySettingsScreen } from "../screens/LoyaltySettingsScreen";
import { StaffScreen } from "../screens/StaffScreen";
import { StoreSettingsScreen } from "../screens/StoreSettingsScreen";
import { SessionContext, type Session, type Staff } from "../session";
import { colors, ui } from "../theme";
import { Customers } from "./pages/Customers";
import { Dashboard } from "./pages/Dashboard";
import { Inventory } from "./pages/Inventory";
import { Purchasing } from "./pages/Purchasing";
import { Reports } from "./pages/Reports";
import { Transfers } from "./pages/Transfers";

type Page = "Dashboard" | "Reports" | "Inventory" | "Purchasing" | "Transfers" | "Customers" | "Deals" | "Staff" | "Activity" | "Store" | "Loyalty";

/** Pages and the permission that unlocks each (any level but DENY). */
const PAGES: [Page, Permission[]][] = [
  ["Dashboard", ["VIEW_REPORTS"]],
  ["Reports", ["VIEW_REPORTS"]],
  ["Inventory", ["MANAGE_CATALOG", "INVENTORY_ADJUST"]],
  ["Purchasing", ["MANAGE_PURCHASING", "RECEIVE_STOCK"]],
  ["Transfers", ["MANAGE_TRANSFERS", "RECEIVE_STOCK"]],
  ["Customers", ["MANAGE_CUSTOMERS", "ADJUST_BALANCES"]],
  ["Deals", ["MANAGE_DEALS"]],
  ["Staff", ["MANAGE_STAFF"]],
  ["Activity", ["VIEW_REPORTS"]],
  ["Store", ["MANAGE_SETTINGS"]],
  ["Loyalty", ["MANAGE_LOYALTY"]],
];

interface Signed {
  staff: Staff;
  permissions: EffectivePermissions;
  locations: Location[];
  location: Location;
}

/**
 * The back-office website: sign in with email + password, then run the
 * store from any browser, phone included.
 */
export function AdminApp() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Signed | null>(null);
  const [page, setPage] = useState<Page>("Dashboard");
  const [menu, setMenu] = useState(false);
  const { narrow } = useLayout();

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

  const visible = PAGES.filter(([, perms]) => perms.some((p) => session.permissions.levels[p] !== "DENY")).map(([p]) => p);
  const current = visible.includes(page) ? page : (visible[0] ?? "Dashboard");
  const value: Session = { staff: session.staff, location: session.location, permissions: session.permissions, signOut };

  const nav = (
    <View style={narrow ? { gap: 4 } : [ui.row, { gap: 6, flexWrap: "wrap" }]}>
      {visible.map((p) => (
        <Pressable
          key={p}
          onPress={() => {
            setPage(p);
            setMenu(false);
          }}
          style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, backgroundColor: current === p ? colors.accent : colors.panel }}
        >
          <Text style={[ui.text, { fontWeight: "600" }]}>{p}</Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SessionContext.Provider value={value}>
        <ApprovalProvider>
          <SafeAreaView style={ui.screen}>
            <View style={{ paddingHorizontal: narrow ? 8 : 16, paddingTop: 8, gap: 8 }}>
              <View style={[ui.row, { gap: 8, justifyContent: "space-between" }]}>
                <View style={[ui.row, { gap: 8 }]}>
                  {narrow && <Button title={menu ? "✕" : "☰"} kind="secondary" onPress={() => setMenu((m) => !m)} style={{ minHeight: 40, paddingVertical: 6 }} />}
                  <Text style={ui.h1}>{narrow ? current : "MyPOS Back Office"}</Text>
                </View>
                <View style={[ui.row, { gap: 10 }]}>
                  {session.locations.length > 1 && (
                    <Pressable
                      onPress={() => {
                        const i = session.locations.findIndex((l) => l.id === session.location.id);
                        setSession({ ...session, location: session.locations[(i + 1) % session.locations.length]! });
                      }}
                    >
                      <Text style={[ui.muted, { color: colors.accent }]}>{session.location.name} ▾</Text>
                    </Pressable>
                  )}
                  {!narrow && <Text style={ui.muted}>{session.staff.name}</Text>}
                  <Pressable onPress={signOut}>
                    <Text style={{ color: colors.accent }}>Sign out</Text>
                  </Pressable>
                </View>
              </View>
              {(!narrow || menu) && nav}
            </View>
            <View style={{ flex: 1 }} key={`${current}-${session.location.id}`}>
              {current === "Dashboard" && <Dashboard />}
              {current === "Reports" && <Reports />}
              {current === "Inventory" && <Inventory />}
              {current === "Purchasing" && <Purchasing />}
              {current === "Transfers" && <Transfers />}
              {current === "Customers" && <Customers />}
              {current === "Deals" && <DealsScreen />}
              {current === "Staff" && <StaffScreen />}
              {current === "Activity" && <ActivityScreen />}
              {current === "Store" && <StoreSettingsScreen onSaved={(location) => setSession({ ...session, location, locations: session.locations.map((l) => (l.id === location.id ? location : l)) })} />}
              {current === "Loyalty" && <LoyaltySettingsScreen />}
            </View>
          </SafeAreaView>
        </ApprovalProvider>
      </SessionContext.Provider>
    </SafeAreaProvider>
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
            <Text style={[ui.muted, { color: colors.accent }]}>Server</Text>
          </Pressable>
          {showServer && <TextInput style={ui.input} value={url} onChangeText={setUrl} autoCapitalize="none" placeholderTextColor={colors.muted} />}
        </View>
      </ScrollView>
    </SafeAreaProvider>
  );
}
