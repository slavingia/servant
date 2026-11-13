import assert from "node:assert/strict";
import { test } from "node:test";
import { isContextSummary, withoutContextSummaries } from "./context-summary.ts";

test("context summaries are recognized by their end marker in any case", () => {
  assert.equal(isContextSummary("Earlier we discussed the budget.\n--- END OF CONTEXT SUMMARY ---"), true);
  assert.equal(isContextSummary("end of context summary"), true);
  assert.equal(isContextSummary("Here is a summary of the budget"), false);
  assert.equal(isContextSummary(undefined), false);
});

test("context summary messages are hidden and everything else keeps its order", () => {
  const messages = [
    { id: "1", text: "Hi" },
    { id: "2", text: "Recap\n=== END OF CONTEXT SUMMARY ===" },
    { id: "3" },
    { id: "4", text: "Thanks" },
  ];
  assert.deepEqual(withoutContextSummaries(messages).map(m => m.id), ["1", "3", "4"]);
});
