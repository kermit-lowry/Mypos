import { StatusBar } from "expo-status-bar";
import { Platform } from "react-native";
import { AdminApp } from "./admin/AdminApp";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { loadSession, setToken, type Location } from "./api";
import { BuylistScreen } from "./screens/BuylistScreen";
import { CustomerDisplayScreen } from "./screens/CustomerDisplayScreen";
import { DealsScreen } from "./screens/DealsScreen";
import { EventsScreen } from "./screens/EventsScreen";
import { LabelsScreen } from "./screens/LabelsScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { LoyaltySettingsScreen } from "./screens/LoyaltySettingsScreen";
import { SellScreen } from "./screens/SellScreen";
import { StoreSettingsScreen } from "./screens/StoreSettingsScreen";
import { useLayout } from "./layout";
import type { EffectivePermissions, Permission } from "@mypos/shared";
import { ApprovalProvider } from "./approval";
import { ActivityScreen } from "./screens/ActivityScreen";
import { StaffScreen } from "./screens/StaffScreen";
import { SessionContext, type Session, type Staff } from "./session";
import { colors, ui } from "./theme";

const TABS = ["Sell", "Buylist", "Events", "Labels", "Deals", "Activity", "Staff", "Store", "Loyalty", "Display"] as const;
type Tab = (typeof TABS)[number];
/** Back-office tabs, shown to employees who have the permission (ALLOW or PIN). */
const TAB_PERMISSION: Partial<Record<Tab, Permission>> = {
  Deals: "MANAGE_DEALS",
  Activity: "VIEW_REPORTS",
  Staff: "MANAGE_STAFF",
  Store: "MANAGE_SETTINGS",
  Loyalty: "MANAGE_LOYALTY",
};

function RegisterApp() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Omit<Session, "signOut"> | null>(null);
  const [tab, setTab] = useState<Tab>("Sell");
  const { narrow } = useLayout();
  // Registers and customer displays shouldn't dim or lock mid-sale.
  useKeepAwake();

  // Android back button: return to Sell from other tabs; never leave the app
  // from a register, and never exit the customer display by accident.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!session) return false;
      if (tab !== "Sell" && tab !== "Display") setTab("Sell");
      return true;
    });
    return () => sub.remove();
  }, [tab, session]);

  useEffect(() => {
    // Staff sign in each shift; we only remember the server URL.
    loadSession().then(() => setToken(null).then(() => setReady(true)));
  }, []);

  const signOut = () => {
    setToken(null);
    setSession(null);
  };

  if (!ready) return <View style={ui.screen} />;

  if (!session) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <LoginScreen
          onSignedIn={(staff: Staff, permissions: EffectivePermissions, locations: Location[]) => {
            const location = locations[0];
            if (location) setSession({ staff, permissions, location });
          }}
        />
      </SafeAreaProvider>
    );
  }

  const value = { ...session, signOut };
  const visible = TABS.filter((t) => {
    const p = TAB_PERMISSION[t];
    return !p || session.permissions.levels[p] !== "DENY";
  });

  // Customer display takes over the whole screen.
  if (tab === "Display") {
    return (
      <SafeAreaProvider>
        <StatusBar hidden />
        <SessionContext.Provider value={value}>
          <ApprovalProvider>
            <CustomerDisplayScreen onExit={() => setTab("Sell")} />
          </ApprovalProvider>
        </SessionContext.Provider>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SessionContext.Provider value={value}>
        <ApprovalProvider>
        <SafeAreaView style={ui.screen}>
          <View style={[ui.row, { paddingHorizontal: narrow ? 8 : 16, paddingTop: 8, gap: 8 }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ gap: 8 }}>
              {visible.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setTab(t)}
                  style={{ paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8, backgroundColor: tab === t ? colors.accent : colors.panel }}
                >
                  <Text style={[ui.text, { fontWeight: "600" }]}>{t}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {!narrow && (
              <Text style={ui.muted}>
                {session.staff.name} · {session.location.name}
              </Text>
            )}
            <Pressable onPress={signOut} style={{ padding: 10 }}>
              <Text style={{ color: colors.accent }}>Sign out</Text>
            </Pressable>
          </View>
          {tab === "Sell" && <SellScreen />}
          {tab === "Buylist" && <BuylistScreen />}
          {tab === "Events" && <EventsScreen />}
          {tab === "Labels" && <LabelsScreen />}
          {tab === "Deals" && <DealsScreen />}
          {tab === "Activity" && <ActivityScreen />}
          {tab === "Staff" && <StaffScreen />}
          {tab === "Loyalty" && <LoyaltySettingsScreen />}
          {tab === "Store" && <StoreSettingsScreen onSaved={(location) => setSession({ ...session, location })} />}
        </SafeAreaView>
        </ApprovalProvider>
      </SessionContext.Provider>
    </SafeAreaProvider>
  );
}

/**
 * In a browser this is the back-office website; on devices it's the register.
 * Open the web build with ?register to run the register in a browser.
 */
export default function App() {
  const web = Platform.OS === "web";
  const wantRegister = web && typeof globalThis.location !== "undefined" && new URLSearchParams(globalThis.location.search).has("register");
  return web && !wantRegister ? <AdminApp /> : <RegisterApp />;
}
