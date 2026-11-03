// How someone orders their channel list. "custom" is the order they dragged
// channels into (saved on the server, so it follows them to every device).
export type ChannelSort = "recent" | "alphabetical" | "members" | "custom";

export const CHANNEL_SORTS: { value: ChannelSort; label: string; description: string }[] = [
  { value: "recent", label: "Recent", description: "Unread first, then latest activity" },
  { value: "alphabetical", label: "Alphabetical", description: "A to Z" },
  { value: "members", label: "Most members", description: "Biggest channels first" },
  { value: "custom", label: "Custom", description: "Long press a channel, then drag it" },
];

export const isChannelSort = (value: unknown): value is ChannelSort =>
  CHANNEL_SORTS.some(sort => sort.value === value);

type Sortable = { id: string; title: string; unread: number; updatedAt: number; memberCount: number; position?: number | null };

const byTitle = (a: Sortable, b: Sortable) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id);

export function sortChannels<T extends Sortable>(channels: readonly T[], sort: ChannelSort): T[] {
  const list = [...channels];
  if (sort === "alphabetical") return list.sort(byTitle);
  if (sort === "members") return list.sort((a, b) => b.memberCount - a.memberCount || byTitle(a, b));
  if (sort === "custom") {
    // Channels joined after the last drag have no place yet: they go last, A to Z.
    return list.sort((a, b) => {
      const pa = a.position ?? Infinity, pb = b.position ?? Infinity;
      return pa === pb ? byTitle(a, b) : pa - pb;
    });
  }
  return list.sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || b.updatedAt - a.updatedAt || byTitle(a, b));
}

export function moveId(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  if (from < 0 || from >= next.length) return next;
  const [id] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
  return next;
}

// Where a dragged row lands: the slot whose midpoint its own midpoint passed.
export function dropIndex(rows: readonly { y: number; h: number }[], from: number, dy: number): number {
  const row = rows[from];
  if (!row) return from;
  const center = row.y + row.h / 2 + dy;
  let to = from;
  for (let j = 0; j < rows.length; j++) {
    if (j < from && center < rows[j].y + rows[j].h / 2) { to = j; break; }
    if (j > from && center > rows[j].y + rows[j].h / 2) to = j;
  }
  return to;
}

// Positions saved by a drag, applied before the server confirms them.
export function withPositions<T extends { id: string; position?: number | null }>(channels: readonly T[], ids: readonly string[] | null): T[] {
  if (!ids) return [...channels];
  const at = new Map(ids.map((id, index) => [id, index]));
  return channels.map(c => at.has(c.id) ? { ...c, position: at.get(c.id) } : c);
}
