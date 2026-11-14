import { useEffect, useSyncExternalStore } from "react";
import { api, type Account, type Project } from "./server";
import { useSession } from "./session";
import { reuseEqual } from "./reuse-equal";

// The projects you're in, shared by the sidebar, Home, the Agent tab's picker and the project
// page: one list, so a project made or renamed in one place shows up in the others right away.
// vibeCoder: you only build prototypes; vibe: vibe coding is set up on this server.
// vibeProject: the project Prototyping builds in, so pickers show it once; vibeLinks: where prototypes are served.
export type Projects = { list: Project[]; vibeCoder: boolean; vibe: boolean; vibeProject?: string; vibeLinks?: { primary: string; backup: string } };
type State = { who: string; loaded: Projects | null };
let state: State = { who: "", loaded: null };
const inflight = new Map<string, Promise<void>>();
const cache = new Map<string, Projects>();
let activeWho = "";
const listeners = new Set<() => void>();
const emit = (next: State) => { state = next; listeners.forEach(l => l()); };
// Tell the screens only when what they show is different.
const show = (who: string, loaded: Projects | null) => { if (state.who !== who || state.loaded !== loaded) emit({ who, loaded }); };
const whoIs = (a: Account) => `${a.serverKey ?? a.serverUrl}:${a.user.id}:${a.token}`;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function refreshProjects(account: Account) {
  const who = whoIs(account);
  if (inflight.has(who)) return inflight.get(who)!;
  const request = api.projects(account)
    .then(r => {
      // Projects are read on every visit to Home and every few seconds on the Agent tab. The same projects
      // again are the same value, and nothing that shows them is drawn again.
      const loaded = reuseEqual<Projects | null>(cache.get(who) ?? null, { list: r.projects, vibeCoder: r.vibeCoder, vibe: r.vibe, vibeProject: r.vibeProject, vibeLinks: r.vibeLinks })!;
      cache.set(who, loaded);
      if (activeWho === who) show(who, loaded);
    })
    .catch(() => {})
    .finally(() => { inflight.delete(who); });
  inflight.set(who, request);
  return request;
}
/** After making or changing a project: show it everywhere without waiting for the next load. */
export function rememberProject(project: Project, account: Account) {
  const who = whoIs(account);
  const loaded = cache.get(who);
  if (!loaded) return;
  const list = loaded.list.some(p => p.id === project.id) ? loaded.list.map(p => p.id === project.id ? project : p) : [...loaded.list, project];
  const next = { ...loaded, list };
  cache.set(who, next);
  if (activeWho === who) emit({ who, loaded: next });
}
export function forgetProject(id: string, account: Account) {
  const who = whoIs(account);
  const loaded = cache.get(who);
  if (!loaded) return;
  const next = { ...loaded, list: loaded.list.filter(p => p.id !== id) };
  cache.set(who, next);
  if (activeWho === who) emit({ who, loaded: next });
}
/** The signed-in account's projects, null until the first load. Fetched on mount; call refreshProjects to re-read. */
export function useProjects(): Projects | null {
  const { account } = useSession();
  const current = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    activeWho = account ? whoIs(account) : "";
    show(activeWho, cache.get(activeWho) ?? null);
    if (account) void refreshProjects(account);
  }, [account]);
  return account ? (current.who === whoIs(account) ? current.loaded : cache.get(whoIs(account)) ?? null) : null;
}
