import { test } from "node:test";
import assert from "node:assert/strict";
import { dropIndex, isChannelSort, moveId, sortChannels, withPositions } from "./channel-sort.ts";

const c = (id: string, o: Partial<{ title: string; unread: number; updatedAt: number; memberCount: number; position: number | null }> = {}) =>
  ({ id, title: id, unread: 0, updatedAt: 0, memberCount: 1, position: null, ...o });

test("recent puts unread channels first, then the latest activity", () => {
  const list = [c("a", { updatedAt: 3 }), c("b", { updatedAt: 1, unread: 2 }), c("c", { updatedAt: 5 }), c("d", { updatedAt: 0, unread: 1 })];
  assert.deepEqual(sortChannels(list, "recent").map(x => x.id), ["b", "d", "c", "a"]);
});

test("alphabetical ignores case and orders numbers naturally", () => {
  const list = [c("x1", { title: "release-10" }), c("x2", { title: "Design" }), c("x3", { title: "release-9" }), c("x4", { title: "apps" })];
  assert.deepEqual(sortChannels(list, "alphabetical").map(x => x.title), ["apps", "Design", "release-9", "release-10"]);
});

test("most members, ties A to Z", () => {
  const list = [c("b", { memberCount: 4 }), c("a", { memberCount: 4 }), c("z", { memberCount: 9 }), c("m", { memberCount: 1 })];
  assert.deepEqual(sortChannels(list, "members").map(x => x.id), ["z", "a", "b", "m"]);
});

test("custom follows saved positions; channels without one go last A to Z", () => {
  const list = [c("new-b"), c("x", { position: 1 }), c("new-a"), c("y", { position: 0 })];
  assert.deepEqual(sortChannels(list, "custom").map(x => x.id), ["y", "x", "new-a", "new-b"]);
});

test("moving and dropping rows", () => {
  assert.deepEqual(moveId(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveId(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
  const rows = [0, 44, 88, 132].map(y => ({ y, h: 44 }));
  assert.equal(dropIndex(rows, 0, 10), 0, "a small nudge stays put");
  assert.equal(dropIndex(rows, 0, 50), 1);
  assert.equal(dropIndex(rows, 0, 200), 3, "past the end lands last");
  assert.equal(dropIndex(rows, 3, -100), 1);
  assert.equal(dropIndex(rows, 3, -500), 0);
});

test("a fresh drag applies before the server confirms it", () => {
  const list = sortChannels(withPositions([c("a", { position: 0 }), c("b", { position: 1 })], ["b", "a"]), "custom");
  assert.deepEqual(list.map(x => x.id), ["b", "a"]);
  assert.equal(isChannelSort("members"), true);
  assert.equal(isChannelSort("size"), false);
});
