import test from "node:test";
import assert from "node:assert/strict";
import { designChats, designCreationAccess, designReviewText, designStatus, designTitle } from "./designs.ts";
import type { Chat } from "./server.ts";

const chat = (id: string, change: Partial<Chat> = {}) => ({
  id,
  title: `Design ${id}`,
  mode: "vibe",
  createdAt: 1,
  updatedAt: 1,
  ...change,
}) as Chat;

test("the library keeps only designs, removes duplicates and sorts newest first", () => {
  const old = chat("old", { updatedAt: 10 });
  const recent = chat("recent", { updatedAt: 30 });
  const ordinary = chat("chat", { mode: undefined, updatedAt: 40 });
  assert.deepEqual(designChats([old, ordinary], [recent, old]).map(item => item.id), ["recent", "old"]);
});

test("design status follows the workspace state", () => {
  assert.equal(designStatus(chat("draft")), "Draft");
  assert.equal(designStatus(chat("ready", { previewUrl: "https://example.test/design/" })), "Ready for review");
  assert.equal(designStatus(chat("working", { previewUrl: "https://example.test/design/", latestTurn: { status: "running" } as Chat["latestTurn"] })), "Building");
  assert.equal(designStatus(chat("archived", { archived: true, latestTurn: { status: "running" } as Chat["latestTurn"] })), "Archived");
});

test("design creation follows the server's actual agent tier and setup", () => {
  assert.equal(designCreationAccess(2, true).canCreate, true);
  assert.equal(designCreationAccess(3, true).canCreate, true);
  assert.equal(designCreationAccess(1, true).canCreate, false);
  assert.equal(designCreationAccess(4, true).canCreate, false);
  assert.equal(designCreationAccess(3, false).canCreate, false);
  assert.equal(designCreationAccess(undefined, true).canCreate, true);
  assert.equal(designCreationAccess(null, true).canCreate, false);
});

test("review text is useful in clients that only understand plain messages", () => {
  const design = chat("refund", { title: "`Refund   status`", previewUrl: "https://example.test/refund/" });
  assert.equal(designTitle(design), "Refund status");
  assert.equal(designReviewText(design, "Check the mobile navigation"), [
    "Design review: Refund status",
    "Status: Ready for review",
    "Preview: https://example.test/refund/",
    "Review focus: Check the mobile navigation",
    "Please leave feedback in this message's thread.",
  ].join("\n"));
});
