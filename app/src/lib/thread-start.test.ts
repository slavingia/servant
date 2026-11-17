import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { shownReplyCount, threadStart } from "./thread-start.ts";
import type { Conversation, Post } from "./server.ts";

const post = (extra: Partial<Post> = {}): Post => ({ id: "41", conversationId: "c1", user: { id: "u2", name: "Jo Park" }, threadRoot: null, text: "Shall we move the rehearsal?", deleted: false, pending: false, replyCount: 0, lastReplyAt: null, createdAt: 1763000000000, editedAt: null, ...extra });
const conversation = { id: "c1", kind: "channel", title: "general", members: [{ id: "u1", name: "Pat Tester" }, { id: "u2", name: "Jo Park" }] } as unknown as Conversation;

test("a thread opens with the message it was opened from, and the conversation's people", () => {
  const root = post({ replyCount: 3 });
  const start = threadStart(root, { conversation, joined: true });
  assert.equal(start.head, root);
  assert.equal(start.conversation, conversation, "the reply box can mention the people right away");
  assert.equal(start.joined, true);
  // The replies are not known yet: null says "loading", so the thread never claims there are none.
  assert.equal(start.replies, null);
});

test("a message nobody has replied to is the whole thread: nothing is left to load", () => {
  const start = threadStart(post({ replyCount: 0 }), { conversation, joined: true });
  assert.deepEqual(start.replies, []);
});

test("the reply count comes from the message until the replies are here, then from what is on screen", () => {
  assert.equal(shownReplyCount(post({ replyCount: 3 }), null, 0), 3);
  assert.equal(shownReplyCount(null, null, 0), 0);
  assert.equal(shownReplyCount(post({ replyCount: 3 }), [1, 2, 3, 4], 0), 4, "a reply that arrived since counts");
  // A reply still on its way counts once the list is known.
  assert.equal(shownReplyCount(post({ replyCount: 0 }), [], 1), 1);
});

test("the screens: a conversation hands its message to the thread, and the thread draws it before the replies", () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
  const conversationScreen = read("app/c/[id].tsx");
  assert.match(conversationScreen, /openingThread\(account, id, p, \{ conversation: conv, joined \}\); router\.push\(\{ pathname: "\/thread"/);
  const cache = read("lib/thread-cache.ts");
  assert.match(cache, /kept\.set\(id, before \? \{ \.\.\.before, head: root \} : threadStart\(root, from\)\);/);
  const thread = read("app/thread.tsx");
  // The spinner alone only when not even the first message is known (a push or a link).
  assert.match(thread, /replies === null && !head \? \(\n\s+<ServeLoader/);
  assert.match(thread, /ListFooterComponent=\{replies === null \? <ServeLoader/);
  assert.match(thread, /const replyCount = shownReplyCount\(head, replies, sending\.length\);/);
});
