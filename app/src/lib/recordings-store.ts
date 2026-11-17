import { useEffect, useSyncExternalStore } from "react";
import { api, ServerError, type Account, type RecordingSummary } from "./server";
import { useSession } from "./session";

// Lists and pending fetches belong to their server credential. A slow server
// never blocks the next server's first load or replaces its recordings.
type State = { who: string; list: RecordingSummary[] | null; error: string | null };
let state: State = { who: "", list: null, error: null };
let activeWho = "";
const cache = new Map<string, State>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const emit = (next: State) => { state = next; listeners.forEach(l => l()); };
const remember = (next: State) => { cache.set(next.who, next); if (activeWho === next.who) emit(next); };
const whoIs = (a: Account) => `${a.serverKey ?? a.serverUrl}:${a.user.id}:${a.token}`;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function refreshRecordings(account: Account, onMove?: (a: Account) => void) {
  const who = whoIs(account);
  if (inflight.has(who)) return inflight.get(who)!;
  const request = api.recordings(account, onMove)
    .then(list => remember({ who, list, error: null }))
    .catch(e => remember({ who, list: cache.get(who)?.list ?? null, error: e instanceof ServerError ? e.message : "Couldn't load your recordings" }))
    .finally(() => { inflight.delete(who); });
  inflight.set(who, request);
  return request;
}
/** After deleting a recording, change only the account that issued the request. */
export function forgetRecording(id: string, account: Account) {
  const current = cache.get(whoIs(account));
  if (current?.list) remember({ ...current, list: current.list.filter(r => r.id !== id) });
}
export function useRecordings(): { list: RecordingSummary[] | null; error: string | null } {
  const { account } = useSession();
  const current = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    activeWho = account ? whoIs(account) : "";
    emit(cache.get(activeWho) ?? { who: activeWho, list: null, error: null });
    if (account) void refreshRecordings(account);
  }, [account]);
  const own = account ? (current.who === whoIs(account) ? current : cache.get(whoIs(account))) : null;
  return own ? { list: own.list, error: own.error } : { list: null, error: null };
}
