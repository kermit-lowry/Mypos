import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { loadSession, setToken, type Location } from "./api";
import { BuylistScreen } from "./screens/BuylistScreen";
import { EventsScreen } from "./screens/EventsScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { SellScreen } from "./screens/SellScreen";
import { SessionContext, type Session, type Staff } from "./session";
import { colors, ui } from "./theme";

const TABS = { Sell: SellScreen, Buylist: BuylistScreen, Events: EventsScreen } as const;
type Tab = keyof typeof TABS;

export default function App() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Omit<Session, "signOut"> | null>(null);
  const [tab, setTab] = useState<Tab>("Sell");

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
          onSignedIn={(staff: Staff, locations: Location[]) => {
            const location = locations[0];
            if (location) setSession({ staff, location });
          }}
        />
      </SafeAreaProvider>
    );
  }

  const Screen = TABS[tab];
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SessionContext.Provider value={{ ...session, signOut }}>
        <SafeAreaView style={ui.screen}>
          <View style={[ui.row, { paddingHorizontal: 16, paddingTop: 8, gap: 8 }]}>
            {(Object.keys(TABS) as Tab[]).map((t) => (
              <Pressable
                key={t}
                onPress={() => setTab(t)}
                style={{ paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8, backgroundColor: tab === t ? colors.accent : colors.panel }}
              >
                <Text style={[ui.text, { fontWeight: "600" }]}>{t}</Text>
              </Pressable>
            ))}
            <View style={{ flex: 1 }} />
            <Text style={ui.muted}>
              {session.staff.name} · {session.location.name}
            </Text>
            <Pressable onPress={signOut} style={{ padding: 10 }}>
              <Text style={{ color: colors.accent }}>Sign out</Text>
            </Pressable>
          </View>
          <Screen />
        </SafeAreaView>
      </SessionContext.Provider>
    </SafeAreaProvider>
  );
}
