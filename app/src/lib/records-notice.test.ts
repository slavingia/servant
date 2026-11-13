import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deleteDescription } from "./records-notice.ts";

test("without preservation the wording is unchanged", () => {
  assert.match(deleteDescription("agent-chat", false), /permanently deletes your conversation with the agent/);
  assert.match(deleteDescription("dm", false), /permanently deletes the conversation and all its messages for everyone/);
  assert.match(deleteDescription("channel", false), /permanently deletes the channel/);
});

test("with preservation it never says permanently, erased or can't be undone, and it says a record is kept", () => {
  for (const kind of ["agent-chat", "dm", "channel", "meeting"] as const) {
    const text = deleteDescription(kind, true);
    assert.doesNotMatch(text, /permanently|can't be undone|\bdeleted?\b|\bdeletes\b/i, `${kind}: no false promise of erasure`);
    assert.match(text, /removes/, `${kind}: says it is removed from view`);
    assert.match(text, /keeps a record/, `${kind}: says a record is kept`);
  }
});

// The wording only helps if the screens use it. Guard the wiring so a screen cannot keep the old absolute claim.
test("the delete dialogs use the helper instead of hard-coded 'permanently deletes' text", () => {
  const root = path.join(import.meta.dirname, "..");
  for (const f of ["app/(tabs)/agent.tsx", "components/SwipeChannelRow.tsx", "app/meetings/[id].tsx"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.match(src, /deleteDescription\(/, `${f} uses deleteDescription`);
    assert.doesNotMatch(src, /This permanently deletes|are deleted\. Work already/, `${f} has no hard-coded deletion text`);
  }
});
