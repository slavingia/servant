import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationPreview } from "./conversation-preview.ts";

const post = (over: Record<string, unknown> = {}) => ({ user: { id: "u2", name: "Bo Kim" }, text: "See you at ten", deleted: false, pending: false, attachments: [], ...over }) as never;
const conv = (lastMessage: unknown) => ({ lastMessage }) as never;

test("a one-to-one DM names who sent the last message", () => {
  assert.equal(conversationPreview(conv(post()), "me"), "Bo Kim: See you at ten");
});
test("your own message says You", () => {
  assert.equal(conversationPreview(conv(post({ user: { id: "me", name: "Ann Lee" } })), "me"), "You: See you at ten");
});
test("the agent is named too", () => {
  assert.equal(conversationPreview(conv(post({ user: { id: "agent", name: "Agent", agent: true }, text: "Hi Maya" })), "me"), "Agent: Hi Maya");
});
test("attachments, working replies, deletions, joins and empty conversations", () => {
  assert.equal(conversationPreview(conv(post({ text: "", attachments: [{}, {}] })), "me"), "Bo Kim: 2 attachments");
  assert.equal(conversationPreview(conv(post({ text: "", attachments: [{}] })), "me"), "Bo Kim: 1 attachment");
  assert.equal(conversationPreview(conv(post({ user: { id: "agent", name: "Agent", agent: true }, pending: true, text: "" })), "me"), "Agent: Working on it…");
  assert.equal(conversationPreview(conv(post({ deleted: true })), "me"), "Message deleted");
  assert.equal(conversationPreview(conv(post({ activity: "joined", text: "Bo joined" })), "me"), "Bo joined");
  assert.equal(conversationPreview(conv(null), "me"), "No messages yet");
});
