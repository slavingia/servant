import type { Person, Post } from "./server";
import { dayLabel } from "./time-label.ts";

export type PresenceStatus = { online?: boolean; lastSeenAt?: number | null; deepWork?: boolean };

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
  // Deep work (deep-work.ts) is a choice, not a heartbeat: it shows whether or not they're online right now.
  if (presence.deepWork) return "Deep work";
  if (presence.online && connected) return "Online";
  if (!validTime(presence.lastSeenAt)) return "";
  // Deliberately vague (never an exact time): people shouldn't be able to track each other's comings and goings.
  const age = Math.max(0, now - presence.lastSeenAt);
  if (age < 60 * 60_000) return "Last seen recently";
  if (age < 24 * 60 * 60_000) return "Last seen today";
  if (age < 7 * 24 * 60 * 60_000) return "Last seen this week";
  return "Last seen a while ago";
}

export type PresenceDotState = "online" | "deepWork" | "off";

/** The badge on an avatar's corner: deep work (deep-work.ts) wins over a heartbeat, so a quiet person never reads as available. */
export function presenceDot(presence: PresenceStatus, connected = true): PresenceDotState {
  if (presence.deepWork) return "deepWork";
  return presence.online && connected ? "online" : "off";
}

/** One badge for several people (a group direct message): someone available shows green; failing that, someone quiet shows the moon. */
export function groupPresenceDot(people: readonly PresenceStatus[], connected = true): PresenceDotState {
  const states = people.map(person => presenceDot(person, connected));
  return states.includes("online") ? "online" : states.includes("deepWork") ? "deepWork" : "off";
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
