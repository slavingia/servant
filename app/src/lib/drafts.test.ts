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
