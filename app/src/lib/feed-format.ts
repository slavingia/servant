import type { FeedItem, FeedKind } from "./server";

const LABEL: Record<FeedKind, string> = { sent: "Sent", shipped: "Shipped", ran: "Ran", note: "Note" };
export const feedKindLabel = (k: FeedKind) => LABEL[k] ?? "Note";

/** "Today", "Yesterday", "Monday, November 9" (local time). */
export function dayTitle(at: number, now: number): string {
  const d = new Date(at), n = new Date(now);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(n) - start(d)) / 86400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export type FeedRow = FeedItem & { times: string[] };

const clock = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();

/** Items grouped by day, newest day first, in the order the server sent them.
 *  The same thing done again back to back ("Servant DMs: answered messages" three times) is one row with every time. */
export function groupFeed(items: FeedItem[], now: number): { key: string; title: string; items: FeedRow[] }[] {
  const out: { key: string; title: string; items: FeedRow[] }[] = [];
  for (const it of items) {
    const title = dayTitle(it.at, now);
    const time = it.time ?? clock(it.at);
    let day = out[out.length - 1];
    if (!day || day.title !== title) out.push(day = { key: `${title}:${it.at}`, title, items: [] });
    const prev = day.items[day.items.length - 1];
    if (prev && prev.kind === it.kind && prev.text === it.text && prev.url === it.url) prev.times.push(time);
    else day.items.push({ ...it, times: [time] });
  }
  return out;
}

/** The line under a row: "4:45pm · Shipped", or "4:46pm, 4:45pm and 4:20pm · Ran" for a repeat. */
export function feedMeta(it: FeedRow): string {
  const t = it.times, when = t.length <= 1 ? t[0] : `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}`;
  return [when, feedKindLabel(it.kind)].filter(Boolean).join(" · ");
}
