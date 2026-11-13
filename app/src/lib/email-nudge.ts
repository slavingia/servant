// "Add your work email" banner for people who joined before email codes. Shown
// once the server says the account has no confirmed email; a tap on the close
// button hides it for a week, confirming the email hides it for good.
import { useSyncExternalStore } from "react";
import { api, type Account } from "./server";
import { getItem, removeItem, setItem } from "./storage";
import { nudgeVisible } from "./email-nudge-rules";

let generation = 0;
const KEY = "servant.emailNudgeDismissedAt";

type State = { needed: boolean | null; dismissedAt: number | null; loaded: boolean; suggested: string };
let state: State = { needed: null, dismissedAt: null, loaded: false, suggested: "" };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => { state = { ...state, ...next }; for (const l of listeners) l(); };

export async function refreshEmailNudge(account: Account): Promise<void> {
  const current = generation;
  if (!state.loaded) {
    const raw = await getItem(KEY).catch(() => null);
    if (current !== generation) return;
    const at = raw ? Number(raw) : NaN;
    set({ dismissedAt: Number.isFinite(at) ? at : null, loaded: true });
  }
  try { const needed = await api.emailRequired(account); if (current === generation) set({ needed }); } catch { /* offline: keep what we know */ }
}

export async function dismissEmailNudge(now = Date.now()): Promise<void> {
  set({ dismissedAt: now });
  await setItem(KEY, String(now)).catch(() => undefined);
}

// An address the person already typed (and confirmed) while claiming the account: the You tab offers it first.
export function suggestEmail(email: string): void { set({ suggested: email, dismissedAt: null }); }
export function takeSuggestedEmail(): string { const e = state.suggested; if (e) set({ suggested: "" }); return e; }
// Called once the email is confirmed (You tab) and when signing out.
export function emailConfirmed(): void { set({ needed: false, suggested: "" }); }
export async function resetEmailNudge(): Promise<void> {
  generation++;
  set({ needed: null, dismissedAt: null, loaded: false, suggested: "" });
  await removeItem(KEY).catch(() => undefined);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useEmailNudge(): { visible: boolean; needed: boolean | null } {
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  return { visible: s.loaded && nudgeVisible(s.needed, s.dismissedAt), needed: s.needed };
}
