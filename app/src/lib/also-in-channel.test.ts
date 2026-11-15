import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { alsoSendLabel, replyContext, showsInConversation, threadOf } from "./also-in-channel.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a conversation lists its own messages and replies also sent to it, not other replies", () => {
  assert.equal(showsInConversation({ threadRoot: null }), true);
  assert.equal(showsInConversation({ threadRoot: "4" }), false);
  assert.equal(showsInConversation({ threadRoot: "4", alsoInChannel: true }), true);
});

test("a reply shown in the conversation opens the thread it belongs to", () => {
  assert.equal(threadOf({ id: "9", threadRoot: "4" }), "4");
  assert.equal(threadOf({ id: "4", threadRoot: null }), "4");
});

test("the box names the channel, or the chat", () => {
  assert.equal(alsoSendLabel({ kind: "channel", name: "permits" }), "Also send to #permits");
  assert.equal(alsoSendLabel({ kind: "dm", name: null }), "Also send to this chat");
  assert.equal(alsoSendLabel(null), "Also send to this chat");
});

test("the line above the reply says who and what it answers, with whatever is left of it", () => {
  assert.equal(replyContext({ replyTo: { user: "Pat Tester", text: "Is the form ready?" } }), "Replied to Pat Tester: Is the form ready?");
  assert.equal(replyContext({ replyTo: { user: "Pat Tester", text: "" } }), "Replied to Pat Tester");
  assert.equal(replyContext({}), "Replied to a thread");
});

test("the screens use these rules", () => {
  const channel = read("../app/c/[id].tsx"), thread = read("../app/thread.tsx"), messaging = read("../components/Messaging.tsx"), api = read("./server.ts");
  assert.match(channel, /!showsInConversation\(p\)\) return;/, "a live reply also sent here is added to the list");
  assert.match(channel, /root: threadOf\(p\)/);
  assert.match(read("./conversation-cache.ts"), /if \(!showsInConversation\(post\)\) return;/);
  assert.match(thread, /accessibilityRole="checkbox" accessibilityState=\{\{ checked: also \}\}/);
  assert.match(thread, /confirmPii, also\)\);/, "the choice goes with the reply");
  assert.match(thread, /setAlso\(false\);/, "and is for one reply only");
  assert.match(api, /threadRoot && alsoInChannel \? \{ alsoInChannel: true \} : \{\}/, "only a thread reply can ask for it");
  assert.match(messaging, /onOpenThread \? replyContext\(post\) : "Also sent to the conversation"/, "what it answers in the conversation; that it was also sent, in the thread");
  assert.match(messaging, /onOpenThread && post\.alsoInChannel && !post\.deleted \? \(\n\s+<Pressable[^\n]+onPress=\{onOpenThread\} style=\{styles\.replies\}>\n\s+<Text style=\{styles\.repliesText\}>View thread<\/Text>/);
  assert.match(messaging, /Also sent to the conversation/);
});
