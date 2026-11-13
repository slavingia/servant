import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { emailLine } from "./person-email.ts";

test("nothing is shown unless the server checks email and sent the address", () => {
  assert.equal(emailLine({ email: "pat@example.gov", emailVerified: true }, false), null);
  assert.equal(emailLine({}, false), null);
});

test("a verified address shows plainly; an unverified or missing one gets the warning, in words", () => {
  assert.deepEqual(emailLine({ email: "pat@example.gov", emailVerified: true }, true), { text: "pat@example.gov", unverified: false, label: "pat@example.gov, verified" });
  assert.deepEqual(emailLine({ email: "pat@example.gov", emailVerified: false }, true), { text: "Not verified · pat@example.gov", unverified: true, label: "pat@example.gov, not verified" });
  assert.deepEqual(emailLine({ email: null }, true), { text: "No work email", unverified: true, label: "No work email added" });
});

test("the state is said before the address, so a long address is cut short and the state is not", () => {
  const line = emailLine({ email: "lee.okafor-hernandez.montgomery@example.gov", emailVerified: false }, true);
  assert.ok(line?.text.startsWith("Not verified"));
});

// The words only help if both places that show the address use them. Guard that wiring: the list row and the person
// sheet draw the same line, with the icon as the mark (no "!" typed in front) and without turning the whole line red.
test("People shows the same email line in the list and in the person sheet", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../app/(tabs)/members.tsx"), "utf8");
  assert.equal((source.match(/<EmailNote /g) ?? []).length, 2, "one component, used by the list row and the sheet");
  assert.doesNotMatch(source, /"! "/, "no exclamation mark typed in as an icon");
  const note = source.slice(source.indexOf("function EmailNote"), source.indexOf("export default function Members"));
  assert.match(note, /name="warning"/, "the warning icon is the mark");
  assert.doesNotMatch(note, /<Text[^>]*colors\.red/, "the words stay in the caption color");
});
