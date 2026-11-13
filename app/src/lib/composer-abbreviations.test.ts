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

test("messages underline abbreviations with a dotted line and a hover title", () => {
  const abbr = read("components/Abbr.tsx");
  assert.match(abbr, /createElement\("abbr", \{ title,/);
  assert.match(abbr, /textDecorationStyle: "dotted"/);
  assert.match(abbr, /cursor: "help"/);
  assert.match(composer, /withAbbreviations\(p, abbreviations\)/, "people's messages");
  assert.match(read("components/MessageText.tsx"), /part\.code \? part\.text : withAbbreviations\(part\.text, abbreviations\)/, "agent replies and the wiki, never code");
});
