import test from "node:test";
import assert from "node:assert/strict";
import { applySavedCompletion, savedMessageHref, savedMessagePreview, savedMessageSource, savedMessagesFor, visibleSavedMessages } from "./saved-messages.ts";
import type { SavedMessage } from "./server.ts";

const saved: SavedMessage = {
  messageId: "10", savedAt: 1000, completedAt: null,
  conversation: { id: "ch_example", kind: "channel", name: "example-app" },
  message: {
    id: "10", conversationId: "ch_example", user: { id: "pat", name: "Pat Tester" },
    text: "Review the release", threadRoot: null, deleted: false, pending: false,
    replyCount: 0, lastReplyAt: null, createdAt: 500, editedAt: null,
  },
};

test("keeps open and completed saves separate, without mutating server order", () => {
  const newer = { ...saved, messageId: "11", savedAt: 2000 };
  const done = { ...saved, messageId: "12", savedAt: 3000, completedAt: 4000 };
  const justDone = { ...saved, messageId: "13", savedAt: 100, completedAt: 5000 };
  const items = Object.freeze([done, newer, saved, justDone]);
  assert.deepEqual(savedMessagesFor(items, "open"), [newer, saved]);
  assert.deepEqual(savedMessagesFor(items, "completed"), [justDone, done]);
  assert.deepEqual(items, [done, newer, saved, justDone]);
  assert.deepEqual(savedMessagesFor([{ ...saved, completedAt: 0 }], "completed"), [{ ...saved, completedAt: 0 }]);
});

test("reopening an item returns it to its original saved position", () => {
  const other = { ...saved, messageId: "11", savedAt: 2000 };
  const completed = { ...saved, completedAt: 3000 };
  assert.deepEqual(savedMessagesFor([other, completed], "open"), [other]);
  assert.deepEqual(savedMessagesFor([other, { ...completed, completedAt: null }], "open"), [other, saved]);
});

test("opens old top-level posts and replies at the exact message using the thread route", () => {
  assert.deepEqual(savedMessageHref(saved), {
    pathname: "/thread", params: { conv: "ch_example", root: "10", focus: "10", from: "saved", title: "#example-app" },
  });
  const reply = { ...saved, conversation: { id: "dm_example", kind: "dm" as const, name: "Jo Park" }, message: { ...saved.message!, threadRoot: "7", conversationId: "dm_example" } };
  assert.deepEqual(savedMessageHref(reply), {
    pathname: "/thread", params: { conv: "dm_example", root: "7", focus: "10", from: "saved", title: "Jo Park" },
  });
});

test("unavailable or deleted sources never expose a stale preview or link", () => {
  for (const item of [
    { ...saved, message: null, conversation: null },
    { ...saved, conversation: null },
    { ...saved, message: { ...saved.message!, deleted: true } },
  ]) {
    assert.equal(savedMessageHref(item), null);
    assert.equal(savedMessagePreview(item), "This message is no longer available.");
  }
});

test("attachment-only saves display file names, and previews use current edited text", () => {
  const file = { id: "file", name: "release.pdf", mime: "application/pdf", size: 50 };
  assert.equal(savedMessagePreview({ ...saved, message: { ...saved.message!, text: "", attachments: [file] } }), "release.pdf");
  assert.equal(savedMessagePreview({ ...saved, message: { ...saved.message!, text: "Updated task", editedAt: 2000 } }), "Updated task");
});

test("hidden conversation types conceal content but keep the checklist reference", () => {
  const dm = { ...saved, conversation: { id: "dm_example", kind: "dm" as const, name: "Jo Park" } };
  const unavailable = { ...saved, message: null, conversation: null };
  const items = Object.freeze([saved, dm, unavailable]);
  assert.deepEqual(visibleSavedMessages(items, { channels: true, directMessages: false, meetings: true, secureInbox: true }), [saved, unavailable, unavailable]);
  assert.deepEqual(visibleSavedMessages(items, { channels: false, directMessages: true, meetings: true, secureInbox: true }), [unavailable, dm, unavailable]);
  assert.deepEqual(items, [saved, dm, unavailable]);
});

test("a late completion response cannot restore deleted, inaccessible, edited, or removed sources", () => {
  const staleResponse = { ...saved, completedAt: 4000 };
  const unavailable = { ...saved, message: null, conversation: null };
  assert.deepEqual(applySavedCompletion([unavailable], staleResponse), [{ ...unavailable, completedAt: 4000 }]);
  const edited = { ...saved, message: { ...saved.message!, text: "New instructions" } };
  assert.equal(applySavedCompletion([edited], staleResponse)[0]!.message!.text, "New instructions");
  assert.deepEqual(applySavedCompletion([], staleResponse), []);
});

// A direct message is named after the other person, so one they sent read "Jo Park · Jo Park".
test("the line under a saved message names where it is and who wrote it, once", () => {
  assert.equal(savedMessageSource(saved), "#example-app · Pat Tester");
  const dm = { ...saved, conversation: { id: "dm_1", kind: "dm" as const, name: "Jo Park" } };
  assert.equal(savedMessageSource({ ...dm, message: { ...saved.message!, user: { id: "jo", name: "Jo Park" } } }), "Jo Park");
  assert.equal(savedMessageSource(dm), "Jo Park · Pat Tester", "a message the reader sent in that conversation still says who wrote it");
  assert.equal(savedMessageSource({ ...saved, message: { ...saved.message!, threadRoot: "9" } }), "#example-app · Pat Tester · Thread");
  assert.equal(savedMessageSource({ ...saved, message: null }), null);
  assert.equal(savedMessageSource({ ...saved, conversation: null }), null);
});
