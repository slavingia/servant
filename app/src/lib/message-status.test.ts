import { test } from "node:test";
import assert from "node:assert/strict";
import { groupPresenceDot, latestMessageReceipts, presenceDot, presenceLabel, statusTime } from "./message-status.ts";
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
  // Deep work (deep-work.ts) outranks online and last-seen, and holds while this app is offline.
  assert.equal(presenceLabel({ online: true, lastSeenAt: now, deepWork: true }, now), "Deep work");
  assert.equal(presenceLabel({ online: false, lastSeenAt: now - 3 * 24 * 60 * 60_000, deepWork: true }, now), "Deep work");
  assert.equal(presenceLabel({ deepWork: true }, now, false), "Deep work");
  assert.equal(presenceLabel({ online: true, lastSeenAt: now, deepWork: false }, now), "Online");
  assert.equal(presenceLabel({ online: true, lastSeenAt: now }, now, false), "Last seen recently");
  assert.equal(presenceLabel({}, now), "");
  assert.equal(presenceLabel({ lastSeenAt: null }, now), "");
  assert.equal(presenceLabel({ lastSeenAt: NaN }, now), "");
  assert.equal(presenceLabel({ lastSeenAt: now + 30_000 }, now), "Last seen recently");
  assert.equal(presenceLabel({ lastSeenAt: now - 60_000 }, now), "Last seen recently");
  assert.equal(presenceLabel({ lastSeenAt: now - 2 * 60_000 }, now), "Last seen recently");
  assert.equal(presenceLabel({ lastSeenAt: now - 2 * 60 * 60_000 }, now), "Last seen today");
  assert.equal(presenceLabel({ lastSeenAt: now - 3 * 24 * 60 * 60_000 }, now), "Last seen this week");
  assert.equal(presenceLabel({ lastSeenAt: now - 30 * 24 * 60 * 60_000 }, now), "Last seen a while ago");
});

test("the avatar badge: green only for someone available, a moon for deep work whether or not they're online", () => {
  assert.equal(presenceDot({ online: true, lastSeenAt: now }), "online");
  assert.equal(presenceDot({ online: true, lastSeenAt: now, deepWork: true }), "deepWork");
  assert.equal(presenceDot({ online: false, deepWork: true }), "deepWork");
  assert.equal(presenceDot({ online: true, lastSeenAt: now }, false), "off", "never online while disconnected");
  assert.equal(presenceDot({ online: false, lastSeenAt: now }), "off");
  assert.equal(presenceDot({}), "off");
  // A group: anyone available shows green; otherwise anyone quiet shows the moon.
  assert.equal(groupPresenceDot([{ online: false }, { online: true, deepWork: true }, { online: true }]), "online");
  assert.equal(groupPresenceDot([{ online: false }, { deepWork: true }]), "deepWork");
  assert.equal(groupPresenceDot([{ online: false }, {}]), "off");
  assert.equal(groupPresenceDot([]), "off");
});

test("receipt times retain the day and year for older messages", () => {
  const old = new Date(2025, 8, 1, 10).getTime();
  assert.match(statusTime(old, now), /2025/);
  assert.notEqual(statusTime(now - 86400_000, now), statusTime(now, now));
});

test("only the latest outgoing message gets a sent marker", () => {
  const newer = { ...post, id: "13" };
  const incoming = { ...post, id: "14", user: jordan };
  assert.deepEqual([...latestMessageReceipts([post, newer, incoming], "me")], [["13", "sent"]]);
  assert.equal(latestMessageReceipts([], "me").size, 0);
  assert.equal(latestMessageReceipts([incoming], "me").size, 0);
});

test("the latest seen marker remains while newer messages await reading", () => {
  const seen = { ...post, readBy: [{ userId: jordan.id, readAt: now }] };
  const newer = { ...post, id: "13" };
  const latest = { ...post, id: "14" };
  assert.deepEqual([...latestMessageReceipts([seen, newer, latest], "me")], [["14", "sent"], ["12", "seen"]]);
  const readLatest = { ...latest, readBy: seen.readBy };
  assert.deepEqual([...latestMessageReceipts([seen, newer, readLatest], "me")], [["14", "seen"]]);
});

test("newly loaded older messages and late receipts do not move markers backward", () => {
  const readBy = [{ userId: jordan.id, readAt: now }];
  const older = { ...post, id: "10", readBy: [{ userId: jordan.id, readAt: now + 1000 }] };
  const seen = { ...post, readBy };
  const latest = { ...post, id: "13" };
  assert.deepEqual([...latestMessageReceipts([older, seen, latest], "me")], [["13", "sent"], ["12", "seen"]]);
});

test("deleted, pending, activity, and agent messages never acquire receipt markers", () => {
  const readBy = [{ userId: jordan.id, readAt: now }];
  for (const excluded of [
    { ...post, user: jordan },
    { ...post, deleted: true },
    { ...post, pending: true },
    { ...post, activity: "joined" as const },
    { ...post, user: { ...me, agent: true } },
  ]) {
    assert.deepEqual([...latestMessageReceipts([post, { ...excluded, id: "13", readBy }], "me")], [["12", "sent"]]);
  }
});

test("seen requires a valid receipt from another human, including in groups", () => {
  const agent: Person = { id: "agent", name: "Agent", agent: true };
  const invalidReads = [
    { userId: me.id, readAt: now },
    { userId: agent.id, readAt: now },
    { userId: jordan.id, readAt: NaN },
    { userId: jordan.id, readAt: 0 },
    { userId: jordan.id, readAt: Infinity },
    { userId: "", readAt: now },
  ];
  const members = [me, jordan, sam, agent];
  assert.deepEqual([...latestMessageReceipts([{ ...post, readBy: invalidReads }], "me", members)], [["12", "sent"]]);
  for (const readers of [[jordan], [jordan, sam], [{ id: "former-member" }]]) {
    const readBy = [...invalidReads, ...readers.map(person => ({ userId: person.id, readAt: now }))];
    assert.deepEqual([...latestMessageReceipts([{ ...post, readBy }], "me", members)], [["12", "seen"]]);
  }
});
