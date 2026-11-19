// Abbreviations are never rewritten. A message goes exactly as typed; a known abbreviation is shown with a dotted
// underline, and hovering (or tapping, on a phone) shows what it stands for, like Wikipedia's <abbr>.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { abbreviationParts, abbreviationTitle } from "./abbreviation-marks.ts";
import type { GlossaryEntry } from "./abbreviations.ts";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const composer = read("components/Messaging.tsx");
const entry = (abbreviation: string, fullName: string, id = abbreviation): GlossaryEntry => ({ id, abbreviation, fullName, createdAt: 1, updatedAt: 1 });

test("a composer draws no abbreviations control", () => {
  assert.doesNotMatch(composer, /AbbreviationExpander|abbreviation-expander/);
  assert.equal(fs.existsSync(path.join(root, "components/AbbreviationExpander.tsx")), false, "the link and its dialog are gone");
});

test("nothing expands while typing, on Tab or on send", () => {
  assert.doesNotMatch(composer, /expandTypedAbbreviations|expandAbbreviationAtCursor|expandAbbreviations/);
  assert.equal(fs.existsSync(path.join(root, "lib/abbreviation-typing.ts")), false);
});

test("known abbreviations are marked without changing the words", () => {
  const entries = [entry("API", "Application programming interface"), entry("QA", "Quality assurance")];
  const text = "Ship the API to QA, then api docs";
  const parts = abbreviationParts(text, entries);
  assert.equal(parts.map(part => part.text).join(""), text);
  assert.deepEqual(parts.filter(part => part.title).map(part => [part.text, part.title]), [
    ["API", "API: Application programming interface"], ["QA", "QA: Quality assurance"], ["api", "api: Application programming interface"],
  ]);
  assert.deepEqual(abbreviationParts("no known terms", entries), [{ text: "no known terms" }]);
  assert.deepEqual(abbreviationParts("", entries), [{ text: "" }]);
});

test("a term with several meanings lists each once", () => {
  assert.equal(abbreviationTitle("PR", [entry("PR", "Pull request", "a"), entry("PR", "Public relations", "b"), entry("PR", "Pull request", "c")]), "PR: Pull request or Public relations");
});

test("a term with one meaning and a description explains itself", () => {
  const pr = { ...entry("PR", "pull request", "a"), description: "A proposed change to the code" };
  assert.equal(abbreviationTitle("PR", [pr]), "PR: pull request. A proposed change to the code");
  assert.equal(abbreviationTitle("PR", [pr, entry("PR", "Public relations", "b")]), "PR: pull request or Public relations");
});

test("messages underline abbreviations with a dotted line and a hover title", () => {
  const abbr = read("components/Abbr.tsx");
  assert.match(abbr, /createElement\("abbr", \{ title,/);
  assert.match(abbr, /textDecorationStyle: "dotted"/);
  assert.match(abbr, /cursor: "help"/);
  // People's messages, agent replies and the wiki are all drawn by MessageText: marked everywhere but in code.
  assert.match(composer, /if \(!parsed\) return <MessageText chat inMenuBubble text=\{text\} \/>;/, "people's messages");
  const drawn = read("components/MessageText.tsx");
  assert.match(drawn, /part\.code \? part\.text : plain\(part\.text, styles, abbreviations, mentions\)/, "never code");
  assert.match(drawn, /if \(!mentions \|\| !text\.includes\('@'\)\) return withAbbreviations\(text, abbreviations\);/);
  assert.match(drawn, /<Text key=\{i\}>\{withAbbreviations\(piece, abbreviations\)\}<\/Text>/, "beside a mention too");
});

test("a message drawn again is not marked again: the same words and glossary give back the same parts", () => {
  const entries = [entry("API", "Application programming interface"), entry("QA", "Quality assurance")];
  const text = "Ship the API to QA, then api docs";
  const first = abbreviationParts(text, entries);
  // Opening the conversation again, or scrolling back to the message, asks again.
  assert.equal(abbreviationParts(text, entries), first);
  assert.equal(first.map(part => part.text).join(""), text);
  // Other words are worked out on their own, and a new glossary (a new list) starts over.
  assert.notEqual(abbreviationParts("Ship the API", entries), first);
  const wider = [...entries, entry("DOCS", "Documentation")];
  const again = abbreviationParts(text, wider);
  assert.notEqual(again, first);
  assert.deepEqual(again.filter(part => part.title).map(part => part.text), ["API", "QA", "api", "docs"]);
  assert.deepEqual(abbreviationParts(text, entries).filter(part => part.title).map(part => part.text), ["API", "QA", "api"], "the first glossary still answers as it did");
  // What is kept is bounded: after many different messages the answers are still right.
  for (let i = 0; i < 2100; i++) abbreviationParts(`message ${i} about the API`, entries);
  assert.deepEqual(abbreviationParts(text, entries).map(part => part.text).join(""), text);
});
