import { parseSessionInfo, sessionLapsed, type SessionInfo } from "./session-expiry-rules.ts";
export type SessionExpiryState = { expired: boolean; epoch: number; info: SessionInfo | null };
const empty = (): SessionExpiryState => ({ expired: false, epoch: 0, info: null });

/** Background requests can expire only the server credential they used. */
export function createSessionExpiryStore() {
  const states = new Map<string, SessionExpiryState>();
  let active = "";
  let state = empty();
  const listeners = new Set<() => void>();
  const read = (id = active) => id === active ? state : states.get(id) ?? empty();
  const emit = () => listeners.forEach(listener => listener());
  const set = (next: Partial<SessionExpiryState>, id = active) => {
    const value = { ...read(id), ...next };
    states.set(id, value);
    if (id === active) { state = value; emit(); }
  };
  const noteExpired = (maxHours?: unknown, id = active) => {
    const current = read(id);
    const hours = typeof maxHours === "number" && Number.isFinite(maxHours) && maxHours > 0 ? maxHours : null;
    const info = hours && !current.info ? { expiresAt: Date.now(), maxHours: hours, emailNeeded: false, email: null } : current.info;
    if (!current.expired || info !== current.info) set({ expired: true, info }, id);
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select: (id: string | null) => { if (active === (id ?? "")) return; active = id ?? ""; state = states.get(active) ?? empty(); emit(); },
    noteExpired,
    noteInfo: (raw: unknown, id = active) => set({ info: parseSessionInfo(raw) }, id),
    clear: (id = active) => { const current = read(id); if (current.expired) set({ expired: false, epoch: current.epoch + 1 }, id); },
    reset: (id = active) => set({ expired: false, epoch: read(id).epoch + 1, info: null }, id),
    checkResume: (now = Date.now()) => { if (sessionLapsed(state.info, now)) { noteExpired(); return true; } return false; },
  };
}
