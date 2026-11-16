import { test } from "node:test";
import assert from "node:assert/strict";
import { canChangeManager, everyoneUnder, managerChoices, orgLine, orgRows, reportsOf } from "./org-chart.ts";

// Ana (owner) > Jo > Pat, Sam; Ana > Riley. Lee's manager has left.
const people = [
  { id: "sam", name: "Sam Lee", managerId: "jo" },
  { id: "ana", name: "Ana Ruiz", owner: true },
  { id: "pat", name: "Pat Tester", managerId: "jo" },
  { id: "riley", name: "Riley Kim", managerId: "ana" },
  { id: "jo", name: "Jo Park", managerId: "ana" },
  { id: "lee", name: "Lee Chen", managerId: "gone" },
];

test("each manager is followed by their reports, A to Z, owners first", () => {
  assert.deepEqual(orgRows(people).map(r => [r.person.name, r.depth, r.reports]), [
    ["Ana Ruiz", 0, 2], ["Jo Park", 1, 2], ["Pat Tester", 2, 0], ["Sam Lee", 2, 0], ["Riley Kim", 1, 0], ["Lee Chen", 0, 0],
  ]);
  assert.deepEqual(reportsOf(people, "jo").map(p => p.name), ["Pat Tester", "Sam Lee"]);
});

test("a loop or a self-manager never drops or repeats anyone", () => {
  const loop = [{ id: "a", name: "A", managerId: "b" }, { id: "b", name: "B", managerId: "a" }, { id: "c", name: "C", managerId: "c" }];
  const rows = orgRows(loop);
  assert.deepEqual(rows.map(r => r.person.id).sort(), ["a", "b", "c"]);
  assert.equal(everyoneUnder(loop, "a").has("a"), false);
});

test("a manager is never chosen from the people under someone", () => {
  assert.deepEqual([...everyoneUnder(people, "ana")].sort(), ["jo", "pat", "riley", "sam"]);
  assert.deepEqual(managerChoices(people, "jo").map(p => p.name), ["Ana Ruiz", "Lee Chen", "Riley Kim"]);
  assert.deepEqual(managerChoices(people, "pat").map(p => p.name), ["Ana Ruiz", "Jo Park", "Lee Chen", "Riley Kim", "Sam Lee"]);
});

test("an owner or the current manager can change someone's manager; nobody changes their own or an owner's", () => {
  const pat = people[2], ana = people[1];
  assert.equal(canChangeManager(pat, { id: "ana", owner: true }), true);
  assert.equal(canChangeManager(pat, { id: "jo", owner: false }), true);
  assert.equal(canChangeManager(pat, { id: "sam", owner: false }), false);
  assert.equal(canChangeManager(pat, { id: "pat", owner: false }), false);
  assert.equal(canChangeManager(ana, { id: "ana", owner: true }), false);
});

test("the line beside a name", () => {
  assert.equal(orgLine(people[4], people, 2), "Reports to Ana Ruiz · 2 reports");
  assert.equal(orgLine(people[0], people, 0), "Reports to Jo Park");
  assert.equal(orgLine(people[1], people, 1), "1 report");
  assert.equal(orgLine(people[5], people, 0), "");
});
