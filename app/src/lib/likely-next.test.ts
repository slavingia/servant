import assert from "node:assert/strict";
import test from "node:test";
import { createWarmQueue, likelyNext } from "./likely-next.ts";
import { mergePosts } from "./post-list.ts";
import type { Post } from "./server.ts";

const row = (id: string, unread: number, updatedAt: number, archived = false) => ({ id, unread, updatedAt, archived });

test("what is likely to be opened next: unread first, newest first, then the most recently used", () => {
  const rows = [row("old-read", 0, 10), row("new-read", 0, 90), row("old-unread", 2, 20), row("new-unread", 1, 80), row("archived-unread", 5, 99, true), row("mid-read", 0, 50)];
  assert.deepEqual(likelyNext(rows, 4).map(r => r.id), ["new-unread", "old-unread", "new-read", "mid-read"]);
  assert.deepEqual(likelyNext(rows, 1).map(r => r.id), ["new-unread"]);
  assert.deepEqual(likelyNext(rows, 0), []);
  assert.deepEqual(likelyNext([], 4), []);
  // Nothing unread: the ones used most recently.
  assert.deepEqual(likelyNext([row("a", 0, 1), row("b", 0, 3), row("c", 0, 2)], 2).map(r => r.id), ["b", "c"]);
  // An agent chat's row has no unread field until something is unread.
  assert.deepEqual(likelyNext([{ id: "x", updatedAt: 5 }, { id: "y", updatedAt: 9, unread: 1 }, { id: "z", updatedAt: 7 }], 2).map(r => r.id), ["y", "z"]);
});

function fakeTimer() {
  let due: { run: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timer: { set: (run: () => void, ms: number) => { const entry = { run, ms, cleared: false }; due.push(entry); return entry; }, clear: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; } },
    /** The next timer fires. Returns the delay it was set with, or null when none is waiting. */
    fire() { const entry = due.shift(); if (!entry) return null; if (!entry.cleared) entry.run(); return entry.cleared ? -1 : entry.ms; },
    waiting: () => due.filter(entry => !entry.cleared).length,
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("things are loaded one at a time, after a pause, and each only once", async () => {
  const { timer, fire, waiting } = fakeTimer();
  const queue = createWarmQueue({ startMs: 1200, gapMs: 300, timer });
  const started: string[] = [];
  const finish: Record<string, () => void> = {};
  const load = (key: string) => () => { started.push(key); return new Promise<void>(resolve => { finish[key] = resolve; }); };
  assert.equal(queue.add("a", load("a")), true);
  assert.equal(queue.add("b", load("b")), true);
  assert.equal(queue.add("a", load("a")), false, "already asked for");
  assert.deepEqual(started, [], "nothing starts until the pause has passed");
  assert.equal(waiting(), 1);
  assert.equal(fire(), 1200);
  assert.deepEqual(started, ["a"]);
  assert.equal(waiting(), 0, "the second waits for the first to finish");
  finish.a!();
  await settle();
  assert.equal(fire(), 300);
  assert.deepEqual(started, ["a", "b"]);
  finish.b!();
  await settle();
  assert.equal(waiting(), 0);
  // Asked again later (the list was read again): still only once.
  assert.equal(queue.add("b", load("b")), false);
  assert.deepEqual(started, ["a", "b"]);
});

test("a load that fails does not stop the ones after it", async () => {
  const { timer, fire } = fakeTimer();
  const queue = createWarmQueue({ timer });
  const started: string[] = [];
  queue.add("a", async () => { started.push("a"); throw new Error("offline"); });
  queue.add("b", async () => { started.push("b"); });
  fire();
  await settle();
  fire();
  await settle();
  assert.deepEqual(started, ["a", "b"]);
});

test("nothing is loaded while the app is not in front; it looks again later", async () => {
  const { timer, fire } = fakeTimer();
  let front = false;
  const queue = createWarmQueue({ startMs: 1200, idle: () => front, timer });
  const started: string[] = [];
  queue.add("a", async () => { started.push("a"); });
  assert.equal(fire(), 1200);
  assert.deepEqual(started, []);
  front = true;
  assert.equal(fire(), 1200);
  assert.deepEqual(started, ["a"]);
});

test("a change of account drops what has not started and forgets what was asked for", async () => {
  const { timer, fire, waiting } = fakeTimer();
  const queue = createWarmQueue({ timer });
  const started: string[] = [];
  queue.add("a", async () => { started.push("a"); });
  queue.clear();
  assert.equal(waiting(), 0);
  fire();
  assert.deepEqual(started, []);
  assert.equal(queue.pending, 0);
  // The same id under the next account is loaded.
  assert.equal(queue.add("a", async () => { started.push("a again"); }), true);
  fire();
  await settle();
  assert.deepEqual(started, ["a again"]);
});

const post = (id: string, text = `message ${id}`): Post => ({ id, conversationId: "c1", user: { id: "u2", name: "Jo Park" }, threadRoot: null, text, deleted: false, pending: false, replyCount: 0, lastReplyAt: null, createdAt: 1763000000000 + Number(id), editedAt: null });

test("a message that arrives takes its place in order; one that changed is replaced", () => {
  const list = [post("10"), post("12"), post("15")];
  const merged = mergePosts(list, [post("11"), post("12", "edited"), post("20")]);
  assert.deepEqual(merged.map(p => [p.id, p.text]), [["10", "message 10"], ["11", "message 11"], ["12", "edited"], ["15", "message 15"], ["20", "message 20"]]);
  assert.equal(merged[0], list[0], "untouched messages are the same messages");
  assert.deepEqual(list.map(p => p.id), ["10", "12", "15"], "the list given is not changed");
  assert.deepEqual(mergePosts([], [post("9"), post("3")]).map(p => p.id), ["3", "9"]);
});

// The wiring: what is likely next is loaded ahead, kept conversations follow the live connection, and none of
// it marks anything read or outlives the account.
test("conversations and chats likely to be opened next are loaded ahead, and kept ones follow live messages", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
  const live = read("lib/live.tsx");
  assert.match(live, /useEffect\(\(\) => \{ if \(account && shown\) warmConversations\(account, shown\); \}, \[account, shown\]\);/);
  assert.match(live, /countLiveEvent\(e\);\n\s+\/\/ [^\n]+\n\s+followLive\(account, e\);/);
  assert.match(live, /warmChats\(account, list\);/);
  const conversations = read("lib/conversation-cache.ts");
  // A kept conversation takes in a message that arrives; a thread reply is not a message of the conversation.
  assert.match(conversations, /if \(post\.threadRoot\) return;/);
  assert.match(conversations, /kept\.update\(id, \{ \.\.\.snapshot, posts: page\.items, more: page\.more \}\);/);
  // When the stream starts over, messages may have been missed: nothing kept is trusted.
  assert.match(conversations, /if \(event\.data\.reset !== false\) \{ kept\.clear\(\); warm\.clear\(\); \}/);
  // Loaded only while the app is in front, a few at most, and dropped with the account.
  assert.match(conversations, /createWarmQueue\(\{ idle: \(\) => AppState\.currentState === "active" \}\)/);
  assert.match(conversations, /clearWithScreenCaches\(warm\);/);
  assert.match(conversations, /likelyNext\(conversations, WARM\)/);
  const chats = read("lib/chat-cache.ts");
  assert.match(chats, /clearWithScreenCaches\(warm\);/);
  // Only your own chats, never one the agent is still writing in, and never a reply in progress.
  assert.match(chats, /chats\.filter\(chat => !chat\.readOnly && !\(chat\.latestTurn && activeAgentTurn\(chat\.latestTurn\)\)\)/);
  assert.match(chats, /if \(messages\.some\(message => message\.pending\)\) return;/);
  // Loading ahead reads; it never tells the server anything was read.
  for (const source of [conversations, chats]) assert.doesNotMatch(source, /markMessagesRead|readChat|readAllChats/);
});
