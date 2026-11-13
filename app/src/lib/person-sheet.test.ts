// The person sheet on People lists six agent choices and the daily limit. Without a scrolling middle it is taller than
// a small phone (375 by 667) or a short window: the name above and Remove and Done below end up off screen, and nothing
// scrolls to reach them. These guard the three things that keep them reachable.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(import.meta.dirname, "../app/(tabs)/members.tsx"), "utf8");
const sheet = source.slice(source.indexOf("<Modal"), source.indexOf("</Modal>"));
const style = (name: string) => source.match(new RegExp(`\\b${name}: \\{([^}]*)\\}`))?.[1] ?? "";

test("the person sheet's choices scroll between the name and the actions", () => {
  const open = sheet.indexOf("<ScrollView"), close = sheet.indexOf("</ScrollView>");
  assert.ok(open > 0 && close > open, "the choices sit in a ScrollView");
  assert.ok(sheet.indexOf("styles.cardHead") < open, "the name stays above the scrolling choices");
  assert.ok(sheet.indexOf("styles.cardActions") > close, "Remove and Done stay below them");
  assert.match(sheet.slice(open, close), /AGENT_ROLES\.map/, "the agent choices are what scrolls");
  assert.match(sheet.slice(open, close), /limitRows\(/, "and the limits");
});

// The owner asked for the limit to read like the role list, with only one of the two open at a time so the open one
// has room to say what each choice means.
test("the role and the limit are two sections, and only one is open at a time", () => {
  assert.match(source, /const \[section, setSection\] = useState<"role" \| "limit" \| null>\("role"\);/, "one value: opening one closes the other; the role is open first");
  assert.equal((sheet.match(/<SheetSection /g) ?? []).length, 2);
  assert.match(sheet, /<SheetSection title="What their agent can do" summary=\{roleLabel\(managed\.agentTier\)\} open=\{section === "role"\}/);
  assert.match(sheet, /<SheetSection title="Daily token limit" summary=\{limitSummary\(managed, directory\?\.roleLimits, directory\?\.roleCosts\)\} open=\{section === "limit"\}/);
  assert.match(source, /accessibilityState=\{\{ expanded: open \}\} aria-expanded=\{open\}/, "each header says whether it is open");
  assert.match(source, /\{!open && summary \? <Text style=\{styles\.optionHint\}>\{summary\}<\/Text> : null\}/, "a closed section says what is chosen");
  assert.match(source, /const manage = \(id: string\) => \{ setSection\("role"\); setManaging\(id\); \};/, "every sheet opens on the role");
});

test("nothing on People is cut off with an ellipsis", () => {
  assert.doesNotMatch(source, /numberOfLines/, "a long name, role line or work email wraps");
});

test("the card is never taller than the screen", () => {
  assert.match(style("card"), /maxHeight: "100%"/);
  assert.match(style("scrim"), /paddingVertical/, "with a margin above and below it");
});
