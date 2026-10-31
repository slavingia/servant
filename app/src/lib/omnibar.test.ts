import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesQuery, omnibarShortcuts, searchExcerpt } from "./omnibar.ts";

test("omnibar matches channel/person prefixes and ignores case and outer whitespace", () => {
  assert.equal(matchesQuery(" #Budget ", "budget-review", "FY planning"), true);
  assert.equal(matchesQuery("@maya", "Maya Chen"), true);
  assert.equal(matchesQuery("budget planning", "budget-review", "FY planning"), true);
  assert.equal(matchesQuery("budget payroll", "budget-review", "FY planning"), false);
  assert.equal(matchesQuery("Élodie", "E\u0301LODIE"), true);
});

test("omnibar actions never offer invite management to members", () => {
  assert.equal(omnibarShortcuts("invite", false).some(item => item.id === "invite"), false);
  assert.equal(omnibarShortcuts("invite", true).some(item => item.id === "invite"), true);
  assert.equal(omnibarShortcuts("archive", false)[0]?.path, "/archived-channels");
});

test("message excerpts include matches deep in long text and collapse whitespace", () => {
  const result = searchExcerpt(`${"Earlier text. ".repeat(60)}THE BUDGET is ready. ${"Later text. ".repeat(50)}`, "the budget");
  assert.ok(result.startsWith("…"));
  assert.ok(result.includes("THE BUDGET"));
  assert.ok(result.endsWith("…"));
  assert.equal(searchExcerpt("Hello\n\nworld", "hello"), "Hello world");
});
