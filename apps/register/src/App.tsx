import { StatusBar } from "expo-status-bar";
import { Platform } from "react-native";
import { AdminApp } from "./admin/AdminApp";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { ApiError, loadSession, setToken, type Location } from "./api";
import { BuylistScreen } from "./screens/BuylistScreen";
import { CustomerDisplayScreen } from "./screens/CustomerDisplayScreen";
import { DealsScreen } from "./screens/DealsScreen";
import { EventsScreen } from "./screens/EventsScreen";
import { LabelsScreen } from "./screens/LabelsScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { LoyaltySettingsScreen } from "./screens/LoyaltySettingsScreen";
import { OnlineOrdersScreen } from "./screens/OnlineOrdersScreen";
import { SellScreen } from "./screens/SellScreen";
import { LayawayScreen } from "./screens/LayawayScreen";
import { clockLabel, ShiftScreen, useClockStatus } from "./screens/ShiftScreen";
import { StoreSettingsScreen } from "./screens/StoreSettingsScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { useLayout } from "./layout";
import type { EffectivePermissions, Permission } from "@mypos/shared";
import { ApprovalProvider, NotPermitted } from "./approval";
import { CartProvider, useCart, useClearCart } from "./cart";
import { FulfillmentBadge, FulfillmentProvider, useFulfillmentQueue } from "./fulfillment";
import { ActivityScreen } from "./screens/ActivityScreen";
import { StaffScreen } from "./screens/StaffScreen";
import { SessionContext, useCan, useSession, type Session, type Staff } from "./session";
import * as storage from "./storage";
import { TaskBadge, TasksProvider, useTasks } from "./tasks";
import { colors, ui } from "./theme";

const TABS = ["Sell", "Online", "Shift", "Tasks", "Layaways", "Buylist", "Events", "Labels", "Deals", "Activity", "Staff", "Store", "Loyalty", "Display"] as const;
type Tab = (typeof TABS)[number];
/** Gated tabs, shown to employees who have any of the permissions (ALLOW or PIN). */
const TAB_PERMISSION: Partial<Record<Tab, Permission[]>> = {
  Online: ["FULFILL_ORDERS"],
  Shift: ["DRAWER_OPEN_CLOSE", "CASH_IN_OUT"],
  Layaways: ["LAYAWAY_CREATE", "LAYAWAY_CANCEL"],
  Deals: ["MANAGE_DEALS"],
  Activity: ["VIEW_REPORTS"],
  Staff: ["MANAGE_STAFF"],
  Store: ["MANAGE_SETTINGS"],
  Loyalty: ["MANAGE_LOYALTY"],
};

function RegisterApp() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Omit<Session, "signOut"> | null>(null);
  const [tab, setTab] = useState<Tab>("Sell");
  const [signOutNotice, setSignOutNotice] = useState<string | null>(null);
  /** An online order to open on the Online tab (from a toast). */
  const [focusOrder, setFocusOrder] = useState<{ id: string; at: number } | null>(null);
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

  useEffect(() => setSignOutNotice(null), [tab]);

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
            if (!location) return;
            // The login screen's clock in/out needs the store before anyone signs in.
            void storage.setItem("locationId", location.id);
            setSession({ staff, permissions, location });
          }}
        />
      </SafeAreaProvider>
    );
  }

  const value = { ...session, signOut };
  const visible = TABS.filter((t) => {
    const ps = TAB_PERMISSION[t];
    return !ps || ps.some((p) => session.permissions.levels[p] !== "DENY");
  });

  return (
    <SafeAreaProvider>
      {/* Customer display takes over the whole screen. */}
      <StatusBar style="light" hidden={tab === "Display"} />
      <SessionContext.Provider value={value}>
        <ApprovalProvider>
          {/* Online orders are watched from every tab: the chime, toast and header badge come from here. */}
          <FulfillmentProvider
            silent={tab === "Display"}
            onOpen={(id) => {
              if (id) setFocusOrder({ id, at: Date.now() });
              setTab("Online");
            }}
          >
            {/* The employee's tasks: the header badge and the once-per-sign-in briefing, over whichever tab they land on. */}
            <TasksProvider silent={tab === "Display"} onOpen={() => setTab("Tasks")}>
              {/* The cart lives above the tabs, so changing tabs doesn't lose a sale. */}
              <CartProvider>
                {tab === "Display" ? (
                  <CustomerDisplayScreen onExit={() => setTab("Sell")} />
                ) : (
                  <SafeAreaView style={ui.screen}>
                    <View style={[ui.row, { paddingHorizontal: narrow ? 8 : 16, paddingTop: 8, gap: 8 }]}>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ gap: 8 }}>
                        {visible.map((t) => (
                          <Pressable
                            key={t}
                            onPress={() => setTab(t)}
                            style={{ paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8, backgroundColor: tab === t ? colors.accent : colors.panel }}
                          >
                            <TabTitle tab={t} />
                          </Pressable>
                        ))}
                      </ScrollView>
                      {!narrow && (
                        <Text style={ui.muted}>
                          {session.staff.name} · {session.location.name}
                        </Text>
                      )}
                      {!narrow && <TaskBadge />}
                      <FulfillmentBadge />
                      <ClockBadge />
                      <SignOutButton onNotice={setSignOutNotice} />
                    </View>
                    {signOutNotice && <Text style={[ui.error, { paddingHorizontal: narrow ? 8 : 16, paddingTop: 4 }]}>{signOutNotice}</Text>}
                    {tab === "Sell" && <SellScreen />}
                    {tab === "Online" && <OnlineOrdersScreen focus={focusOrder} />}
                    {tab === "Shift" && <ShiftScreen />}
                    {tab === "Tasks" && <TasksScreen />}
                    {tab === "Layaways" && <LayawayScreen />}
                    {tab === "Buylist" && <BuylistScreen />}
                    {tab === "Events" && <EventsScreen />}
                    {tab === "Labels" && <LabelsScreen />}
                    {tab === "Deals" && <DealsScreen />}
                    {tab === "Activity" && <ActivityScreen />}
                    {tab === "Staff" && <StaffScreen />}
                    {tab === "Loyalty" && <LoyaltySettingsScreen />}
                    {tab === "Store" && <StoreSettingsScreen onSaved={(location) => setSession({ ...session, location })} />}
                  </SafeAreaView>
                )}
              </CartProvider>
            </TasksProvider>
          </FulfillmentProvider>
        </ApprovalProvider>
      </SessionContext.Provider>
    </SafeAreaProvider>
  );
}

/** The tab's name; "Online" carries how many online orders are open, "Tasks" how many tasks are due. */
function TabTitle({ tab }: { tab: Tab }) {
  const { counts } = useFulfillmentQueue();
  const tasks = useTasks();
  const n = tab === "Online" ? counts.total : tab === "Tasks" ? (tasks.data?.counts.open ?? 0) : 0;
  return (
    <Text style={[ui.text, { fontWeight: "600" }]}>
      {tab}
      {n > 0 ? ` · ${n}` : ""}
    </Text>
  );
}

/** "Clocked in 3 h 12 m" / "Not clocked in" beside the employee's name; one small request a minute. */
function ClockBadge() {
  const status = useClockStatus();
  if (!status) return null;
  return <Text style={[ui.muted, status.entry ? { color: colors.good } : null]}>{clockLabel(status)}</Text>;
}

/**
 * Signing out with items in the cart deletes that cart, so it's checked and
 * logged like the Clear button (a manager's PIN if that's the employee's
 * level). Cancelling the PIN keeps you signed in.
 */
function SignOutButton({ onNotice }: { onNotice: (m: string | null) => void }) {
  const { signOut } = useSession();
  const { lines } = useCart();
  const can = useCan();
  const clearCart = useClearCart();
  const [busy, setBusy] = useState(false);

  async function press() {
    onNotice(null);
    if (lines.length === 0) return signOut();
    if (can("CART_CLEAR") === "DENY") return onNotice("Clear or complete the cart first. Deleting a cart needs a manager.");
    setBusy(true);
    let cleared = false;
    try {
      cleared = await clearCart();
    } catch (e) {
      onNotice(e instanceof NotPermitted || e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    if (cleared) signOut();
  }

  return (
    <Pressable onPress={press} disabled={busy} style={{ padding: 10 }}>
      <Text style={{ color: colors.link }}>Sign out</Text>
    </Pressable>
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
