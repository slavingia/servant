// The Saved screen (design audit). It arrived with two titles of its own ("Saved tasks" in the header, "My tasks"
// under it) and a slogan, beside "Saved" in the sidebar and "Saved messages" on You; a third style of tabs, with
// counts in brackets; and "Retry" where the rest of the app says "Try again".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DESTINATIONS } from "./destinations.ts";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const saved = read("app/saved.tsx");

test("the screen has one title, the one the sidebar opens it with, and no slogan", () => {
  assert.match(read("app/_layout.tsx"), /<Stack\.Screen name="saved" options=\{\{ title: "Saved"/, "the header says Saved");
  assert.equal(DESTINATIONS.find(place => place.path === "/saved")?.label, "Saved", "the name the sidebar, You and search all use");
  assert.doesNotMatch(saved, /<Stack\.Screen options=\{\{ title:/, "the screen does not rename itself");
  assert.doesNotMatch(saved, /<PageTitle/, "no second title under the header");
  assert.doesNotMatch(saved, /A place for your next steps/);
});

test("its sections are the section tabs of Project and Files, with counts after a dot", () => {
  const project = read("app/project.tsx");
  for (const style of [
    'tabs: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.pill, padding: 3,',
    'tab: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, paddingHorizontal: space.xs },',
    "tabOn: { backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },",
    "tabText: { ...typography.captionStrong, color: colors.muted },",
    "tabTextOn: { color: colors.ink },",
  ]) {
    assert.ok(project.includes(style), `Project has: ${style}`);
    assert.ok(saved.includes(style), `Saved has: ${style}`);
  }
  assert.match(saved, /accessibilityRole="tablist"/, "the tabs are in a tab list");
  assert.match(saved, /\{label\}\{data \? ` · \$\{count\}` : ""\}/, '"In progress · 3", as "Chats · 1" on a project');
  assert.doesNotMatch(saved, /` \(\$\{count\}\)`/, 'not "In progress (3)"');
});

test("asking again is Try again everywhere", () => {
  const screens = fs.readdirSync(path.join(import.meta.dirname, ".."), { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".tsx"));
  assert.ok(screens.length > 50, "found the screens and components");
  assert.deepEqual(screens.filter(file => /label="Retry"/.test(read(file))), []);
});
