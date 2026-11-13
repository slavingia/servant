import { test } from "node:test";
import assert from "node:assert/strict";
import { groupActivity, nameList } from "./activity-groups.ts";
import type { Post } from "./server.ts";

const T = Date.UTC(2026, 10, 2, 15, 0);
let seq = 0;
const post = (name: string, overrides: Partial<Post> = {}): Post => ({
  id: String(++seq), conversationId: "c", user: { id: name.toLowerCase(), name }, threadRoot: null,
  text: "Hello", deleted: false, pending: false, replyCount: 0, lastReplyAt: null, createdAt: T, editedAt: null, ...overrides,
});
const joined = (name: string, minutes = 0) => post(name, { activity: "joined", text: `${name} joined the channel`, createdAt: T + minutes * 60000 });
const left = (name: string, minutes = 0) => post(name, { activity: "left", text: `${name} left the channel`, createdAt: T + minutes * 60000 });
const leftServant = (name: string, minutes = 0) => post(name, { activity: "left", text: `${name} left Servant`, createdAt: T + minutes * 60000 });
// Oldest first in, the list is newest first.
const lines = (oldestFirst: Post[]) => groupActivity([...oldestFirst].reverse()).reverse().map(p => p.text);

test("names read naturally", () => {
  assert.equal(nameList(["Ann"]), "Ann");
  assert.equal(nameList(["Ann", "Bo"]), "Ann and Bo");
  assert.equal(nameList(["Ann", "Bo", "Cy"]), "Ann, Bo and Cy");
  assert.equal(nameList(["Ann", "Bo", "Cy", "Di"]), "Ann, Bo and 2 others");
});

test("people joining together share one line", () => {
  assert.deepEqual(lines([joined("Ann Lee")]), ["Ann Lee joined the channel"]);
  assert.deepEqual(lines([joined("Ann Lee"), joined("Bo Park", 1)]), ["Ann Lee and Bo Park joined the channel"]);
  assert.deepEqual(lines([joined("Ann"), joined("Bo", 1), joined("Cy", 2)]), ["Ann, Bo and Cy joined the channel"]);
  assert.deepEqual(lines([joined("Ann"), joined("Bo"), joined("Cy"), joined("Di"), joined("Ed")]), ["Ann, Bo and 3 others joined the channel"]);
});

test("mixed joins and leaves, and someone who comes and goes", () => {
  assert.deepEqual(lines([joined("Ann"), joined("Bo"), left("Cy")]), ["Ann and Bo joined, and Cy left the channel"]);
  assert.deepEqual(lines([joined("Ann"), left("Ann", 5)]), ["Ann joined and left the channel"]);
  assert.deepEqual(lines([left("Ann"), joined("Ann", 5)]), ["Ann rejoined the channel"]);
  assert.deepEqual(lines([joined("Ann"), left("Bo"), left("Ann")]), ["Ann joined and left, and Bo left the channel"]);
});

test("a message, a long gap, a new day or leaving Servant starts a new line", () => {
  assert.deepEqual(lines([joined("Ann"), post("Ann", { createdAt: T + 60000 }), joined("Bo", 2)]), ["Ann joined the channel", "Hello", "Bo joined the channel"]);
  assert.deepEqual(lines([joined("Ann"), joined("Bo", 31)]), ["Ann joined the channel", "Bo joined the channel"]);
  assert.deepEqual(lines([joined("Ann"), joined("Bo", 25), joined("Cy", 50)]), ["Ann, Bo and Cy joined the channel"]);
  assert.deepEqual(lines([leftServant("Ann"), leftServant("Bo", 1), left("Cy", 2)]), ["Ann and Bo left Servant", "Cy left the channel"]);
});

test("the row keeps the oldest id and shows the newest time", () => {
  const a = joined("Ann"), b = joined("Bo", 3);
  const [row] = groupActivity([b, a]);
  assert.equal(row!.id, a.id);
  assert.equal(row!.createdAt, b.createdAt);
  assert.equal(row!.activity, "joined");
});

test("todo activity retains its words and stays separate from membership updates", () => {
  const added = post("Pat Tester", { activity: "todo", text: "Pat Tester added a to-do: Review the example plan", createdAt: T + 120000 });
  const done = post("Pat Tester", { activity: "todo", text: "The Agent completed a to-do: Review the example plan", createdAt: T + 180000 });
  assert.deepEqual(lines([joined("Jo Park"), joined("Ana Ruiz", 1), added, done]), [
    "Jo Park and Ana Ruiz joined the channel", added.text, done.text,
  ]);
});
