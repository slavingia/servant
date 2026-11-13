// One button (docs/design-system.md, "Buttons"). Primary is filled, secondary has a grey outline, anything that
// deletes, removes, leaves, stops or signs out has a red outline, and a link is words only, underlined on the web.
// Before this, "Remove" on a person was red words with no outline, "Leave channel" was red body text, "Sign out of
// this server" was a card row, a shared file's "Remove" was a blue link, and the destructive Button itself had no
// outline and its own height.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const screens = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter(file => file.endsWith(".tsx")).map(file => file.split(path.sep).join("/"));
const button = read("components/Button.tsx");
const DESTRUCTIVE = "Delete|Remove|Leave|Sign out|Discard|Revoke|Stop";

test("the four kinds: filled, grey outline, red outline, underlined words", () => {
  assert.match(button, /\n  primary: \{ backgroundColor: colors\.primary \},/);
  assert.match(button, /\n  secondary: \{ backgroundColor: colors\.background, borderWidth: 1, borderColor: colors\.borderStrong \},/);
  assert.match(button, /\n  danger: \{ backgroundColor: colors\.background, borderWidth: 1, borderColor: colors\.red \},/, "destructive is secondary with a red outline, at the same size");
  assert.match(button, /\n  dangerLabel: \{ color: colors\.red \},/);
  assert.match(button, /\n  linkLabel: \{ color: colors\.blue, \.\.\.linkUnderline \},/);
  assert.match(button, /\n  base: \{ minHeight: 48,/, "48 points");
  assert.match(button, /\n  compact: \{ minHeight: 44,/, "44 when compact");
});

test("a Button that deletes, removes, leaves, stops or signs out is the destructive kind", () => {
  const wrong: string[] = [];
  for (const file of screens) {
    for (const tag of read(file).match(/<Button\b[\s\S]*?\/>/g) ?? []) {
      if (new RegExp(`\\blabel=(?:\\{[^}]*)?["'\`](?:${DESTRUCTIVE})\\b`).test(tag) && !/kind="danger"/.test(tag) && !/kind=\{[^}]*"danger"/.test(tag)) wrong.push(`${file}: ${tag.slice(0, 90)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

// Where a destructive word is deliberately not on the shared Button, and why.
const ELSEWHERE: Record<string, string> = {
  "components/SwipeChannelRow.tsx": "the action a swipe reveals is a filled panel behind the row",
  "components/ActiveCallBar.tsx": "the call bar is one colored strip with Return and Leave",
  "components/GuestInvite.tsx": "the call screen's dark canvas has its own controls",
  "components/CallControls.tsx": "the call screen's dark canvas has its own controls",
  "app/meeting/[id].tsx": "the call screen's dark canvas has its own controls",
  "app/(tabs)/you.tsx": "Remove photo is a row in the photo menu",
};

test("no screen draws its own destructive button", () => {
  const own: string[] = [];
  for (const file of screens) {
    if (file in ELSEWHERE || file === "components/Button.tsx") continue;
    for (const block of read(file).match(/<Pressable\b[\s\S]*?<\/Pressable>/g) ?? []) {
      const label = block.match(new RegExp(`<Text[^>]*>\\s*((?:${DESTRUCTIVE})\\b[^<{]*)</Text>`));
      if (label) own.push(`${file}: "${label[1]!.trim()}"`);
    }
  }
  assert.deepEqual(own, []);
  for (const file of Object.keys(ELSEWHERE)) assert.ok(screens.includes(file), `${file} still exists`);
});
