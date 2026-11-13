import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

// Whether the channel Details panel is open on wide screens. Open by default; closing it is
// remembered across channels and launches (web/Mac storage only; phones use the Details page).
const KEY = "servant.detailsPanel";
const store = Platform.OS === "web" && typeof localStorage !== "undefined" ? localStorage : null;
let open = store?.getItem(KEY) !== "closed";
const listeners = new Set<() => void>();
const set = (next: boolean) => {
  open = next;
  try { store?.setItem(KEY, next ? "open" : "closed"); } catch { /* private mode: in-memory only */ }
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useDetailsPanelOpen(): [boolean, (next: boolean) => void] {
  return [useSyncExternalStore(subscribe, () => open, () => open), set];
}
