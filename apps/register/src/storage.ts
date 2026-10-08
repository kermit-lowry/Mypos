import * as SecureStore from "expo-secure-store";

/**
 * Device settings (server URL, paired terminal, scanner mode, session token).
 * Uses the OS keystore; falls back to memory where it's unavailable (web
 * preview, or a keystore error), so the register never hangs at launch.
 */
const memory = new Map<string, string>();

export async function getItem(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    memory.set(key, value);
  }
}

export async function deleteItem(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    memory.delete(key);
  }
}
