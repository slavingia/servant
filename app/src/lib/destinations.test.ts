// One list of places (information architecture). The sidebar, You and search each kept their own, so one place had
// two names ("Saved" and "Saved messages"), search could not find To-dos, Meetings or Text shortcuts, and both lists
// were long and flat: ten rows in the sidebar, ten on You.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DESTINATIONS, destinationGroups, placeIsOpen, reachable } from "./destinations.ts";
import { ALL_FEATURES } from "./features.ts";
import { omnibarShortcuts } from "./omnibar.ts";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const everyone = { features: ALL_FEATURES, owner: true, canViewSurveys: true };
const member = { features: ALL_FEATURES, owner: false, canViewSurveys: false };
const labels = (where: "sidebar" | "you", viewer = everyone) => destinationGroups(where, viewer).map(entry => [entry.title, entry.places.map(place => place.label)]);

test("every place has one name, its own icon and its own address", () => {
  for (const key of ["id", "label", "icon", "path"] as const) assert.equal(new Set(DESTINATIONS.map(place => place[key])).size, DESTINATIONS.length, `no two places share a ${key}`);
  const icons = read("components/AppIcon.tsx");
  for (const place of DESTINATIONS) assert.match(icons, new RegExp(`\\n  ${place.icon}: "`), `${place.icon} is in the shared icon set`);
});

test("the sidebar is three short groups: where people talk, your work, the team", () => {
  assert.deepEqual(labels("sidebar"), [
    ["Conversations", ["Home", "Agent", "Chats", "Cases"]],
    ["Your work", ["To-dos", "Saved", "Meetings"]],
    ["Team", ["People", "Surveys", "Feedback queue", "Wiki"]],
  ]);
});

test("You lists the same places under the same names, plus the ones a wide window reaches from You", () => {
  assert.deepEqual(labels("you"), [
    ["Conversations", ["Cases"]],
    ["Your work", ["To-dos", "Saved", "Meetings", "Archived"]],
    ["Team", ["People", "Invite people", "Surveys", "Feedback queue", "Wiki", "Loops", "Agent usage"]],
  ]);
  assert.deepEqual(labels("you", member), [
    ["Conversations", ["Cases"]],
    ["Your work", ["To-dos", "Saved", "Meetings", "Archived"]],
    ["Team", ["People", "Wiki", "Loops", "Agent usage"]],
  ], "a member sees no invites and, without the role, no surveys");
});

test("a place a server has turned off is not offered anywhere", () => {
  const quiet = { ...everyone, features: { channels: false, directMessages: false, meetings: false, secureInbox: false } };
  assert.deepEqual(labels("sidebar", quiet)[0], ["Conversations", ["Agent"]]);
  assert.ok(!destinationGroups("you", quiet).flatMap(entry => entry.places).some(place => ["Meetings", "Archived", "Cases"].includes(place.label)));
  const noCases = { ...everyone, features: { ...ALL_FEATURES, secureInbox: false } };
  assert.deepEqual(labels("sidebar", noCases)[0], ["Conversations", ["Home", "Agent", "Chats"]], "Cases follows its own switch");
  assert.ok(!destinationGroups("you", noCases).some(entry => entry.title === "Conversations"), "and a group with nothing in it is left out");
  assert.equal(reachable(DESTINATIONS.find(place => place.id === "archive")!, { ...everyone, features: { ...ALL_FEATURES, channels: false } }), true, "the archive needs channels or direct messages");
});

test("the sidebar marks the place that is open, including the screens under it", () => {
  const place = (id: string) => DESTINATIONS.find(item => item.id === id)!;
  assert.equal(placeIsOpen(place("agent"), "/chat/abc", undefined, ALL_FEATURES), true);
  assert.equal(placeIsOpen(place("agent"), "/files", "chat", ALL_FEATURES), true);
  assert.equal(placeIsOpen(place("home"), "/", undefined, ALL_FEATURES), true);
  assert.equal(placeIsOpen(place("agent"), "/", undefined, { ...ALL_FEATURES, channels: false }), true, "without channels the agent is the landing place");
  assert.equal(placeIsOpen(place("members"), "/invite", undefined, ALL_FEATURES), true);
  assert.equal(placeIsOpen(place("meetings"), "/meetings/m1", undefined, ALL_FEATURES), true);
  assert.equal(placeIsOpen(place("inbox"), "/inbox", undefined, ALL_FEATURES), true);
  assert.equal(placeIsOpen(place("inbox"), "/inbox/inbox_abc", undefined, ALL_FEATURES), true, "a case is under Cases");
  assert.equal(placeIsOpen(place("saved"), "/saved", undefined, ALL_FEATURES), true);
  assert.equal(placeIsOpen(place("saved"), "/todos", undefined, ALL_FEATURES), false);
});

test("search finds every place by its name", () => {
  for (const place of DESTINATIONS) {
    const found = omnibarShortcuts(place.label, true, ALL_FEATURES, true);
    assert.ok(found.some(item => item.path === place.path), `"${place.label}" finds ${place.path}`);
  }
  assert.ok(omnibarShortcuts("to-dos", false, ALL_FEATURES, false).some(item => item.path === "/todos"), "To-dos was not in search at all");
  assert.ok(omnibarShortcuts("shortcuts", false, ALL_FEATURES, false).some(item => item.path === "/wiki"));
  assert.ok(!omnibarShortcuts("surveys", false, ALL_FEATURES, false).some(item => item.path === "/surveys"), "still only for people who may view surveys");
});

test("the sidebar and You draw the list instead of keeping their own", () => {
  const sidebar = read("components/Sidebar.tsx"), you = read("app/(tabs)/you.tsx");
  assert.match(sidebar, /destinationGroups\("sidebar"/);
  assert.match(you, /destinationGroups\("you"/);
  assert.doesNotMatch(sidebar, /<NavItem icon="\w+" label="(Saved|To-dos|Surveys|People|Meetings|Cases|Text shortcuts|Wiki)"/, "no place is written into the sidebar by hand");
  assert.doesNotMatch(you, /<Row label="(Saved messages|Saved|To-dos|Surveys|People|Meetings|Cases|Text shortcuts|Wiki)"/, "nor into You");
});
