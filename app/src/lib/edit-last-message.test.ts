import test from "node:test";
import assert from "node:assert/strict";
import { lastEditableMessage, shouldEditLastMessage } from "./edit-last-message.ts";
import type { Post } from "./server.ts";

const post: Post = {
  id: "9", conversationId: "conversation", user: { id: "me", name: "Pat Tester" },
  threadRoot: null, text: "First message", deleted: false, pending: false,
  replyCount: 0, lastReplyAt: null, createdAt: 1000, editedAt: null,
};
const emptyDraft = { text: "", attachmentCount: 0, busy: false, picking: false, listening: false, editing: false };

test("finds the latest own message by numeric id regardless of display order or timestamps", () => {
  const latest = { ...post, id: "10", createdAt: 500 };
  const incoming = { ...post, id: "11", user: { id: "other", name: "Jo Park" } };
  const posts = Object.freeze([latest, incoming, post]);
  assert.equal(lastEditableMessage(posts, "me"), latest);
  assert.equal(lastEditableMessage([...posts].reverse(), "me"), latest);
  assert.deepEqual(posts, [latest, incoming, post]);
});

test("skips unavailable, activity and agent messages while retaining the last editable one", () => {
  for (const excluded of [
    { ...post, deleted: true },
    { ...post, pending: true },
    { ...post, activity: "joined" as const },
    { ...post, activity: "left" as const },
    { ...post, user: { ...post.user, agent: true } },
  ]) {
    const newer = { ...excluded, id: "10" };
    assert.equal(lastEditableMessage([post, newer], "me"), post);
    assert.equal(lastEditableMessage([newer], "me"), undefined);
  }
});

test("returns no target for an empty history or messages belonging to someone else", () => {
  assert.equal(lastEditableMessage([], "me"), undefined);
  assert.equal(lastEditableMessage([post], "other"), undefined);
});

test("allows adding text to the latest attachment-only message", () => {
  const attachment = { ...post, id: "10", text: "", attachments: [{ id: "file", name: "image.png", mime: "image/png", size: 100 }] };
  assert.equal(lastEditableMessage([post, attachment], "me"), attachment);
});

test("plain Up Arrow starts editing only from an empty idle composer", () => {
  assert.equal(shouldEditLastMessage({ key: "ArrowUp" }, emptyDraft), true);
  for (const key of ["ArrowDown", "Enter", "Escape", "a"]) {
    assert.equal(shouldEditLastMessage({ key }, emptyDraft), false);
  }
});

test("draft text, whitespace and attachments are never replaced", () => {
  for (const text of ["A draft", " ", "\n", "\t"]) {
    assert.equal(shouldEditLastMessage({ key: "ArrowUp" }, { ...emptyDraft, text }), false);
  }
  assert.equal(shouldEditLastMessage({ key: "ArrowUp" }, { ...emptyDraft, attachmentCount: 1 }), false);
});

test("modified, repeated and composing keys preserve normal keyboard behavior", () => {
  for (const flag of ["altKey", "ctrlKey", "metaKey", "shiftKey", "repeat", "isComposing"] as const) {
    assert.equal(shouldEditLastMessage({ key: "ArrowUp", [flag]: true }, emptyDraft), false, flag);
  }
  assert.equal(shouldEditLastMessage({ key: "ArrowUp", keyCode: 229 }, emptyDraft), false);
});

test("sending, selecting attachments, dictation and an existing edit prevent replacement", () => {
  for (const state of ["busy", "picking", "listening", "editing"] as const) {
    assert.equal(shouldEditLastMessage({ key: "ArrowUp" }, { ...emptyDraft, [state]: true }), false, state);
  }
});
