// Survey response labels (design audit): a row read "Needs review · open" above "11/11/2026" on a line of its own.
// The stored status is never shown as is, and the day reads the way it does on messages.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { responseMeta, surveyStatusLabels, surveyVisibilityLabels } from "./survey-labels.ts";

const now = new Date(2026, 10, 11, 15, 0).getTime();
const day = 24 * 60 * 60_000;

test("a response's line says its review state, status and day in words", () => {
  assert.equal(responseMeta({ visibility: "pending", status: "open", createdAt: now - 60_000 }, now), "Needs review · Open · Today");
  assert.equal(responseMeta({ visibility: "reviewed", status: "planned", createdAt: now - day }, now), "Reviewed · Planned · Yesterday");
  assert.equal(responseMeta({ visibility: "hidden", status: "resolved", createdAt: new Date(2026, 9, 2, 9, 0).getTime() }, now), "Hidden · Resolved · Oct 2");
});

test("every label starts with a capital", () => {
  for (const label of [...Object.values(surveyVisibilityLabels), ...Object.values(surveyStatusLabels)]) assert.match(label, /^[A-Z]/);
});

test("the queue shows the labels, not the stored status or a numeric date", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../app/queue.tsx"), "utf8");
  assert.match(source, /responseMeta\(response\)/);
  assert.doesNotMatch(source, /\{response\.status\}/, "the stored status ('open') is not shown as is");
  assert.doesNotMatch(source, /toLocaleDateString\(\)/, "no numeric date such as 11/11/2026");
});
