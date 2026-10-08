import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { api, ApiError, getApiUrl, setApiUrl, setToken, type Location } from "../api";
import { Button } from "../components/Button";
import type { Staff } from "../session";
import { colors, ui } from "../theme";

export function LoginScreen({ onSignedIn }: { onSignedIn: (staff: Staff, locations: Location[]) => void }) {
  const [url, setUrl] = useState(getApiUrl());
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await setApiUrl(url);
      const r = await api<{ token: string; staff: Staff }>("POST", "/auth/login", { email: email.trim(), pin });
      await setToken(r.token);
      onSignedIn(r.staff, await api<Location[]>("GET", "/locations"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[ui.screen, { alignItems: "center", justifyContent: "center" }]}>
      <View style={[ui.panel, { width: 420, gap: 12 }]}>
        <Text style={ui.h1}>MyPOS Register</Text>
        <Text style={ui.muted}>Server</Text>
        <TextInput style={ui.input} value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} />
        <Text style={ui.muted}>Staff email</Text>
        <TextInput style={ui.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholderTextColor={colors.muted} />
        <Text style={ui.muted}>PIN</Text>
        <TextInput style={ui.input} value={pin} onChangeText={setPin} secureTextEntry keyboardType="number-pad" onSubmitEditing={signIn} />
        {error && <Text style={ui.error}>{error}</Text>}
        <Button title="Sign in" onPress={signIn} busy={busy} disabled={!email || pin.length < 4} />
      </View>
    </View>
  );
}
