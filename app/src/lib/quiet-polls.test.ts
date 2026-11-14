// Lists are read again and again: after every message, on every visit to a tab, every few seconds on the Agent
// tab and in an open agent chat. A copy that says what the last one said used to replace it all the same, and
// everything that showed it was drawn again. Each of these reads now keeps what did not change
// (lib/reuse-equal.ts), so a read that finds nothing new draws nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");

test("the Agent tab's five-second read keeps the chats that did not change", () => {
  const tab = read("app/(tabs)/agent.tsx");
  assert.match(tab, /setChats\(current => reuseEqual\(current, mine\)\);/);
  assert.match(tab, /setShared\(current => reuseEqual\(current, others\)\);/);
  assert.doesNotMatch(tab, /setChats\(mine\)|setShared\(others\)/);
});

test("reading the projects again tells the screens only when they changed", () => {
  const store = read("lib/projects-store.ts");
  assert.match(store, /const loaded = reuseEqual<Projects \| null>\(cache\.get\(who\) \?\? null, \{ list: r\.projects,/);
  assert.match(store, /const show = \(who: string, loaded: Projects \| null\) => \{ if \(state\.who !== who \|\| state\.loaded !== loaded\) emit\(\{ who, loaded \}\); \};/);
  // A screen that mounts and reads the projects does not redraw the other screens that show them.
  assert.doesNotMatch(store, /emit\(\{ who: activeWho, loaded: cache\.get\(activeWho\) \?\? null \}\)/);
});

test("the conversation list, presence and the unread count keep what a read did not change", () => {
  const live = read("lib/live.tsx");
  assert.match(live, /setConversations\(current => reuseEqual\(current, list\.map\(/);
  assert.match(live, /current\.identity === id && current\.count === total \? current : \{ identity: id, count: total \}/);
});
