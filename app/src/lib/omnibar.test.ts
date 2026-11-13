import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesQuery, omnibarShortcuts, searchExcerpt } from "./omnibar.ts";
import { ALL_FEATURES } from "./features.ts";

test("secure inbox is discoverable with team messaging off and hidden by its own flag", () => {
  const features = { ...ALL_FEATURES, channels: false, directMessages: false };
  assert.equal(omnibarShortcuts("inbox", false, features)[0]?.path, "/inbox");
  assert.equal(omnibarShortcuts("inbox", false, { ...features, secureInbox: false }).length, 0);
});

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

test("saved messages are discoverable as a personal checklist even when conversation features are hidden", () => {
  const off = { channels: false, directMessages: false, meetings: false, secureInbox: false };
  for (const query of ["saved", "later", "bookmark", "todo", "checklist"]) {
    assert.equal(omnibarShortcuts(query, false, off).find(item => item.id === "saved")?.path, "/saved");
  }
});

test("quick actions that lead to a feature the server turned off are not offered", () => {
  const ids = (features: { channels: boolean; directMessages: boolean; meetings: boolean; secureInbox: boolean }) => omnibarShortcuts("", true, features).map(item => item.id);
  const off = { channels: false, directMessages: false, meetings: false, secureInbox: false };
  assert.ok(ids({ ...off, channels: true, directMessages: true, meetings: true }).includes("new-message"));
  assert.deepEqual(ids(off).filter(id => ["new-message", "new-channel", "archive"].includes(id)), []);
  assert.deepEqual(ids({ ...off, channels: true }).filter(id => ["new-message", "new-channel", "archive"].includes(id)), ["new-channel", "archive"]);
  assert.deepEqual(ids({ ...off, directMessages: true }).filter(id => ["new-message", "new-channel", "archive"].includes(id)), ["new-message", "archive"]);
  assert.ok(ids(off).includes("agent") && ids(off).includes("members") && ids(off).includes("you"));
});

// Search lists four quick actions before anything is typed (Omnibar.tsx). Each new destination arrived at the top
// of the list and pushed Ask the agent and People out of those four.
test("the quick actions offered before typing are the everyday ones; newer destinations are still found by name", () => {
  for (const surveys of [false, true]) assert.deepEqual(omnibarShortcuts("", false, undefined, surveys).slice(0, 4).map(item => item.id), ["new-message", "new-channel", "agent", "members"]);
  assert.equal(omnibarShortcuts("saved", false)[0]?.id, "saved");
  assert.equal(omnibarShortcuts("survey", false, undefined, true)[0]?.id, "surveys");
  assert.equal(omnibarShortcuts("feedback queue", false, undefined, true)[0]?.id, "feedback-queue");
});

test("survey shortcuts require explicit server view permission for every role", () => {
  for (const owner of [true, false]) {
    assert.equal(omnibarShortcuts("surveys", owner).some(item => item.id === "surveys"), false);
    assert.equal(omnibarShortcuts("feedback queue", owner).some(item => item.id === "feedback-queue"), false);
    assert.equal(omnibarShortcuts("surveys", owner, undefined, true).some(item => item.id === "surveys"), true);
    assert.equal(omnibarShortcuts("feedback queue", owner, undefined, true).some(item => item.id === "feedback-queue"), true);
  }
});
