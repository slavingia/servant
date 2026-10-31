import type { Person, Post } from "./server";

export type PresenceStatus = { online?: boolean; lastSeenAt?: number | null };

const validTime = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime());

export function statusTime(at: number, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return time;
  const day = date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) });
  return `${day}, ${time}`;
}

export function presenceLabel(presence: PresenceStatus, now = Date.now(), connected = true) {
  if (presence.online && connected) return "Online";
  if (!validTime(presence.lastSeenAt)) return "";
  const age = Math.max(0, now - presence.lastSeenAt);
  if (age < 60_000) return "Last seen just now";
  if (age < 60 * 60_000) {
    const minutes = Math.floor(age / 60_000);
    return `Last seen ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  return `Last seen ${statusTime(presence.lastSeenAt, now)}`;
}

export function receiptStatus(post: Post, me: string, members: Person[] = [], now = Date.now()) {
  if (post.user.id !== me || post.user.agent || post.deleted || post.pending || post.activity) return null;
  const people = new Map(members.map(person => [person.id, person]));
  const reads = new Map<string, number>();
  for (const receipt of post.readBy ?? []) {
    if (receipt.userId === me || people.get(receipt.userId)?.agent || !validTime(receipt.readAt)) continue;
    reads.set(receipt.userId, Math.min(reads.get(receipt.userId) ?? Infinity, receipt.readAt));
  }
  const readers = [...reads].sort((a, b) => a[1] - b[1]).map(([userId, readAt]) => ({
    userId,
    name: people.get(userId)?.name || "A member",
    readAt,
  }));
  if (!readers.length) return { label: "Sent", read: false, readers, accessibilityLabel: "Sent" };
  const only = readers[0]!;
  const singlePeer = members.filter(person => !person.agent && person.id !== me).length === 1;
  const label = readers.length === 1
    ? `${singlePeer ? "Read" : `Read by ${only.name}`} · ${statusTime(only.readAt, now)}`
    : readers.length === 2 ? `Read by ${readers.map(reader => reader.name).join(" and ")}` : `Read by ${readers.length} people`;
  return {
    label,
    read: true,
    readers,
    accessibilityLabel: readers.map(reader => `Read by ${reader.name} at ${statusTime(reader.readAt, now)}`).join(". "),
  };
}
