import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

// Native phones use Keychain / Keystore. The desktop bridge encrypts the
// account with a Keychain-held key; ordinary browser builds use localStorage.
export async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.servantDesktop?.storage) return window.servantDesktop.storage.getItem(key);
  if (Platform.OS === "web") return globalThis.localStorage?.getItem(key) ?? null;
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.servantDesktop?.storage) return window.servantDesktop.storage.setItem(key, value);
  if (Platform.OS === "web") return void globalThis.localStorage?.setItem(key, value);
  await SecureStore.setItemAsync(key, value);
}

export async function removeItem(key: string): Promise<void> {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.servantDesktop?.storage) return window.servantDesktop.storage.removeItem(key);
  if (Platform.OS === "web") return void globalThis.localStorage?.removeItem(key);
  await SecureStore.deleteItemAsync(key);
}
