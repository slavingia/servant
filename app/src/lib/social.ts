// Social media (server/social.mjs, docs/social.md): the posts on X that mention the team or match its searches,
// the replies drafted to them, and the calendar of what is approved to go out. This file is the words, the
// counting and the dates the screen and its tests share; the server decides everything else.
import { localFormat } from "./local-format.ts";

export type SocialReplyStatus = "draft" | "scheduled" | "posting" | "posted" | "failed" | "discarded";
export type SocialReply = {
  id: string; postId: string | null; text: string; status: SocialReplyStatus;
  /** Agent wrote the first wording; `edited` when a person has changed it since. */
  byAgent: boolean; edited: boolean; createdByName: string | null; updatedAt: number;
  approvedByName?: string | null; approvedAt?: number; scheduledFor?: number; postedAt?: number; url?: string;
  error?: string;
  /** What the guide learned from the change a person made to this draft. */
  lesson?: string;
  post?: SocialPost;
};
export type SocialPost = {
  id: string; kind: "mention" | "search"; search?: string;
  author: { name: string; handle: string; avatar?: string };
  text: string; url: string; postedAt: number; likes: number; reposts: number; replies: number;
  skipped?: { at: number; byName: string | null };
  /** Agent read the post and the guide and advises not replying: the reason. */
  suggestion?: string;
  reply?: SocialReply | null;
};
export type SocialCounts = { open: number; drafted: number; scheduled: number; failed: number };
export type SocialHome = {
  account: { handle: string; name: string } | null; error: string | null; syncedAt: number | null;
  canApprove: boolean; entitlementId: string; guidePageId: string; searches: string[]; spacingMinutes: number; limit: number;
  counts: SocialCounts; ownDrafts: SocialReply[];
};
export type SocialFilter = "open" | "drafted" | "skipped";
export type SocialSource = "all" | "mentions" | "search";

const URL_IN_TEXT = /https?:\/\/[^\s]+/gi;
const single = (cp: number) => cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
/** How long X says a post is (server/x-client.mjs xLength): a link counts 23, most non-Latin characters and emoji count 2. */
export function xLength(text: string): number {
  let length = 0;
  const rest = text.normalize("NFC").replace(URL_IN_TEXT, () => { length += 23; return ""; });
  for (const ch of rest) length += single(ch.codePointAt(0)!) ? 1 : 2;
  return length;
}
/** "212 of 280", and whether it is over. */
export const lengthLine = (text: string, limit: number) => { const used = xLength(text.trim()); return { text: `${used} of ${limit}`, over: used > limit }; };

/** Where a post came from: "Mention", or the search that found it. */
export const sourceLine = (post: Pick<SocialPost, "kind" | "search">) => post.kind === "mention" ? "Mention" : post.search ? `Search: ${post.search}` : "Search";

const DAY = 86_400_000;
const startOfDay = (at: number) => { const d = new Date(at); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const pad = (n: number) => String(n).padStart(2, "0");
/** A local calendar day as "2026-11-20". */
export const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** "Today", "Tomorrow", "Yesterday", else "Fri, Nov 20" (with the year when it is not this one). */
export function socialDayLabel(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const date = new Date(at);
  return `${localFormat("weekdayShort", date)}, ${localFormat(date.getFullYear() !== new Date(now).getFullYear() ? "monthDayYear" : "monthDay", date)}`;
}
/** "3:42 PM" today, otherwise "Tomorrow, 9:00 AM" or "Fri, Nov 20, 9:00 AM". */
export function socialWhen(at: number, now = Date.now()): string {
  const time = localFormat("time", new Date(at));
  return startOfDay(at) === startOfDay(now) ? time : `${socialDayLabel(at, now)}, ${time}`;
}
/** How long ago a post was written: "now", "5m", "3h", "2d", then the date. */
export function agoLabel(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
  return localFormat(new Date(at).getFullYear() !== new Date(now).getFullYear() ? "monthDayYear" : "monthDay", new Date(at));
}

/** When a reply goes out or went out: what the calendar and the list place it by. */
export const replyTime = (reply: Pick<SocialReply, "postedAt" | "scheduledFor" | "updatedAt">) => reply.postedAt ?? reply.scheduledFor ?? reply.updatedAt;

/** Where a reply stands, in one line. */
export function replyLine(reply: SocialReply, now = Date.now()): string {
  switch (reply.status) {
    case "draft": return reply.error ? reply.error : reply.byAgent ? (reply.edited ? "Agent's draft, edited" : "Agent's draft") : `Written by ${reply.createdByName ?? "a teammate"}`;
    case "scheduled": return `Goes out ${socialWhen(reply.scheduledFor ?? now, now)}${reply.approvedByName ? ` · approved by ${reply.approvedByName}` : ""}`;
    case "posting": return "Posting now";
    case "posted": return `Posted ${socialWhen(reply.postedAt ?? now, now)}${reply.approvedByName ? ` · approved by ${reply.approvedByName}` : ""}`;
    case "failed": return `Not posted. ${reply.error ?? "Try again."}`;
    case "discarded": return "Discarded";
  }
}
/** One word for a reply's state, for a calendar entry. */
export const replyBadge = (reply: Pick<SocialReply, "status">) => reply.status === "posted" ? "Posted" : reply.status === "failed" ? "Not posted" : reply.status === "posting" ? "Posting" : "Scheduled";

/** What a reply is to, in a few words: "Reply to Jo Park (@jopark)" or "Post". */
export const replyTarget = (reply: Pick<SocialReply, "post" | "postId">) => reply.post ? `Reply to ${reply.post.author.name}${reply.post.author.handle ? ` (@${reply.post.author.handle})` : ""}` : reply.postId ? "Reply" : "Post";

export type ScheduleDay = { key: string; label: string; replies: SocialReply[] };
/** The schedule as a list: one group per local day, oldest first, each in time order. */
export function scheduleDays(replies: readonly SocialReply[], now = Date.now()): ScheduleDay[] {
  const days = new Map<string, ScheduleDay>();
  for (const reply of [...replies].sort((a, b) => replyTime(a) - replyTime(b))) {
    const at = replyTime(reply), key = dayKey(at);
    if (!days.has(key)) days.set(key, { key, label: socialDayLabel(at, now), replies: [] });
    days.get(key)!.replies.push(reply);
  }
  return [...days.values()];
}

export type CalendarCell = { key: string; day: number; at: number; inMonth: boolean; today: boolean; replies: SocialReply[] };
/**
 * One month as weeks of seven days, Sunday first, padded with the days of the months beside it, each holding the
 * replies that go out (or went out) that day.
 */
export function monthGrid(year: number, month: number, replies: readonly SocialReply[], now = Date.now()): CalendarCell[][] {
  const byDay = new Map(scheduleDays(replies, now).map(day => [day.key, day.replies]));
  const first = new Date(year, month, 1);
  const weeks: CalendarCell[][] = [];
  const today = dayKey(now);
  for (let offset = -first.getDay(); ; offset += 7) {
    const week: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(year, month, 1 + offset + i);
      const key = dayKey(date.getTime());
      week.push({ key, day: date.getDate(), at: date.getTime(), inMonth: date.getMonth() === month && date.getFullYear() === year, today: key === today, replies: byDay.get(key) ?? [] });
    }
    weeks.push(week);
    const next = new Date(year, month, 1 + offset + 7);
    if (next.getMonth() !== month || next.getFullYear() !== year) break;
  }
  return weeks;
}
/** The stretch of time a month's grid covers, padding included, for asking the server. */
export function monthRange(year: number, month: number): { from: number; to: number } {
  const first = new Date(year, month, 1), last = new Date(year, month + 1, 0);
  return { from: new Date(year, month, 1 - first.getDay()).getTime(), to: new Date(year, month + 1, 7 - last.getDay()).getTime() };
}
export const monthTitle = (year: number, month: number) => localFormat("monthYear", new Date(year, month, 1));
export const stepMonth = (year: number, month: number, by: number) => { const d = new Date(year, month + by, 1); return { year: d.getFullYear(), month: d.getMonth() }; };
/** What a day of the calendar says for a screen reader: "Friday, November 20, 3 scheduled". */
export const cellLabel = (cell: CalendarCell) => `${localFormat("weekdayMonthDay", new Date(cell.at))}, ${cell.replies.length ? `${cell.replies.length} ${cell.replies.length === 1 ? "reply" : "replies"}` : "nothing scheduled"}`;

export type WhenChoice = { id: string; label: string; at: number | null };
/** The quick choices for when an approved reply goes out. "Next opening" lets the server space it from the others. */
export function whenChoices(now = Date.now()): WhenChoice[] {
  const hour = new Date(now + 60 * 60_000);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  return [
    { id: "next", label: "Next opening", at: null },
    { id: "hour", label: `In an hour (${localFormat("time", hour)})`, at: hour.getTime() },
    { id: "tomorrow", label: "Tomorrow, 9:00 AM", at: tomorrow.getTime() },
  ];
}

/**
 * A date ("2026-11-21" or "11/21") and a time ("9:30", "9:30 am", "14:05", "2pm") as typed, as a moment in local
 * time. Returns words about what is wrong instead when it can't be read or has passed.
 */
export function parseWhen(dateText: string, timeText: string, now = Date.now()): { at: number } | { error: string } {
  const today = new Date(now);
  const iso = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(dateText), short = /^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*$/.exec(dateText);
  if (!iso && !short) return { error: "Write the date like 2026-11-21 or 11/21" };
  let [year, month, day] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : [short![3] ? Number(short![3]) : today.getFullYear(), Number(short![1]), Number(short![2])];
  const time = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(timeText);
  if (!time) return { error: "Write the time like 9:30 AM or 14:05" };
  let hours = Number(time[1]);
  const minutes = Number(time[2] ?? 0), half = time[3]?.toLowerCase().replace(/\./g, "");
  if (half && (hours < 1 || hours > 12)) return { error: "Write the time like 9:30 AM or 14:05" };
  if (half === "pm" && hours < 12) hours += 12;
  if (half === "am" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return { error: "Write the time like 9:30 AM or 14:05" };
  let date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  // "11/21" with no year, typed in December for January: the next one.
  if (!iso && !short![3] && date.getTime() < now - DAY) { year += 1; date = new Date(year, month - 1, day, hours, minutes, 0, 0); }
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return { error: "That date isn't on the calendar. Check the month and day" };
  if (date.getTime() < now) return { error: "That time has passed. Choose a later one" };
  return { at: date.getTime() };
}

/** The line under the screen's tabs: which account, and when X was last asked. */
export function connectionLine(home: Pick<SocialHome, "account" | "error" | "syncedAt">, now = Date.now()): string {
  if (home.error) return home.error;
  if (!home.account) return "Connecting to X…";
  return `@${home.account.handle} on X${home.syncedAt ? ` · checked ${agoLabel(home.syncedAt, now) === "now" ? "just now" : `${agoLabel(home.syncedAt, now)} ago`}` : ""}`;
}

/** What approving says when the person doesn't hold the entitlement. */
export const NEEDS_ENTITLEMENT = "Approving needs the Social media entitlement.";
/** The posts Agent has not drafted for yet, up to `max`, for "Draft replies" on a screenful at once. */
export const undrafted = (posts: readonly SocialPost[], max = 10) => posts.filter(post => !post.reply && !post.suggestion && !post.skipped).slice(0, max);
