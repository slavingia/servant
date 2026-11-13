// One checkbox picture (docs/design-system.md, "Components"). Five places drew their own: the terms on joining,
// the "not sensitive" box and a to-do were 24 points with a 2-point muted boundary, a saved task was 23 points with
// a 1.5-point boundary, and the people picker in a new message was 22 points with tighter corners, so the same
// control looked different from screen to screen.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const sources = (fs.readdirSync(root, { recursive: true, encoding: "utf8" }) as string[]).filter(file => /\.tsx$/.test(file)).sort();

test("the picture is 24 points with the field boundary, filled with the primary color when ticked", () => {
  const box = read("components/CheckBox.tsx");
  assert.match(box, /box: \{ width: 24, height: 24, flexShrink: 0, borderRadius: radius\.sm, borderWidth: 2, borderColor: colors\.borderStrong,/);
  assert.match(box, /on: \{ backgroundColor: colors\.primary, borderColor: colors\.primary \}/);
  assert.match(box, /accessibilityElementsHidden importantForAccessibility="no-hide-descendants"/, "the row is the control; the picture is not read out");
  assert.match(box, /<AppIcon name="check"/);
  assert.match(box, /done: \{ backgroundColor: colors\.greenSoft, borderColor: colors\.green \}/, "a finished to-do or saved task: pale green with a dark green tick");
  assert.match(box, /color=\{done \? colors\.greenDark : colors\.onPrimary\}/);
});

test("every ticked box is that picture", () => {
  for (const file of ["app/pair.tsx", "app/new-message.tsx", "components/PiiConfirm.tsx", "components/TodoList.tsx", "components/SavedTaskRow.tsx"]) assert.match(read(file), /<CheckBox on=\{\w+\}/, file);
  assert.match(read("components/TodoList.tsx"), /<CheckBox on=\{finished\} tone="done" busy=\{busy === t\.id\} \/>/);
  assert.match(read("components/SavedTaskRow.tsx"), /<CheckBox on=\{done\} tone="done" busy=\{busy\} \/>/);
  const own = sources.filter(file => file !== "components/CheckBox.tsx" && /\b(?:box|check|checkbox)\w*: \{[^{}]*width: 2[0-4], height: 2[0-4][^{}]*borderWidth/.test(read(file)));
  assert.deepEqual(own, [], "use CheckBox");
});
