import { useSyncExternalStore } from "react";
import { getItem, setItem } from "./storage";

// The "Noise reduction" choice, per device. On by default; read once before the microphone opens.
const KEY = "servant.noiseReduction";
let on = true;
let loading: Promise<boolean> | null = null;
// Bumped by every change, so a slow first read can't undo a choice made while it was still running.
let gen = 0;
const listeners = new Set<(on: boolean) => void>();

/** The saved choice (true until the saved value says otherwise). Resolves fast after the first read. */
export function getNoisePref(): Promise<boolean> {
  if (!loading) {
    const g = gen;
    loading = getItem(KEY).then(v => { if (g === gen) { if (v === "off") on = false; else if (v === "on") on = true; } return on; }).catch(() => on);
  }
  return loading;
}

export function setNoisePref(next: boolean) {
  if (next === on) return;
  on = next; gen++;
  loading = Promise.resolve(on);
  for (const l of listeners) l(on);
  void setItem(KEY, on ? "on" : "off").catch(() => {});
}

/** Called with the new choice whenever it changes, until the returned function is called. */
export function subscribeNoisePref(l: (on: boolean) => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

const subscribe = (l: () => void) => { void getNoisePref().then(() => l()); return subscribeNoisePref(() => l()); };
export function useNoisePref(): boolean {
  return useSyncExternalStore(subscribe, () => on, () => on);
}
