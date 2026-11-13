// The wiki replaced Text shortcuts in the sidebar: a tree of Markdown pages the team edits in place, with the
// shortcuts as its built-in Abbreviations page.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ABBREVIATIONS_PAGE, WIKI_MAX_DEPTH, wikiAskPlaceholder, wikiAncestors, wikiChange, wikiDepth, wikiEditedLine, wikiLanding, wikiOpened, wikiRows, type WikiPageSummary } from "./wiki.ts";

const page = (id: string, parentId: string | null, position: number, title = id): WikiPageSummary =>
  ({ id, parentId, title, position, createdAt: position, updatedAt: 0, updatedByName: null, version: 1, canDelete: true });
const pages = [page("guide", null, 1, "Team guide"), page("tools", "guide", 2, "Tools"), page("onboarding", "guide", 1, "Onboarding"), page("laptop", "onboarding", 1, "Laptop"), page("policies", null, 2, "Policies")];
const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");

test("the tree lists Abbreviations first, then each page under its parent in the server's order", () => {
  assert.deepEqual(wikiRows(pages).map(row => [row.depth, row.title, row.hasChildren, row.open]), [
    [0, "Abbreviations", false, false],
    [0, "Team guide", true, true],
    [1, "Onboarding", true, true],
    [2, "Laptop", false, false],
    [1, "Tools", false, false],
    [0, "Policies", false, false],
  ]);
  assert.deepEqual(wikiRows([]).map(row => [row.id, row.special]), [[ABBREVIATIONS_PAGE, true]], "an empty wiki still has its built-in page");
  assert.ok(wikiRows(pages).slice(1).every(row => !row.special));
});

test("closing a page hides what is under it, and only that", () => {
  const rows = wikiRows(pages, new Set(["onboarding"]));
  assert.deepEqual(rows.map(row => row.title), ["Abbreviations", "Team guide", "Onboarding", "Tools", "Policies"]);
  assert.equal(rows.find(row => row.id === "onboarding")!.open, false);
  assert.deepEqual(wikiRows(pages, new Set(["guide"])).map(row => row.title), ["Abbreviations", "Team guide", "Policies"]);
});

test("a page whose parent is gone, or that loops, is shown rather than lost", () => {
  assert.deepEqual(wikiRows([page("orphan", "deleted", 1, "Orphan")]).map(row => [row.title, row.depth]), [["Abbreviations", 0], ["Orphan", 0]]);
  assert.deepEqual(wikiRows([page("self", "self", 1, "Self")]).map(row => row.title), ["Abbreviations", "Self"]);
  assert.equal(wikiRows([page("blank", null, 1, "")])[1]!.title, "Untitled");
});

test("a page knows what it sits under, and opening it opens the branches that hide it", () => {
  assert.deepEqual(wikiAncestors(pages, "laptop").map(item => item.title), ["Team guide", "Onboarding"]);
  assert.deepEqual(wikiAncestors(pages, "guide"), []);
  assert.deepEqual(wikiAncestors(pages, "missing"), []);
  assert.deepEqual([wikiDepth(pages, "guide"), wikiDepth(pages, "laptop")], [1, 3]);
  assert.deepEqual([...wikiOpened(pages, "laptop", new Set(["guide", "onboarding", "policies"]))], ["policies"]);
  const loop = [page("a", "b", 1), page("b", "a", 1)];
  assert.equal(wikiAncestors(loop, "a").length, 1, "a loop in the data ends");
});

test("a wide window opens the first page the team wrote, or Abbreviations when there is none", () => {
  assert.equal(wikiLanding(pages), "guide");
  assert.equal(wikiLanding([]), ABBREVIATIONS_PAGE);
});

test("a save sends only what changed, with the version the person was looking at", () => {
  const current = { title: "Plan", body: "One", version: 4 };
  assert.equal(wikiChange(current, { title: "Plan", body: "One" }), null);
  assert.equal(wikiChange(current, { title: "  Plan ", body: "One" }), null);
  assert.deepEqual(wikiChange(current, { title: "Plan", body: "Two" }), { body: "Two", version: 4 });
  assert.deepEqual(wikiChange(current, { title: "The plan", body: "One" }), { title: "The plan", version: 4 });
  assert.deepEqual(wikiChange(current, { title: "", body: "" }), { title: "Untitled", body: "", version: 4 }, "a page always has a name");
});

test("a page says who last wrote it and when", () => {
  const now = new Date(2026, 10, 12, 15).getTime();
  assert.equal(wikiEditedLine({ updatedAt: new Date(2026, 10, 12, 9).getTime(), updatedByName: "Ana Ruiz" }, now), "Edited by Ana Ruiz · today");
  assert.equal(wikiEditedLine({ updatedAt: new Date(2026, 10, 3).getTime(), updatedByName: "Jo Park" }, now), "Edited by Jo Park · 3 Nov");
  assert.equal(wikiEditedLine({ updatedAt: new Date(2025, 11, 31).getTime(), updatedByName: null }, now), "Edited · 31 Dec 2025");
});

test("the limits are the server's", () => {
  const server = fs.readFileSync(path.join(import.meta.dirname, "../../../server/wiki.mjs"), "utf8");
  assert.equal(Number(/depth: (\d+)/.exec(server)![1]), WIKI_MAX_DEPTH);
  const drafts = fs.readFileSync(path.join(import.meta.dirname, "../../../server/wiki-draft.mjs"), "utf8");
  assert.equal(Number(/WIKI_REQUEST_LIMIT = (\d+)/.exec(drafts)![1]), Number(/testID="wiki-ask-input"[\s\S]*?maxLength=\{(\d+)\}/.exec(read("components/WikiPage.tsx"))![1]));
});

// The wiring: the sidebar's place, the old address, and the page that is the shortcuts.
test("Wiki takes Text shortcuts' place, and the old address lands on Abbreviations", () => {
  const destinations = read("lib/destinations.ts");
  assert.match(destinations, /\{ id: "wiki", label: "Wiki", icon: "book", path: "\/wiki", group: "team", sidebar: true, you: true,/);
  assert.doesNotMatch(destinations, /label: "Text shortcuts"/);
  assert.match(read("app/lexicon.tsx"), /<Redirect href=\{\{ pathname: "\/wiki", params: \{ page: "abbreviations" \} \}\} \/>/);
  assert.match(read("app/_layout.tsx"), /<Stack\.Screen name="wiki" options=\{\{ title: "Wiki", \.\.\.sidebarScreen \}\} \/>/);
  const screen = read("app/wiki.tsx");
  assert.match(screen, /open === ABBREVIATIONS_PAGE\s*\? <WikiAbbreviations account=\{account\}/, "the built-in page is the shortcuts list");
  assert.match(screen, /aria-expanded=\{row\.open\}/, "a branch says whether it is open");
  assert.match(screen, /aria-current=\{current \? "page" : undefined\}/, "the open page says so");
  assert.match(read("components/WikiAbbreviations.tsx"), /lexiconApi\.list\(account/, "still the shared shortcuts, which expand as people type");
});

// The owner asked for pages to be changed by asking Agent, so nobody has to type Markdown, and for subpages to be
// added from the tree, not from the page.
test("a page is changed by asking Agent: the draft is read first, and nothing is saved until Save", () => {
  const source = read("components/WikiPage.tsx");
  assert.match(source, /<TextInput testID="wiki-ask-input"/);
  assert.equal(source.match(/<TextInput/g)!.length, 1, "the only field is the request to Agent: no title or Markdown field");
  assert.match(source, /wikiApi\.draft\(account, page\.id, \{ instruction, \.\.\.\(draft \? \{ draft:/, "a second request carries on from the draft");
  assert.match(source, /const shown = draft \?\? page;/, "the draft is shown where the page was");
  assert.match(source, /<MessageText text=\{shown\.body\} \/>/, "read as a rendered page");
  assert.match(source, /This is Agent&apos;s draft\. Nothing is saved until you choose Save\./);
  assert.match(source, /const change = wikiChange\(\{ \.\.\.page, version: draft\.version \}, draft\);/, "saved against the version the draft was made from");
  assert.match(source, /reason\.code === "stale" \? reason\.details\.page/, "someone else's newer version is shown, not overwritten");
  assert.match(source, /\{!draft && page\.canDelete \? <Button label="Delete page" kind="danger"/);
});

test("the box suggests how to start an empty page and how to change a written one", () => {
  assert.match(wikiAskPlaceholder({ body: "  " }), /^What should this page say\?/);
  assert.match(wikiAskPlaceholder({ body: "Text" }), /^What should change\?/);
});

test("subpages are added from the tree, not from the page", () => {
  assert.doesNotMatch(read("components/WikiPage.tsx"), /subpage/i);
  const screen = read("app/wiki.tsx");
  assert.match(screen, /<IconButton icon="plus" label=\{`Add a page under \$\{row\.title\}`\} onPress=\{onAdd\} \/>/);
  assert.doesNotMatch(screen, /onAddSubpage|Add subpage/);
});

test("the tree sits on the page's own background, not a grey panel", () => {
  const tree = /\n  treeWide: \{([^\n]*)\},/.exec(read("app/wiki.tsx"))![1]!;
  assert.match(tree, /backgroundColor: colors\.background/);
  assert.doesNotMatch(tree, /colors\.surface/);
});
