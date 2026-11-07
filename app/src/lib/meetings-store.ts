import { useEffect, useSyncExternalStore } from "react";
import { api, ServerError, type Account, type MeetingItem } from "./server";
import { useSession } from "./session";

// The meetings list, shared by the Meetings screen and the sidebar (which counts the live calls):
// one list, so a call that just started shows in both at once.
type State = { who: string; list: MeetingItem[] | null; error: string | null };
let state: State = { who: "", list: null, error: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = (next: State) => { state = next; listeners.forEach(l => l()); };
const whoIs = (a: Account) => `${a.serverKey ?? a.serverUrl}:${a.user.id}`;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function refreshMeetings(account: Account, onMove?: (a: Account) => void) {
  if (inflight) return inflight;
  inflight = api.meetings(account, onMove)
    .then(list => emit({ who: whoIs(account), list, error: null }))
    .catch(e => emit({ who: whoIs(account), list: state.who === whoIs(account) ? state.list : null, error: e instanceof ServerError ? e.message : "Couldn't load your meetings" }))
    .finally(() => { inflight = null; });
  return inflight;
}
/** After deleting a recording: drop it at once, before the next load. */
export function forgetMeeting(id: string) {
  if (state.list) emit({ ...state, list: state.list.filter(m => m.id !== id) });
}
/** The signed-in account's meetings (null until the first load) and the last load error. Fetched on mount. */
export function useMeetings(): { list: MeetingItem[] | null; error: string | null } {
  const { account } = useSession();
  const current = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => { if (account) void refreshMeetings(account); }, [account]);
  return account && current.who === whoIs(account) ? { list: current.list, error: current.error } : { list: null, error: null };
}
