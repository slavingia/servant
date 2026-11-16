import { test } from "node:test";
import assert from "node:assert/strict";
import { sortPeople } from "./people-sort.ts";

const p = (id: string, name: string, o: { online?: boolean; lastSeenAt?: number | null } = {}) => ({ id, name, ...o });
const ids = (list: { id: string }[]) => list.map(x => x.id);

test("name sorts A to Z, ignoring case", () => {
  assert.deepEqual(ids(sortPeople([p("b", "ben"), p("a", "Ana"), p("c", "Cy")], "name")), ["a", "b", "c"]);
});

test("last seen: online first, then most recent, then never seen A to Z", () => {
  const list = [p("never2", "Zed"), p("old", "Ana", { lastSeenAt: 100 }), p("on", "Ben", { online: true, lastSeenAt: 50 }), p("new", "Cy", { lastSeenAt: 900 }), p("never1", "Dee")];
  assert.deepEqual(ids(sortPeople(list, "seen")), ["on", "new", "old", "never1", "never2"]);
});

test("live presence beats the list the server sent earlier", () => {
  const list = [p("a", "Ana", { online: true, lastSeenAt: 10 }), p("b", "Ben", { lastSeenAt: 20 })];
  const live = { a: { online: false, lastSeenAt: 10 }, b: { online: true, lastSeenAt: 20 } };
  assert.deepEqual(ids(sortPeople(list, "seen", live)), ["b", "a"]);
});

test("when the connection is down nobody counts as online", () => {
  const list = [p("a", "Ana", { online: true, lastSeenAt: 10 }), p("b", "Ben", { lastSeenAt: 20 })];
  assert.deepEqual(ids(sortPeople(list, "seen", {}, false)), ["b", "a"]);
});

test("you are online to yourself, and the input is not changed", () => {
  const list = [p("a", "Ana", { lastSeenAt: 500 }), p("me", "Pat")];
  assert.deepEqual(ids(sortPeople(list, "seen", {}, true, "me")), ["me", "a"]);
  assert.deepEqual(ids(list), ["a", "me"]);
});

test("org chart: each manager is followed by their reports", () => {
  const team = [{ id: "pat", name: "Pat Tester", managerId: "jo" }, { id: "jo", name: "Jo Park", managerId: "ana" }, { id: "ana", name: "Ana Ruiz", owner: true }, { id: "sam", name: "Sam Lee", managerId: "ana" }];
  assert.deepEqual(sortPeople(team, "org").map(p => p.name), ["Ana Ruiz", "Jo Park", "Pat Tester", "Sam Lee"]);
});
