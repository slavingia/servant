// Choosing a survey, or which responses to show, is the same control as the filters on Home, Direct messages and
// Agent: a tab list whose chosen tab is filled with blueSoft (docs/design-system.md, "Selected filters"). The survey
// screens arrived with bordered buttons marked `selected`, a state a button cannot say in a browser or the Mac app.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const screens = { queue: read("app/queue.tsx"), surveys: read("app/surveys.tsx") };

test("survey screens choose with tabs, not buttons marked selected", () => {
  for (const [name, source] of Object.entries(screens)) {
    assert.doesNotMatch(source, /accessibilityRole="button" accessibilityState=\{\{ selected:/, `${name}: a button has no selected state`);
    assert.equal((source.match(/accessibilityRole="tablist"/g) ?? []).length, name === "queue" ? 2 : 1, `${name}: each chooser is a tab list`);
    assert.equal((source.match(/accessibilityRole="tab" /g) ?? []).length, name === "queue" ? 2 : 1, `${name}: each choice is a tab`);
  }
});

test("the tabs look like the filters on Direct messages", () => {
  const filters = read("app/(tabs)/messages.tsx");
  assert.match(filters, /selectedFilter: \{ backgroundColor: colors\.blueSoft \}/, "the look this test compares with");
  for (const [name, source] of Object.entries(screens)) {
    assert.match(source, /tab: \{ minHeight: 44, paddingHorizontal: space\.lg, paddingVertical: space\.sm, justifyContent: 'center', borderRadius: radius\.pill \}/, `${name}: no border, the filter's size, pill corners, no fill until chosen`);
    assert.match(source, /tabSelected: \{ backgroundColor: colors\.blueSoft \}/, `${name}: the chosen tab is filled`);
    assert.match(source, /tabText: \{ \.\.\.typography\.bodyStrong, color: colors\.muted \}/, `${name}: quiet until chosen`);
    assert.match(source, /tabTextSelected: \{ color: colors\.blueDark \}/, `${name}: the chosen tab's words`);
  }
});
