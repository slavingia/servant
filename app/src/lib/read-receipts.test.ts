import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadReceiptQueue, mergeReadEvent } from "./read-receipts.ts";
import type { Post } from "./server.ts";

const post = (id: string, overrides: Partial<Post> = {}): Post => ({
  id, conversationId: "dm", user: { id: "other", name: "Other" }, threadRoot: null,
  text: "Hello", deleted: false, pending: false, replyCount: 0, lastReplyAt: null,
  createdAt: 1, editedAt: null, ...overrides,
});

test("only exact visible eligible messages are read while active", async () => {
  const sent: string[][] = [];
  const queue = createReadReceiptQueue({ conversationId: "dm", me: "me", send: async ids => { sent.push(ids); } });
  queue.setVisible([post("1"), post("2", { threadRoot: "1" }), post("3", { user: { id: "me", name: "Me" } }),
    post("4", { deleted: true }), post("5", { pending: true }), post("6", { activity: "joined" }),
    post("7", { user: { id: "agent", name: "Agent", agent: true } }), post("8", { conversationId: "elsewhere" }),
    post("9", { readBy: [{ userId: "me", readAt: 2 }] }), post("1")]);
  await queue.flush();
  assert.deepEqual(sent, [], "a background or unfocused list cannot record a read");
  queue.setActive(true);
  await queue.flush();
  await queue.flush();
  assert.deepEqual(sent, [["1", "2", "7"]], "thread replies are exact reads; completed agent replies clear unread counts; duplicate callbacks do not resend");
});

test("agent messages advance unread counts without acquiring human read receipts", async () => {
  const sent: string[][] = [];
  const queue = createReadReceiptQueue({ conversationId: "dm", me: "me", send: async ids => { sent.push(ids); } });
  const agent = { id: "agent", name: "Agent", agent: true };
  const complete = post("1", { user: agent });
  queue.setActive(true);
  queue.setVisible([complete, post("2", { user: agent, pending: true })]);
  await queue.flush();
  assert.deepEqual(sent, [["1"]], "the server owns receipt eligibility and uses completed agent reads for unread state");
  assert.equal(mergeReadEvent(complete, { conversationId: "dm", userId: "me", messageIds: ["1"], readAt: 10 }), complete);
});

test("updated data refreshes only observed IDs and removes deleted or absent rows", async () => {
  const sent: string[][] = [];
  const queue = createReadReceiptQueue({ conversationId: "dm", me: "me", send: async ids => { sent.push(ids); } });
  const agent = { id: "agent", name: "Agent", agent: true };
  queue.setVisible([post("1", { pending: true, user: agent }), post("2"), post("3")]);
  queue.refreshPosts([post("1", { user: agent }), post("2", { deleted: true }), post("4")]);
  queue.setActive(true);
  await queue.flush();
  assert.deepEqual(sent, [["1"]], "completion is observed, but unseen, deleted and absent IDs are never added");
  queue.setVisible([]);
  queue.refreshPosts([post("5")]);
  await queue.flush();
  assert.deepEqual(sent, [["1"]], "loading a new snapshot cannot restore a cleared visible set");
});

test("failed reads retry without acknowledging; rows scrolled away are not retried", async () => {
  const sent: string[][] = [];
  let failed = true;
  const queue = createReadReceiptQueue({ conversationId: "dm", me: "me", send: async ids => {
    sent.push(ids); if (failed) throw new Error("Offline");
  } });
  queue.setActive(true);
  queue.setVisible([post("1"), post("2")]);
  await queue.flush();
  assert.equal(queue.hasPending(), true);
  queue.setVisible([post("2")]);
  failed = false;
  await queue.flush();
  assert.equal(queue.hasPending(), false);
  queue.setVisible([post("1")]);
  await queue.flush();
  assert.deepEqual(sent, [["1", "2"], ["2"], ["1"]]);
});

test("in-flight requests are deduplicated and later batches stop on blur", async () => {
  const sent: string[][] = [];
  let finish: (() => void) | undefined;
  const queue = createReadReceiptQueue({ conversationId: "dm", me: "me", send: ids => {
    sent.push(ids); return new Promise<void>(resolve => { finish = resolve; });
  } });
  queue.setActive(true);
  queue.setVisible(Array.from({ length: 101 }, (_, i) => post(String(i + 1))));
  const running = queue.flush();
  await queue.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 100);
  queue.setActive(false);
  finish!();
  await running;
  assert.equal(sent.length, 1);
  queue.setActive(true);
  const resumed = queue.flush();
  assert.deepEqual(sent[1], ["101"]);
  finish!();
  await resumed;
});

test("disposing a route prevents pending and future reads", async () => {
  let sent = 0;
  const queue = createReadReceiptQueue({ conversationId: "dm", me: "me", send: async () => { sent++; } });
  queue.setActive(true);
  queue.setVisible([post("1")]);
  queue.dispose();
  queue.setActive(true);
  queue.setVisible([post("2")]);
  await queue.flush();
  assert.equal(sent, 0);
  assert.equal(queue.hasPending(), false);
});

test("read events preserve content, first-read times and conversation/message boundaries", () => {
  const original = post("1", { text: "Edited", editedAt: 20, attachments: [{ id: "a", name: "file", mime: "text/plain", size: 1 }] });
  const event = { conversationId: "dm", userId: "me", messageIds: ["1"], readAt: 50 };
  const read = mergeReadEvent(original, event);
  assert.equal(read.text, "Edited");
  assert.equal(read.attachments, original.attachments);
  assert.equal(read.editedAt, 20);
  assert.deepEqual(read.readBy, [{ userId: "me", readAt: 50 }]);
  assert.equal(mergeReadEvent(read, { ...event, readAt: 60 }), read);
  assert.deepEqual(mergeReadEvent(read, { ...event, readAt: 40 }).readBy, [{ userId: "me", readAt: 40 }]);
  for (const invalid of [{ ...event, conversationId: "other" }, { ...event, messageIds: ["2"] },
    { ...event, userId: "other" }, { ...event, readAt: NaN }]) assert.equal(mergeReadEvent(original, invalid), original);
  const deleted = post("1", { deleted: true });
  assert.equal(mergeReadEvent(deleted, event), deleted);
});
