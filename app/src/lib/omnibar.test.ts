import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesQuery, omnibarShortcuts, searchExcerpt } from "./omnibar.ts";
import { ALL_FEATURES, withDeepWork, type Features } from "./features.ts";

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
  const off = { channels: false, directMessages: false, secureInbox: false };
  for (const query of ["saved", "later", "bookmark", "todo", "checklist"]) {
    assert.equal(omnibarShortcuts(query, false, off).find(item => item.id === "saved")?.path, "/saved");
  }
});

test("quick actions that lead to a feature the server turned off are not offered", () => {
  const ids = (features: Features) => omnibarShortcuts("", true, features).map(item => item.id);
  const off = { channels: false, directMessages: false, secureInbox: false, people: true, home: false };
  assert.ok(ids({ ...off, channels: true, directMessages: true }).includes("new-message"));
  assert.deepEqual(ids(off).filter(id => ["new-message", "new-channel", "archive"].includes(id)), []);
  assert.deepEqual(ids({ ...off, channels: true }).filter(id => ["new-message", "new-channel", "archive"].includes(id)), ["new-channel", "archive"]);
  assert.deepEqual(ids({ ...off, directMessages: true }).filter(id => ["new-message", "new-channel", "archive"].includes(id)), ["new-message", "archive"]);
  assert.ok(ids(off).includes("agent") && ids(off).includes("members") && ids(off).includes("you"));
  // Deep work hides People and its invite from search too.
  const deep = ids(withDeepWork(ALL_FEATURES, true));
  assert.ok(!deep.includes("members") && !deep.includes("invite") && deep.includes("agent") && deep.includes("you"));
});

// Search lists four quick actions before anything is typed (Omnibar.tsx). Each new destination arrived at the top
// of the list and pushed Ask the agent and People out of those four.
test("the quick actions offered before typing are the everyday ones; newer destinations are still found by name", () => {
  assert.deepEqual(omnibarShortcuts("", false).slice(0, 4).map(item => item.id), ["new-message", "new-channel", "agent", "members"]);
  assert.equal(omnibarShortcuts("saved", false)[0]?.id, "saved");
});

test("removed team destinations are not offered", () => {
  for (const words of ["surveys", "feedback queue", "agent feed", "loops"]) assert.ok(!omnibarShortcuts(words, true).some(item => ["feedback", "feed", "loops"].includes(item.id)), words);
});

test("filters are told from words, so only messages are listed and the excerpt follows the words", async () => {
  const { splitSearch, SEARCH_FILTERS_HINT } = await import("./omnibar.ts");
  assert.deepEqual(splitSearch("budget review in:#general from:@Jo-Park has:link is:thread"), { words: "budget review", filtered: true });
  assert.deepEqual(splitSearch("in:general"), { words: "", filtered: true });
  assert.deepEqual(splitSearch("budget review"), { words: "budget review", filtered: false });
  // Not filters: a time, a link, an unknown has:.
  assert.deepEqual(splitSearch("10:30 https://example.gov has:cheese"), { words: "10:30 https://example.gov has:cheese", filtered: false });
  assert.deepEqual(splitSearch('"came in already" has:file'), { words: "came in already", filtered: true });
  assert.match(SEARCH_FILTERS_HINT, /in:#channel, from:@name, has:link, has:file or is:thread/);
  const fs = await import("node:fs");
  const path = await import("node:path");
  const box = fs.readFileSync(path.join(import.meta.dirname, "../components/Omnibar.tsx"), "utf8");
  assert.match(box, /const existing = filtered \? \[\] : conversations \?\? \[\];/);
  assert.match(box, /detail: searchExcerpt\(message\.text, words\)/);
  assert.match(box, /<Text style=\{styles\.hint\}>\{SEARCH_FILTERS_HINT\}<\/Text>/);
});
