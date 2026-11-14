import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_CHOICES, historyLabel, peopleSummary } from "./chat-members.ts";

test("history choices match what the server takes", () => {
  assert.deepEqual(HISTORY_CHOICES.map(c => c.id), ["none", "day", "week", "all"]);
});

test("history label reads back what was given", () => {
  assert.equal(historyLabel({ since: 0, invitedAt: 5 }), "Sees the whole chat");
  assert.equal(historyLabel({ since: 1000, invitedAt: 1000 }), "Sees new messages only");
  assert.equal(historyLabel({ since: 1000, invitedAt: 1000 + 86_400_000 }), "Sees the last day before they joined");
  assert.equal(historyLabel({ since: 1000, invitedAt: 1000 + 7 * 86_400_000 }), "Sees the last seven days before they joined");
});

test("people summary spells out small numbers", () => {
  assert.equal(peopleSummary([]), "Just you");
  assert.equal(peopleSummary(["Jo"]), "Jo");
  assert.equal(peopleSummary(["Jo", "Ana"]), "Jo and Ana");
  assert.equal(peopleSummary(["Jo", "Ana", "Kim"]), "Jo and two others");
});
