import { useSyncExternalStore } from "react";
import { getItem, setItem } from "./storage";

// A person can hide the server banner with a tap. We remember the exact message they hid, per device,
// so a new message from the operator shows again.
const KEY = "servant.bannerHidden";
let hidden: string | null = null;
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function hideBanner(message: string) {
  hidden = message;
  emit();
  void setItem(KEY, message).catch(() => {});
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (!loaded) {
    loaded = true;
    void getItem(KEY).then(v => { if (hidden === null && v) { hidden = v; emit(); } }).catch(() => {});
  }
  return () => { listeners.delete(l); };
}

export function useHiddenBanner(): string | null {
  return useSyncExternalStore(subscribe, () => hidden, () => hidden);
}
