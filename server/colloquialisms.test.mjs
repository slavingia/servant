import { test } from "node:test";
import assert from "node:assert/strict";
import { COLLOQUIALISMS, COLLOQUIALISM_DESCRIPTIONS, colloquialismPairs, withColloquialisms } from "./colloquialisms.mjs";

test("the group is off unless the workspace turns it on", () => {
  for (const raw of [undefined, null, false, "true", 1, {}, { enabled: "yes" }, []]) assert.equal(colloquialismPairs(raw), null);
  assert.equal(colloquialismPairs(true).tmmrw, "tomorrow");
  assert.equal(colloquialismPairs({ enabled: true }).lmk, "let me know");
});

test("a workspace can add its own pairs to the group, bounded and single-word", () => {
  const pairs = colloquialismPairs({ enabled: true, extra: { ACME: " Acme Corporation ", "two words": "no", bad: 3, empty: "" } });
  assert.equal(pairs.ACME, "Acme Corporation");
  assert.equal(pairs["two words"], undefined);
  assert.equal(pairs.bad, undefined);
  assert.equal(pairs.empty, undefined);
  assert.equal(Object.keys(colloquialismPairs({ enabled: true, extra: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`x${i}`, "y"])) })).length, Object.keys(COLLOQUIALISMS).length + 200);
});

test("shared shortcuts win over the built-in group, ignoring case", () => {
  const stored = [{ id: "a", abbreviation: "LMK", fullName: "Let me know!", canEdit: true }];
  assert.equal(withColloquialisms(stored, false), stored);
  const merged = withColloquialisms(stored, true);
  assert.deepEqual(merged.filter(item => item.abbreviation.toUpperCase() === "LMK").map(item => item.id), ["a"]);
  const tmmrw = merged.find(item => item.abbreviation === "tmmrw");
  assert.deepEqual({ ...tmmrw }, { id: "colloquial:TMMRW", abbreviation: "tmmrw", fullName: "tomorrow", createdAt: 0, updatedAt: 0, canEdit: false, builtIn: true });
  assert.equal(new Set(merged.map(item => item.id)).size, merged.length);
});

test("engineering words say what they are, not just what the letters stand for", () => {
  const merged = withColloquialisms([], true);
  const pr = merged.find(item => item.abbreviation === "PR");
  assert.equal(pr.fullName, "pull request");
  assert.match(pr.description, /proposed change to the code/);
  for (const key of Object.keys(COLLOQUIALISM_DESCRIPTIONS)) assert.ok(COLLOQUIALISMS[key], key);
  assert.equal("description" in merged.find(item => item.abbreviation === "lmk"), false);
});
