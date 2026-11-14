import assert from "node:assert/strict";
import test from "node:test";
import { reuseEqual } from "./reuse-equal.ts";

const person = (id: string, name: string) => ({ id, name, online: false });
const conversation = (id: string, unread = 0, text = "hello") => ({
  id, kind: "channel", title: `channel-${id}`, unread, archived: false, position: null as number | null,
  members: [person("u1", "Pat Tester"), person("u2", "Jo Park")],
  lastMessage: { id: `m-${id}`, text, user: person("u1", "Pat Tester"), reactions: [{ emoji: "👍", userIds: ["u2"] }], createdAt: 1763000000000 },
});
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

test("a refetched list that says the same thing is the same list", () => {
  const before = [conversation("1"), conversation("2"), conversation("3")];
  assert.equal(reuseEqual(before, copy(before)), before);
  assert.equal(reuseEqual(before, before), before);
  const empty: unknown[] = [];
  assert.equal(reuseEqual(empty, []), empty);
  assert.equal(reuseEqual(null, null), null);
});

test("one changed conversation is the only new row", () => {
  const before = [conversation("1"), conversation("2"), conversation("3")];
  const fetched = copy(before);
  fetched[1].unread = 4;
  fetched[1].lastMessage.text = "a new message";
  const after = reuseEqual(before, fetched);
  assert.notEqual(after, before);
  assert.deepEqual(after, fetched);
  assert.equal(after[0], before[0]);
  assert.equal(after[2], before[2]);
  assert.notEqual(after[1], before[1]);
  // Inside the changed row, what did not change is kept too.
  assert.equal(after[1].members, before[1].members);
  assert.equal(after[1].lastMessage.user, before[1].lastMessage.user);
  assert.equal(after[1].lastMessage.reactions, before[1].lastMessage.reactions);
});

test("a new, moved or removed row keeps the others, matched by id", () => {
  const before = [conversation("1"), conversation("2"), conversation("3")];
  const added = reuseEqual(before, [conversation("9"), ...copy(before)]);
  assert.equal(added.length, 4);
  assert.deepEqual(added.slice(1).map((row, i) => row === before[i]), [true, true, true]);
  const moved = reuseEqual(before, copy([before[2], before[0], before[1]]));
  assert.notEqual(moved, before);
  assert.deepEqual(moved.map(row => row.id), ["3", "1", "2"]);
  assert.equal(moved[0], before[2]);
  assert.equal(moved[1], before[0]);
  const removed = reuseEqual(before, copy([before[0], before[2]]));
  assert.deepEqual(removed.map(row => row.id), ["1", "3"]);
  assert.equal(removed[1], before[2]);
});

test("lists without ids are matched by place", () => {
  const before = [{ emoji: "👍", userIds: ["u1"] }, { emoji: "🎉", userIds: ["u2"] }];
  const after = reuseEqual(before, [{ emoji: "👍", userIds: ["u1"] }, { emoji: "🎉", userIds: ["u2", "u3"] }]);
  assert.equal(after[0], before[0]);
  assert.deepEqual(after[1].userIds, ["u2", "u3"]);
  assert.equal(reuseEqual(["a", "b"], ["a", "b", "c"]).length, 3);
  assert.deepEqual(reuseEqual(["a", "b", "c"], ["a", "b"]), ["a", "b"]);
});

test("a field that appears, disappears or changes type makes a new value", () => {
  const before = { id: "1", topic: "x", position: null as number | null };
  assert.deepEqual(reuseEqual(before, { id: "1", topic: "x", position: 2 }), { id: "1", topic: "x", position: 2 });
  const fewer = reuseEqual<Record<string, unknown>>(before, { id: "1", topic: "x" });
  assert.deepEqual(fewer, { id: "1", topic: "x" });
  assert.notEqual(fewer, before);
  const more = reuseEqual<Record<string, unknown>>(before, { id: "1", topic: "x", position: null, pinned: true });
  assert.deepEqual(more, { id: "1", topic: "x", position: null, pinned: true });
  assert.deepEqual(reuseEqual<unknown>({ a: 1 }, [1]), [1]);
  assert.deepEqual(reuseEqual<unknown>([1], { a: 1 }), { a: 1 });
  assert.equal(reuseEqual<unknown>({ a: 1 }, null), null);
  assert.equal(reuseEqual<unknown>("a", "b"), "b");
});

test("the result never shares the new copy's changed objects with the old value by mistake", () => {
  const before = { people: { u1: { userId: "u1", online: true }, u2: { userId: "u2", online: false } } };
  const after = reuseEqual(before, { people: { u1: { userId: "u1", online: true }, u2: { userId: "u2", online: true } } });
  assert.equal(after.people.u1, before.people.u1);
  assert.equal(after.people.u2.online, true);
  assert.equal(before.people.u2.online, false);
});
