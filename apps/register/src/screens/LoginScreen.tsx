import type { EffectivePermissions } from "@mypos/shared";
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { api, ApiError, getApiUrl, setApiUrl, setToken, type Location, type TimeEntry } from "../api";
import { Button } from "../components/Button";
import { PinPad } from "../components/PinPad";
import { useLayout } from "../layout";
import type { Staff } from "../session";
import * as storage from "../storage";
import { colors, ui } from "../theme";

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const hoursMinutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`);

/** Sign in with a PIN (the usual way), or email + PIN. The same pad clocks in and out without signing in. */
export function LoginScreen({ onSignedIn }: { onSignedIn: (staff: Staff, permissions: EffectivePermissions, locations: Location[]) => void }) {
  const [url, setUrl] = useState(getApiUrl());
  const [email, setEmail] = useState("");
  const [useEmail, setUseEmail] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"signin" | "clock">("signin");
  /** "Sam · Clocked in at 9:02 AM", shown for a few seconds. */
  const [clocked, setClocked] = useState<string | null>(null);
  const { dialog } = useLayout();

  useEffect(() => {
    if (!clocked) return;
    const t = setTimeout(() => {
      setClocked(null);
      setMode("signin");
    }, 5000);
    return () => clearTimeout(t);
  }, [clocked]);

  async function signIn(pin: string) {
    setBusy(true);
    setError(null);
    try {
      await setApiUrl(url);
      const r = await api<{ token: string; staff: Staff; permissions: EffectivePermissions }>("POST", "/auth/login", {
        pin,
        ...(useEmail && email.trim() ? { email: email.trim() } : {}),
      });
      await setToken(r.token);
      onSignedIn(r.staff, r.permissions, await api<Location[]>("GET", "/locations"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Clock in or out at the store this register last signed in to. */
  async function clock(pin: string) {
    setBusy(true);
    setError(null);
    try {
      await setApiUrl(url);
      const locationId = await storage.getItem("locationId");
      if (!locationId) throw new Error("Sign in once first so this register knows its store, then clock in here.");
      const r = await api<{ action: "in" | "out"; staff: { id: string; name: string }; entry?: TimeEntry; minutes?: number }>("POST", "/time/clock", { pin, locationId });
      const minutes = r.minutes ?? (r.entry?.clockOut ? Math.round((new Date(r.entry.clockOut).getTime() - new Date(r.entry.clockIn).getTime()) / 60_000) : 0);
      setClocked(`${r.staff.name} · ${r.action === "in" ? `Clocked in at ${timeOf(r.entry?.clockIn ?? new Date().toISOString())}` : `Clocked out · ${hoursMinutes(minutes)}`}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const switchMode = () => {
    setMode((m) => (m === "clock" ? "signin" : "clock"));
    setError(null);
  };

  return (
    <View style={[ui.screen, { alignItems: "center", justifyContent: "center" }]}>
      <View style={[ui.panel, { width: dialog(420), gap: 12, alignItems: "center" }]}>
        <Text style={ui.h1}>MyPOS Register</Text>
        <Text style={ui.muted}>{mode === "clock" ? "Clock in or out" : "Enter your PIN"}</Text>
        {clocked ? (
          <View style={{ alignItems: "center", gap: 12, paddingVertical: 32 }}>
            <Text style={[ui.h1, { color: colors.good, textAlign: "center" }]}>{clocked}</Text>
            <Pressable
              onPress={() => {
                setClocked(null);
                setMode("signin");
              }}
            >
              <Text style={{ color: colors.link }}>Back to sign in</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {useEmail && mode === "signin" && (
              <TextInput
                style={[ui.input, { alignSelf: "stretch" }]}
                value={email}
                onChangeText={setEmail}
                placeholder="Email"
                autoCapitalize="none"
                keyboardType="email-address"
                placeholderTextColor={colors.muted}
              />
            )}
            {/* Keyed so switching modes clears the digits typed so far. */}
            <PinPad key={mode} onSubmit={mode === "clock" ? clock : signIn} busy={busy} submitLabel={mode === "clock" ? "Clock" : "Sign in"} />
            {error && <Text style={[ui.error, { textAlign: "center" }]}>{error}</Text>}
            <Button title={mode === "clock" ? "Back to sign in" : "Clock in / out"} kind="secondary" onPress={switchMode} disabled={busy} style={{ alignSelf: "stretch" }} />
            <View style={[ui.row, { gap: 16 }]}>
              {mode === "signin" && (
                <Pressable onPress={() => setUseEmail((x) => !x)}>
                  <Text style={{ color: colors.link }}>{useEmail ? "PIN only" : "Use email + PIN"}</Text>
                </Pressable>
              )}
              <Pressable onPress={() => setShowServer((x) => !x)}>
                <Text style={{ color: colors.link }}>Server</Text>
              </Pressable>
            </View>
          </>
        )}
        {showServer && (
          <View style={{ alignSelf: "stretch", gap: 6 }}>
            <TextInput
              style={ui.input}
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://pos.yourstore.com or http://192.168.1.10:4000"
              placeholderTextColor={colors.muted}
            />
            <Button title="Save server" kind="secondary" onPress={() => setApiUrl(url).then(() => setShowServer(false))} />
          </View>
        )}
      </View>
    </View>
  );
}
