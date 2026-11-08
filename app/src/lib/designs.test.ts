import test from "node:test";
import assert from "node:assert/strict";
import { canCreateDesign, designChatOptions, designChats, designCreationAccess, designCreationErrorMessage, designPreviewPublished, designReviewText, designStatus, designTitle, isVerifiedDesignChat, studyPrototypeChats } from "./designs.ts";
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

test("study prototype choices include only active published designs and retain library ordering", () => {
  const ready = chat("ready", { previewUrl: "https://example.test/ready/", updatedAt: 30 });
  const older = chat("older", { previewUrl: "https://example.test/older/", updatedAt: 10 });
  const draft = chat("draft", { updatedAt: 50 });
  const blankPreview = chat("blank", { previewUrl: "   ", updatedAt: 45 });
  const building = chat("building", {
    previewUrl: "https://example.test/building/",
    latestTurn: { status: "running" } as Chat["latestTurn"],
    updatedAt: 40,
  });
  const sharedBuilding = chat("shared-building", {
    previewUrl: "https://example.test/shared-building/",
    lastMessage: { role: "assistant", text: "Updating", at: 1, attachments: 0, pending: true },
    updatedAt: 39,
  });
  const archived = chat("archived", { archived: true, previewUrl: "https://example.test/archived/", updatedAt: 35 });
  const ordinary = chat("ordinary", { mode: undefined, previewUrl: "https://example.test/ordinary/", updatedAt: 60 });

  assert.deepEqual(
    studyPrototypeChats([older, draft, building, archived, ordinary], [ready, blankPreview, sharedBuilding]).map(item => item.id),
    ["ready", "older"],
  );
});

test("study prototype choices allow shared teammate designs and deduplicate them", () => {
  const shared = chat("shared", {
    title: "Shared prototype",
    previewUrl: "https://example.test/shared/",
    author: { id: "teammate", name: "Taylor" },
    readOnly: true,
    shared: true,
    updatedAt: 20,
  });
  const duplicateMine = { ...shared, author: undefined, readOnly: undefined, updatedAt: 10 } as Chat;

  const choices = studyPrototypeChats([duplicateMine], [shared]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].id, "shared");
  assert.equal(choices[0].author?.name, "Taylor");
  assert.equal(choices[0].readOnly, true);
});

test("design status follows the workspace state", () => {
  assert.equal(designStatus(chat("draft")), "Draft");
  assert.equal(designStatus(chat("ready", { previewUrl: "https://example.test/design/" })), "Published");
  assert.equal(designStatus(chat("reserved-url", { previewUrl: "https://example.test/design/", previewReady: false })), "Draft");
  assert.equal(designStatus(chat("published", { previewUrl: "https://example.test/design/", previewReady: true })), "Published");
  assert.equal(designStatus(chat("working", { previewUrl: "https://example.test/design/", latestTurn: { status: "running" } as Chat["latestTurn"] })), "Building");
  assert.equal(designStatus(chat("shared-working", { previewUrl: "https://example.test/design/", lastMessage: { role: "assistant", text: "Updating", at: 1, attachments: 0, pending: true } })), "Building");
  assert.equal(designStatus(chat("archived", { archived: true, latestTurn: { status: "running" } as Chat["latestTurn"] })), "Archived");
});

test("study prototype choices require a server-confirmed artifact when that signal is available", () => {
  const reserved = chat("reserved", { previewUrl: "https://example.test/reserved/", previewReady: false, updatedAt: 30 });
  const failed = chat("failed", { previewUrl: "https://example.test/failed/", previewReady: false, latestTurn: { status: "failed" } as Chat["latestTurn"], updatedAt: 29 });
  const stopped = chat("stopped", { previewUrl: "https://example.test/stopped/", previewReady: false, latestTurn: { status: "stopped" } as Chat["latestTurn"], updatedAt: 28 });
  const published = chat("published", { previewUrl: "https://example.test/published/", previewReady: true, updatedAt: 20 });
  const legacy = chat("legacy", { previewUrl: "https://example.test/legacy/", updatedAt: 10 });
  assert.deepEqual(studyPrototypeChats([reserved, failed, stopped, published, legacy], []).map(item => item.id), ["published", "legacy"]);
});

test("design creation follows the server's actual agent tier and setup", () => {
  assert.equal(canCreateDesign(2, true), true);
  assert.equal(canCreateDesign(3, true), true);
  assert.equal(canCreateDesign(4, true), true);
  assert.equal(canCreateDesign(undefined, true), true);
  assert.equal(canCreateDesign(4, false), false);
  assert.equal(canCreateDesign(null, true), false);
  assert.equal(designCreationAccess(2, true).canCreate, true);
  assert.equal(designCreationAccess(3, true).canCreate, true);
  assert.equal(designCreationAccess(1, true).canCreate, false);
  assert.equal(designCreationAccess(4, true).canCreate, true);
  assert.equal(designCreationAccess(3, false).canCreate, false);
  assert.equal(designCreationAccess(undefined, true).canCreate, true);
  assert.equal(designCreationAccess(null, true).canCreate, false);
});

test("Researcher prototype creation requests and verifies its separate agent lane", () => {
  assert.deepEqual(designChatOptions(4), { mode: "vibe", requiredAgentRole: "prototype" });
  assert.deepEqual(designChatOptions(3), { mode: "vibe" });
  assert.equal(isVerifiedDesignChat(chat("research-prototype", { agentRole: "prototype" }), 4), true);
  assert.equal(isVerifiedDesignChat(chat("wrong-lane", { agentRole: "researcher" }), 4), false);
  assert.equal(isVerifiedDesignChat(chat("legacy-design"), 3), true);
  assert.equal(isVerifiedDesignChat(chat("ordinary", { mode: undefined }), 4), false);
});

test("an older server fails closed with an actionable Researcher prototype message", () => {
  assert.match(designCreationErrorMessage(4, { status: 400, message: "requiredAgentRole must be researcher" }), /update Servant/);
  assert.match(designCreationErrorMessage(4, { status: 403, message: "forbidden" }), /confirm your access/);
  assert.equal(designCreationErrorMessage(3, { status: 403, message: "Designs are disabled" }), "Designs are disabled");
  assert.equal(designCreationErrorMessage(4), "Couldn't start a design");
});

test("review text is useful in clients that only understand plain messages", () => {
  const design = chat("refund", { title: "`Refund   status`", previewUrl: "https://example.test/refund/" });
  assert.equal(designTitle(design), "Refund status");
  assert.equal(designReviewText(design, "Check the mobile navigation"), [
    "Design review: Refund status",
    "Status: Published",
    "Preview: https://example.test/refund/",
    "Review focus: Check the mobile navigation",
    "Please leave feedback in this message's thread.",
  ].join("\n"));
});

test("a draft without a published page is never shared with a dead preview link", () => {
  const draft = chat("sketch", { title: "Sketch", previewUrl: "https://example.test/p/proto-ffffffffffffffffffff/", previewReady: false });
  assert.equal(designPreviewPublished(draft), false);
  assert.equal(designStatus(draft), "Draft");
  assert.match(designReviewText(draft), /^Preview: Not published yet$/m);
  assert.doesNotMatch(designReviewText(draft), /example\.test/);
  // Older servers don't report readiness: the established link is still used.
  assert.equal(designPreviewPublished(chat("old", { previewUrl: "https://example.test/old/" })), true);
  assert.equal(designPreviewPublished(chat("none", {})), false);
});
