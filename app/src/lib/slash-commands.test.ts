import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSlash, resolvePeople, slashMatches, splitDm } from "./slash-commands.ts";

test("the command list shows while typing a slash at the start, filtered", () => {
  assert.ok(slashMatches("/", true)!.length >= 8);
  assert.deepEqual(slashMatches("/in", true)!.map(c => c.name), ["invite"]);
  assert.equal(slashMatches("/in", false)!.length, 0, "channel commands hide in DMs");
  assert.equal(slashMatches("hello /in", true), null);
  assert.equal(slashMatches("/invite @m", true), null, "list closes once you add arguments");
});

test("commands parse; paths and unknown words stay ordinary messages", () => {
  assert.deepEqual(parseSlash("/invite @maya @sam", true)?.args, "@maya @sam");
  assert.equal(parseSlash("/TOPIC  Refund questions ", true)?.args, "Refund questions");
  assert.equal(parseSlash("/leave", true)?.name, "leave");
  assert.equal(parseSlash("/leave", false), null, "channel-only in a DM is just text");
  assert.equal(parseSlash("/usr/local/bin is the path", true), null);
  assert.equal(parseSlash("/notacommand hi", true), null);
  assert.equal(parseSlash("hi /invite @maya", true), null);
});

test("people resolve by @handle, full name or a unique first name", () => {
  const people = [{ id: "1", name: "Maya Ortiz" }, { id: "2", name: "Sam Patel" }, { id: "3", name: "Sam Lee" }, { id: "4", name: "José Núñez" }];
  const r = resolvePeople("@maya-ortiz, sam-lee @jose @sam nobody", people);
  assert.deepEqual(r.found.map(p => p.id), ["1", "3", "4"]);
  assert.deepEqual(r.unknown, ["@sam", "nobody"], "ambiguous first names and strangers are reported");
  assert.deepEqual(splitDm("@maya can you cover 2pm?"), { who: "@maya", message: "can you cover 2pm?" });
});
