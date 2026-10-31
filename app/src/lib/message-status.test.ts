import { test } from "node:test";
import assert from "node:assert/strict";
import { presenceLabel, receiptStatus, statusTime } from "./message-status.ts";
import type { Person, Post } from "./server.ts";

const now = new Date(2026, 9, 30, 15, 45).getTime();
const me: Person = { id: "me", name: "Alex" };
const jordan: Person = { id: "jordan", name: "Jordan Lee" };
const sam: Person = { id: "sam", name: "Sam" };
const post: Post = {
  id: "12", conversationId: "dm", user: me, threadRoot: null, text: "Hello",
  deleted: false, pending: false, replyCount: 0, lastReplyAt: null, createdAt: now - 60_000, editedAt: null,
};

test("presence uses known times, handles clock skew and never implies online while disconnected", () => {
  assert.equal(presenceLabel({ online: true, lastSeenAt: now }, now), "Online");
  assert.equal(presenceLabel({ online: true, lastSeenAt: now }, now, false), "Last seen just now");
  assert.equal(presenceLabel({}, now), "");
  assert.equal(presenceLabel({ lastSeenAt: null }, now), "");
  assert.equal(presenceLabel({ lastSeenAt: NaN }, now), "");
  assert.equal(presenceLabel({ lastSeenAt: now + 30_000 }, now), "Last seen just now");
  assert.equal(presenceLabel({ lastSeenAt: now - 60_000 }, now), "Last seen 1 minute ago");
  assert.equal(presenceLabel({ lastSeenAt: now - 2 * 60_000 }, now), "Last seen 2 minutes ago");
  assert.equal(presenceLabel({ lastSeenAt: now - 2 * 60 * 60_000 }, now), `Last seen ${statusTime(now - 2 * 60 * 60_000, now)}`);
});

test("receipt times retain the day and year for older messages", () => {
  const old = new Date(2025, 8, 1, 10).getTime();
  assert.match(statusTime(old, now), /2025/);
  assert.notEqual(statusTime(now - 86400_000, now), statusTime(now, now));
});

test("only sent human messages have read status and missing evidence means Sent", () => {
  assert.equal(receiptStatus(post, "me", [me, jordan], now)?.label, "Sent");
  for (const excluded of [
    { ...post, user: jordan },
    { ...post, deleted: true },
    { ...post, pending: true },
    { ...post, activity: "joined" as const },
    { ...post, user: { ...me, agent: true } },
  ]) assert.equal(receiptStatus(excluded, "me", [me, jordan], now), null);
});

test("a direct-message receipt includes the read time and accessible reader identity", () => {
  const result = receiptStatus({ ...post, readBy: [{ userId: jordan.id, readAt: now }] }, "me", [me, jordan], now)!;
  assert.equal(result.label, `Read · ${statusTime(now, now)}`);
  assert.equal(result.accessibilityLabel, `Read by Jordan Lee at ${statusTime(now, now)}`);
  assert.equal(result.read, true);
});

test("group receipts preserve distinct readers and earliest evidence, excluding self and agents", () => {
  const agent = { id: "agent", name: "Agent", agent: true };
  const readBy = [
    { userId: me.id, readAt: now },
    { userId: agent.id, readAt: now },
    { userId: jordan.id, readAt: now + 1000 },
    { userId: jordan.id, readAt: now },
    { userId: sam.id, readAt: now + 2000 },
    { userId: "bad", readAt: NaN },
  ];
  const result = receiptStatus({ ...post, readBy }, "me", [me, jordan, sam, agent], now)!;
  assert.equal(result.label, "Read by Jordan Lee and Sam");
  assert.deepEqual(result.readers.map(reader => [reader.userId, reader.readAt]), [[jordan.id, now], [sam.id, now + 2000]]);
  const single = receiptStatus({ ...post, readBy: [{ userId: jordan.id, readAt: now }] }, "me", [me, jordan, sam], now)!;
  assert.equal(single.label, `Read by Jordan Lee · ${statusTime(now, now)}`);
});

test("large groups use a readable count with full reader details, and unknown readers have a safe fallback", () => {
  const readBy = [jordan, sam, { id: "unknown" }].map(person => ({ userId: person.id, readAt: now }));
  const result = receiptStatus({ ...post, readBy }, "me", [me, jordan, sam], now)!;
  assert.equal(result.label, "Read by 3 people");
  assert.equal(result.readers[2]?.name, "A member");
  assert.match(result.accessibilityLabel, /Jordan Lee/);
  assert.match(result.accessibilityLabel, /Sam/);
});
