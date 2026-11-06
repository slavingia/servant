import { useSyncExternalStore } from "react";
import type { Account } from "./server";
import { createCall, type CallPreset, type CallState } from "./meeting-call";

// The one call you're on. It lives outside any screen, so moving around the app (or closing the
// call screen) keeps you in it; only Leave or End takes you out. Joining a different call leaves
// this one first.
type Active = { id: string; call: ReturnType<typeof createCall>; state: CallState };
let active: Active | null = null;
const listeners = new Set<() => void>();
// A fresh snapshot per change, so React sees each update.
let snap: Active | null = null;
const notify = () => { snap = active ? { ...active } : null; for (const l of listeners) l(); };

export function joinCall(account: Account, meetingId: string, preset?: CallPreset): Active {
  if (active?.id === meetingId && !["ended", "failed"].includes(active.state.status)) return active;
  if (active) void leaveCall();
  const entry: Active = { id: meetingId, call: null as never, state: { status: "starting", error: null, local: null, remotes: [], people: [], muted: false, cameraOff: false, sharing: false } };
  entry.call = createCall(account, meetingId, s => {
    entry.state = s;
    // A finished call stops being "the call you're on".
    if (active === entry && (s.status === "ended" || s.status === "failed") && !s.local) active = null;
    notify();
  }, preset);
  active = entry;
  notify();
  void entry.call.start();
  return entry;
}

export async function leaveCall() {
  const a = active;
  active = null;
  notify();
  await a?.call.leave();
}

export async function endCall() {
  const a = active;
  active = null;
  notify();
  return a?.call.end();
}

const snapshot = () => snap;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** The call you're on (and its latest state), or null. */
export function useActiveCall() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
