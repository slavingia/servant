// What came back after an ask, and how asks and checklist items are picked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshReplies, logAsk, pickOne, postArgs } from "./handoff.ts";

const me = "usr_me";
const msg = (id: string, user: string, extra = {}) => ({ id, text: id, user: { id: user, name: user }, ...extra });

test("replies are what other people sent after the ask, never your own or deleted messages", () => {
  const messages = [msg("1", "usr_pat"), msg("2", me), msg("3", "usr_pat"), msg("4", me), msg("5", "usr_jo", { deleted: true }), msg("6", "usr_jo")];
  assert.deepEqual(freshReplies(messages, "2", me).map(m => m.id), ["3", "6"]);
  assert.deepEqual(freshReplies(messages, "6", me), [], "nothing after the marker");
  assert.deepEqual(freshReplies(messages, null, me).map(m => m.id), ["1", "3", "6"], "no marker yet: everything from others is new");
  assert.deepEqual(freshReplies(messages, "gone", me).map(m => m.id), ["1", "3", "6"], "a marker that is no longer in the page is treated as none");
});

test("logging an ask again moves its marker and keeps its context; other asks are untouched", () => {
  const first = logAsk([], { conv: "dm_1", feature: "Dark mode", who: "Pat Tester", context: "branch dark-mode", seen: "10", at: "t1" });
  const other = logAsk(first, { conv: "dm_2", feature: "Dark mode", who: "Jo Park", seen: "11", at: "t2" });
  const again = logAsk(other, { conv: "dm_1", feature: "Dark mode", who: "Pat Tester", seen: "20", at: "t3" });
  assert.equal(again.length, 2);
  assert.deepEqual(again.find(a => a.conv === "dm_1"), { conv: "dm_1", feature: "Dark mode", who: "Pat Tester", context: "branch dark-mode", seen: "20", at: "t3" });
  assert.equal(again.find(a => a.conv === "dm_2")!.context, "");
});

test("a release or item is picked by id, date or part of its name, and only when exactly one matches", () => {
  const releases = [{ id: "rel_1", name: "November 17", date: "2026-11-17" }, { id: "rel_2", name: "December 1", date: "2026-12-01" }];
  assert.equal(pickOne(releases, "rel_2", "release").id, "rel_2");
  assert.equal(pickOne(releases, "2026-11-17", "release").id, "rel_1");
  assert.equal(pickOne(releases, "december", "release").id, "rel_2");
  assert.throws(() => pickOne(releases, "ember", "release"), /"ember" matched 2: November 17, December 1/);
  assert.throws(() => pickOne(releases, "March", "release"), /matched 0/);
});

test("post takes the text, an optional thread root, and files after --attach", () => {
  assert.deepEqual(postArgs(["dm_1", "hello"]), { conv: "dm_1", text: "hello", files: [] });
  assert.deepEqual(postArgs(["dm_1", "hello", "42", "--attach", "a.png", "b.png"]), { conv: "dm_1", text: "hello", threadRoot: "42", files: ["a.png", "b.png"] });
  assert.deepEqual(postArgs(["dm_1", "hello", "--attach", "a.png"]), { conv: "dm_1", text: "hello", files: ["a.png"] });
  assert.throws(() => postArgs(["dm_1"]), /needs a conversation id and the text/);
});
