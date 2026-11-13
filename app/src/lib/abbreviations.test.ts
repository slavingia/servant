import { test } from "node:test";
import assert from "node:assert/strict";
import { expandAbbreviations, findAbbreviations, findUnknownAbbreviations, mergeGlossaryEntries, normalizeAbbreviation, type GlossaryEntry } from "./abbreviations.ts";

const entry = (abbreviation: string, fullName: string, id = abbreviation): GlossaryEntry => ({
  id, abbreviation, fullName, createdAt: 1, updatedAt: 1,
});
const api = entry("API", "Application Programming Interface");
const qa = entry("QA", "Quality Assurance");

test("finds many whole terms case-insensitively and preserves exact offsets", () => {
  const text = "Check API, qa; API! Unknown and rapid stay.";
  const found = findAbbreviations(text, [api, qa]);
  assert.deepEqual(found.map(({ token, start, end }) => ({ token, start, end })), [
    { token: "API", start: 6, end: 9 }, { token: "qa", start: 11, end: 13 }, { token: "API", start: 15, end: 18 },
  ]);
  assert.equal(found[0]!.entries[0], api);
  assert.equal(expandAbbreviations("API,\tqa\nAPI! unknown", [api, qa]), "Application Programming Interface,\tQuality Assurance\nApplication Programming Interface! unknown");
  assert.deepEqual(findAbbreviations("RAPID API2 API_suffix éAPI APIé 𠮷API API𠮷", [api]), []);
  assert.deepEqual(findAbbreviations("😀API", [api]).map(({ start, end }) => ({ start, end })), [{ start: 2, end: 5 }]);
});

test("ambiguous terms require an explicit meaning, including every repeated occurrence", () => {
  const other = entry("api", "Alternate Project Interface", "alternate");
  const entries = [api, other, qa];
  assert.deepEqual(findAbbreviations("API", entries)[0]!.entries, [api, other]);
  assert.equal(expandAbbreviations("API and QA", entries), "API and Quality Assurance");
  assert.equal(expandAbbreviations("API then api", entries, { API: "alternate" }), "Alternate Project Interface then Alternate Project Interface");
  assert.equal(expandAbbreviations("API", entries, { API: "missing-entry" }), "API");
  assert.equal(normalizeAbbreviation(" api "), "API");
});

test("replacement text is final output even when it contains another shortcut", () => {
  const rest = entry("RA", "REST API");
  const entries = [api, rest];
  const once = expandAbbreviations("RA and API", entries);
  assert.equal(once, "REST API and Application Programming Interface");
  assert.equal(expandAbbreviations(once, entries), once);
  assert.deepEqual(findAbbreviations("application programming interface (api)", entries), []);
});

test("replacement values are inserted exactly and do not recursively expand", () => {
  const value = "  Hello,\nAPI and QA!  ";
  const entries = [api, qa, entry("MSG", value)];
  assert.equal(expandAbbreviations("Before MSG After", entries), `Before ${value} After`);
  assert.equal(expandAbbreviations(value, entries), value);
  assert.deepEqual(findUnknownAbbreviations("AAA BBB", [entry("AB", "AAA BBB")]), []);
  assert.equal(expandAbbreviations("RA", [api, entry("RA", "API")]), "API");
  assert.equal(expandAbbreviations("API", [api, entry("RA", "API")]), "API", "a complete replacement remains final even when it is another shortcut's key");
  assert.deepEqual(findUnknownAbbreviations("FOOBAR", [entry("F", "FOO")]), ["FOOBAR"], "partial replacement words must not hide unrelated tokens");
});

test("blank and identity replacements cannot loop or hide unrelated matches", () => {
  const entries = [api, entry("AAA", "AAA"), entry("BBB", ""), entry("CCC", "  ")];
  assert.equal(expandAbbreviations("AAA BBB CCC API", entries), "AAA BBB CCC Application Programming Interface");
  assert.deepEqual(findAbbreviations("AAA BBB CCC", entries), []);
  assert.deepEqual(findUnknownAbbreviations("AAA", entries), []);
  const lowercase = [entry("AAA", "aaa")];
  assert.equal(expandAbbreviations("AAA", lowercase), "aaa");
  assert.deepEqual(findAbbreviations("aaa", lowercase), []);
});

test("legacy full-name expansions and nested replacement text remain intact", () => {
  const nested = entry("RA", "REST API");
  const entries = [api, nested];
  for (const text of ["REST API (RA)", "Application Programming Interface (API)s", "application programming interface (api)"]) {
    assert.equal(expandAbbreviations(text, entries), text);
  }
  assert.equal(expandAbbreviations("REST API (RA) API", entries), "REST API (RA) Application Programming Interface");
});

test("code, URLs, addresses, mentions, slash commands and link targets remain unchanged", () => {
  const text = [
    "`API` ``API ` QA``", "```js", "API; QA", "```", "~~~text", "API QA", "~~~",
    "https://example.gov/API?value=QA www.example.gov/QA example.gov/API",
    "API@example.gov @API /API/path API/route \\API",
    "/API QA arguments", "  /command API QA", "[API](relative/API_(QA))",
    "[QA][ref]", "[ref]: relative/API", "API and QA",
  ].join("\n");
  assert.deepEqual(findAbbreviations(text, [api, qa]).map(m => m.token), ["API", "QA", "API", "QA"]);
  const expanded = expandAbbreviations(text, [api, qa]);
  assert.ok(expanded.includes("[Application Programming Interface](relative/API_(QA))"));
  assert.ok(expanded.includes("[Quality Assurance][ref]"));
  assert.ok(expanded.includes("/API QA arguments\n  /command API QA"));
});

test("unfinished code and markdown destinations stay protected while typing", () => {
  assert.deepEqual(findAbbreviations("before `API and QA", [api, qa]), []);
  assert.deepEqual(findAbbreviations("~~~\nAPI QA", [api, qa]), []);
  assert.deepEqual(findAbbreviations("[label](relative/API", [api, qa]), []);
  assert.deepEqual(findAbbreviations("```\nAPI QA", [api, qa]), []);
});

test("literal punctuation and overlapping abbreviations choose the complete longest term", () => {
  const entries = [entry("C", "Example C"), entry("C++", "Example C Plus Plus"), entry("A.B.", "Example Dotted Term"), entry("ABC", "Example Short"), entry("ABC/DEF", "Example Combined"), entry("A-B", "Example Hyphenated")];
  assert.deepEqual(findAbbreviations("C++ C A.B. ABC/DEF ABC A-B", entries).map(m => m.token), ["C++", "C", "A.B.", "ABC/DEF", "ABC", "A-B"]);
  assert.equal(expandAbbreviations("C++", entries), "Example C Plus Plus");
  assert.deepEqual(findAbbreviations("C++X C++++ XA.B. ABC/UNKNOWN", entries), []);
});

test("empty dictionaries, unknown text, and repeated input records are safe", () => {
  assert.equal(expandAbbreviations("unchanged  text\n", []), "unchanged  text\n");
  assert.equal(expandAbbreviations("no known terms", [api]), "no known terms");
  assert.equal(expandAbbreviations("", [api]), "");
  assert.equal(expandAbbreviations("API", [api, api]), "Application Programming Interface");
  assert.deepEqual(findAbbreviations("API", [entry("", "Blank term"), entry("API", "")]), []);
});

test("common dotted abbreviations expand while dotted URLs and address destinations remain intact", () => {
  const dotted = [entry("U.S.", "Example region"), entry("Ph.D.", "Example degree"), api, qa];
  assert.deepEqual(findAbbreviations("U.S. Ph.D. API", dotted).map(match => match.token), ["U.S.", "Ph.D.", "API"]);
  assert.deepEqual(findAbbreviations("https://example.gov/U.S. (www.example.gov/API) example.gov?value=QA example.gov#API API@example.gov QA", dotted).map(match => match.token), ["QA"]);
});

test("long non-link pastes are scanned without quadratic retries or truncating the final term", () => {
  const text = `${"a.".repeat(32768)}1 ${"a".repeat(65536)} QA`;
  const start = performance.now();
  const matches = findAbbreviations(text, [qa]);
  const elapsed = performance.now() - start;
  assert.deepEqual(matches.map(match => match.token), ["QA"]);
  assert.equal(matches[0]!.end, text.length);
  // A generous regression ceiling: the old unanchored regexes took many seconds
  // on this input, while token scans take milliseconds. No text is discarded.
  assert.ok(elapsed < 3000, `Lookup took ${Math.round(elapsed)} ms`);
});

test("unknown uppercase terms are unique, ordered and bounded without matching partial words", () => {
  const text = "AAA BBB, AAA BBB. AA1 2FA A1 123 abc AbC ABCinside éABC ABCé 𠮷ABC ABC𠮷 ABCDEFGHIJKLMNOP ABCDEFGHIJKLMNOPQ";
  assert.deepEqual(findUnknownAbbreviations(text, []), ["AAA", "BBB", "ABCDEFGHIJKLMNOP"]);
  assert.deepEqual(findUnknownAbbreviations("😀XYZ AB-CD AB_CD AB++ U.S. XYZ...", []), ["XYZ", "AB-CD", "AB_CD"]);
});

test("unknown abbreviations start at three letters", () => {
  assert.deepEqual(findUnknownAbbreviations("QA PM AB U.S. A1B 2FA AA1 ABC A.B.C. AB3D", []), ["ABC", "A.B.C.", "AB3D"]);
  assert.deepEqual(findUnknownAbbreviations("PLEASE AND THE THIS WITH YES NO OK THANKS AAA", []), ["AAA"]);
  assert.deepEqual(findUnknownAbbreviations("", []), []);
});

test("unknown detection excludes every known meaning and complete canonical names", () => {
  const entries = [api, entry("api", "Alternate Interface", "alternate"), entry("AB-CD", "Combined"), entry("U.S.", "Example Region"), entry("AB", "AAA BBB")];
  assert.deepEqual(findUnknownAbbreviations("API api ApI AB-CD U.S. AAA BBB (AB) CCC", entries), ["CCC"]);
  assert.deepEqual(findUnknownAbbreviations("Some Name (AAA)", entries), ["AAA"], "unfamiliar explicit names can still be defined or skipped");
  assert.deepEqual(findUnknownAbbreviations("XYZ", [entry(" xyz ", "Known Name")]), []);
});

test("unknown detection shares code, URL, address, mention, command and link protections", () => {
  const text = [
    "`AAA` ``BBB ` CCC``", "```text", "DDD", "```", "~~~text", "EEE", "~~~",
    "https://example.gov/FFF www.example.gov/GGG HHH.example.gov III@example.gov @JJJ",
    "/command KKK", "  /LLL MMM", "path/NNN OOO/path \\PPP", "[QQQ](relative/RRR)",
    "[ref]: relative/SSS", "TTT",
  ].join("\n");
  assert.deepEqual(findUnknownAbbreviations(text, []), ["QQQ", "TTT"]);
  for (const text of ["`AAA", "```\nAAA", "~~~\nAAA", "[link](AAA"]) assert.deepEqual(findUnknownAbbreviations(text, []), []);
});

test("project definitions override all global meanings while preserving ambiguity within each scope", () => {
  const globalOther = entry("api", "Global Alternative", "global-other");
  const local = entry(" api ", "Project Interface", "project-api");
  const localOther = entry("API", "Project Alternative", "project-other");
  const globals = Object.freeze([api, globalOther, qa]);
  const projects = Object.freeze([local, localOther]);
  const merged = mergeGlossaryEntries(globals, projects);
  assert.deepEqual(merged, [qa, local, localOther]);
  assert.deepEqual(findAbbreviations("API", merged)[0]!.entries, [local, localOther]);
  assert.deepEqual(mergeGlossaryEntries(merged, projects), merged);
  assert.deepEqual(mergeGlossaryEntries(globals, []), globals);
  assert.deepEqual(mergeGlossaryEntries([], projects), projects);
  assert.deepEqual(globals, [api, globalOther, qa]);
});

test("the shared lexicon limit scans a moderate draft without dropping trailing terms", () => {
  const entries = Array.from({ length: 2000 }, (_, index) => entry(`TERM${index}`, `Example Term ${index}`));
  const text = `${"ordinary words and a little prose. ".repeat(1470)} TERM0 TERM1999 MYSTERY Example Term 1000 (TERM1000)`.slice(-50000);
  const start = performance.now();
  assert.deepEqual(findAbbreviations(text, entries).map(match => match.token), ["TERM0", "TERM1999"]);
  assert.deepEqual(findUnknownAbbreviations(text, entries), ["MYSTERY"]);
  assert.ok(performance.now() - start < 3000, "A 2,000-entry lexicon and 50,000-character draft should remain interactive");
});
