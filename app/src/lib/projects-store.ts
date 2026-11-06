import { useEffect, useSyncExternalStore } from "react";
import { api, type Account, type Project } from "./server";
import { useSession } from "./session";

// The projects you're in, shared by the sidebar, Home, the Agent tab's picker and the project
// page: one list, so a project made or renamed in one place shows up in the others right away.
// vibeCoder: you only build prototypes; vibe: vibe coding is set up on this server.
export type Projects = { list: Project[]; vibeCoder: boolean; vibe: boolean; agentTier: number | null | undefined };
type State = { who: string; loaded: Projects | null };
let state: State = { who: "", loaded: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = (next: State) => { state = next; listeners.forEach(l => l()); };
const whoIs = (a: Account) => `${a.serverKey ?? a.serverUrl}:${a.user.id}`;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function refreshProjects(account: Account) {
  if (inflight) return inflight;
  inflight = api.projects(account)
    .then(r => {
      const tier = r.agentTier === undefined
        ? (r.vibeCoder ? 2 : undefined)
        : Number.isInteger(r.agentTier) ? r.agentTier : null;
      emit({ who: whoIs(account), loaded: { list: r.projects, vibeCoder: r.vibeCoder, vibe: r.vibe, agentTier: tier } });
    })
    .catch(() => {})
    .finally(() => { inflight = null; });
  return inflight;
}
/** After making or changing a project: show it everywhere without waiting for the next load. */
export function rememberProject(project: Project) {
  if (!state.loaded) return;
  const list = state.loaded.list.some(p => p.id === project.id) ? state.loaded.list.map(p => p.id === project.id ? project : p) : [...state.loaded.list, project];
  emit({ ...state, loaded: { ...state.loaded, list } });
}
export function forgetProject(id: string) {
  if (state.loaded) emit({ ...state, loaded: { ...state.loaded, list: state.loaded.list.filter(p => p.id !== id) } });
}
/** The signed-in account's projects, null until the first load. Fetched on mount; call refreshProjects to re-read. */
export function useProjects(): Projects | null {
  const { account } = useSession();
  const current = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => { if (account) void refreshProjects(account); }, [account]);
  return account && current.who === whoIs(account) ? current.loaded : null;
}
