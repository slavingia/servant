// react-native-web renders aria-checked and aria-selected and has no case for accessibilityState (0.21,
// createDOMProps). A radio, checkbox, switch or tab that sets only accessibilityState is therefore silent about its
// state in a browser and in the Mac app: a screen reader cannot say which role, limit, filter or tab is chosen.
// The same went for sixteen buttons that set `selected`: the sidebar's open page, a reaction you added, a muted
// microphone, the chosen period, workflow, status, owner and project.
// Native maps the aria props to the same accessibility state, so setting both costs nothing there.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const files: string[] = [];
(function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
  }
})(root);

// Opening tags of components, with braces in props up to three deep ("onPress={() => { go({ a: 1 }); }}").
const openingTag = /<[A-Z]\w*\b((?:[^>{]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*?)\/?>/gs;
const needs: Record<string, RegExp> = { radio: /\baria-checked=/, checkbox: /\baria-checked=/, switch: /\baria-checked=/, tab: /\baria-selected=/ };

function silent(source: string): { line: number; role: string }[] {
  const hits: { line: number; role: string }[] = [];
  for (const m of source.matchAll(openingTag)) {
    const role = m[1]!.match(/accessibilityRole="(radio|checkbox|switch|tab)"/)?.[1];
    if (role && !needs[role]!.test(m[1]!)) hits.push({ line: source.slice(0, m.index).split("\n").length, role });
    // A button that is on, a row that is the open page and a result that is highlighted set `selected`; a browser
    // hears that only through aria-pressed, aria-current or aria-selected.
    if (!role && /accessibilityState=\{\{(?:[^{}]*,)?\s*selected\b\s*[:,}]/.test(m[1]!) && !/\baria-(?:pressed|current|selected)=/.test(m[1]!)) hits.push({ line: source.slice(0, m.index).split("\n").length, role: "selected" });
    // The same holds for something that opens and closes: `expanded` needs aria-expanded beside it.
    if (/accessibilityState=\{\{[^{}]*\bexpanded\b/.test(m[1]!) && !/\baria-expanded=/.test(m[1]!)) hits.push({ line: source.slice(0, m.index).split("\n").length, role: "disclosure" });
  }
  return hits;
}

test("the detector tells a control that states its choice from one that does not", () => {
  assert.deepEqual(silent(`<Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => { pick({ id }); }}>`), [{ line: 1, role: "radio" }]);
  assert.deepEqual(silent(`<Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} aria-checked={on}>`), []);
  assert.deepEqual(silent(`<View>\n<Pressable accessibilityRole="tab" accessibilityState={{ selected }}>`), [{ line: 2, role: "tab" }]);
  assert.deepEqual(silent(`<Pressable accessibilityRole="tab" aria-selected={selected}>`), []);
  assert.deepEqual(silent(`<Pressable accessibilityRole="button" accessibilityState={{ selected }}>`), [{ line: 1, role: "selected" }], "a button that is on says so");
  assert.deepEqual(silent(`<Pressable accessibilityRole="button" accessibilityState={{ selected: on, disabled }} aria-pressed={on}>`), []);
  assert.deepEqual(silent(`<Pressable accessibilityRole="button" accessibilityState={{ selected }} aria-current={selected ? "page" : undefined}>`), []);
  assert.deepEqual(silent(`<Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !selected }}>`), [], "a variable named selected is not the state");
  assert.deepEqual(silent(`<Pressable accessibilityRole="button" accessibilityState={{ expanded: open }}>`), [{ line: 1, role: "disclosure" }]);
  assert.deepEqual(silent(`<Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open}>`), []);
});

test("every radio, checkbox, switch, tab, disclosure and chosen button says its state on the web too", () => {
  const found = files.flatMap(f => silent(fs.readFileSync(f, "utf8")).map(hit => `${path.relative(root, f)}:${hit.line} (${hit.role})`));
  assert.deepEqual(found, [], "add aria-checked (radio, checkbox, switch), aria-selected (tab), aria-expanded (something that opens), or aria-pressed or aria-current (a button that is on, the open page) beside accessibilityState");
});
