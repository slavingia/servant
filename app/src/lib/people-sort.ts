import type { PresenceStatus } from "./message-status.ts";

// How the People list is ordered. "name" is A to Z; "seen" puts people who are
// online now first, then the most recently seen, then people never seen.
export type PeopleSort = "name" | "seen";
export const PEOPLE_SORTS: { value: PeopleSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "seen", label: "Last seen" },
];

type Sortable = { id: string; name: string; online?: boolean; lastSeenAt?: number | null };

const byName = (a: Sortable, b: Sortable) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id);

const seenAt = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * `live` is the freshest presence the app has (it wins over the list the server
 * sent when the page opened). `selfId` is you: always online to yourself.
 */
export function sortPeople<T extends Sortable>(people: readonly T[], sort: PeopleSort, live: Record<string, PresenceStatus | undefined> = {}, connected = true, selfId?: string): T[] {
  const list = [...people];
  if (sort === "name") return list.sort(byName);
  const view = (p: T) => {
    const now = p.id === selfId ? { online: true } : live[p.id] ?? p;
    return { online: !!now.online && connected, at: seenAt(now.lastSeenAt ?? p.lastSeenAt) };
  };
  return list.sort((a, b) => {
    const x = view(a), y = view(b);
    return Number(y.online) - Number(x.online) || y.at - x.at || byName(a, b);
  });
}
