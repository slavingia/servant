import assert from "node:assert/strict";
import test from "node:test";

test("drafts are kept per conversation and cleared when emptied", async () => {
  const { getDraft, setDraft } = await import("./drafts.ts");
  setDraft("c:a", "half a thought");
  setDraft("c:b", "other");
  assert.equal(getDraft("c:a"), "half a thought");
  assert.equal(getDraft("c:b"), "other");
  setDraft("c:a", "   ");
  assert.equal(getDraft("c:a"), "");
  assert.equal(getDraft("c:b"), "other");
});

test("signing out one server clears only that server's drafts", async () => {
  const { getDraft, setDraft, clearDrafts } = await import("./drafts.ts");
  setDraft("account:first:user:c:same", "First server text");
  setDraft("account:second:user:c:same", "Second server text");
  await clearDrafts("first:user");
  assert.equal(getDraft("account:first:user:c:same"), "");
  assert.equal(getDraft("account:second:user:c:same"), "Second server text");
});
