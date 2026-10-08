import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Device settings (server URL, paired terminal, scanner mode, session token).
 * Native: the OS keystore. Web (back office): localStorage, so a refresh keeps
 * you signed in. Either falls back to memory if storage throws, so the app
 * never hangs at launch.
 */
const memory = new Map<string, string>();
const web = Platform.OS === "web";

export async function getItem(key: string): Promise<string | null> {
  try {
    if (web) return globalThis.localStorage?.getItem(key) ?? memory.get(key) ?? null;
    return await SecureStore.getItemAsync(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  try {
    if (web) return void globalThis.localStorage?.setItem(key, value);
    await SecureStore.setItemAsync(key, value);
  } catch {
    memory.set(key, value);
  }
}

export async function deleteItem(key: string): Promise<void> {
  try {
    if (web) return void globalThis.localStorage?.removeItem(key);
    await SecureStore.deleteItemAsync(key);
  } catch {
    memory.delete(key);
  }
}
