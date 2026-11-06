import type { Person, Post } from "./server";
import { dayLabel } from "./time-label.ts";

export type PresenceStatus = { online?: boolean; lastSeenAt?: number | null };

const validTime = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime());

export function statusTime(at: number, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return time;
  const day = dayLabel(at, now);
  return `${day}, ${time}`;
}

export function presenceLabel(presence: PresenceStatus, now = Date.now(), connected = true) {
  if (presence.online && connected) return "Online";
  if (!validTime(presence.lastSeenAt)) return "";
  // Deliberately vague (never an exact time): people shouldn't be able to track each other's comings and goings.
  const age = Math.max(0, now - presence.lastSeenAt);
  if (age < 60 * 60_000) return "Last seen recently";
  if (age < 24 * 60 * 60_000) return "Last seen today";
  if (age < 7 * 24 * 60 * 60_000) return "Last seen this week";
  return "Last seen a while ago";
}

export type MessageReceipt = "sent" | "seen";

// Posts arrive oldest first. Keep only the latest outgoing message and latest
// seen message marked; a seen icon replaces the sent icon on the same message.
export function latestMessageReceipts(posts: readonly Post[], me: string, members: readonly Person[] = []) {
  const agents = new Set(members.filter(person => person.agent).map(person => person.id));
  let latestSent: string | undefined;
  let latestSeen: string | undefined;
  for (let index = posts.length - 1; index >= 0; index--) {
    const post = posts[index]!;
    if (post.user.id !== me || post.user.agent || post.deleted || post.pending || post.activity) continue;
    latestSent ??= post.id;
    if (post.readBy?.some(receipt => receipt.userId && receipt.userId !== me && !agents.has(receipt.userId) && validTime(receipt.readAt))) {
      latestSeen = post.id;
      break;
    }
  }
  const receipts = new Map<string, MessageReceipt>();
  if (latestSent) receipts.set(latestSent, "sent");
  if (latestSeen) receipts.set(latestSeen, "seen");
  return receipts;
}
