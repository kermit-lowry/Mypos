import type { EffectivePermissions } from "@mypos/shared";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { api, ApiError, getApiUrl, setApiUrl, setToken, type Location } from "../api";
import { Button } from "../components/Button";
import { PinPad } from "../components/PinPad";
import { useLayout } from "../layout";
import type { Staff } from "../session";
import { colors, ui } from "../theme";

/** Clock in with a PIN (the usual way), or email + PIN. */
export function LoginScreen({ onSignedIn }: { onSignedIn: (staff: Staff, permissions: EffectivePermissions, locations: Location[]) => void }) {
  const [url, setUrl] = useState(getApiUrl());
  const [email, setEmail] = useState("");
  const [useEmail, setUseEmail] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dialog } = useLayout();

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

  return (
    <View style={[ui.screen, { alignItems: "center", justifyContent: "center" }]}>
      <View style={[ui.panel, { width: dialog(420), gap: 12, alignItems: "center" }]}>
        <Text style={ui.h1}>MyPOS Register</Text>
        <Text style={ui.muted}>Enter your PIN</Text>
        {useEmail && (
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
        <PinPad onSubmit={signIn} busy={busy} submitLabel="Sign in" />
        {error && <Text style={[ui.error, { textAlign: "center" }]}>{error}</Text>}
        <View style={[ui.row, { gap: 16 }]}>
          <Pressable onPress={() => setUseEmail((x) => !x)}>
            <Text style={{ color: colors.link }}>{useEmail ? "PIN only" : "Use email + PIN"}</Text>
          </Pressable>
          <Pressable onPress={() => setShowServer((x) => !x)}>
            <Text style={{ color: colors.link }}>Server</Text>
          </Pressable>
        </View>
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
