// A Pressable is a <button> on the web and a single accessibility element on a phone, so a Pressable inside another
// Pressable is invalid HTML (React logs "<button> cannot contain a nested <button>", visible as an error toast over the
// tab bar on the You screen) and the inner control can be swallowed by the outer one for screen-reader users.
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

// Walks JSX tags in order, keeping a stack of open <Pressable> elements. A Pressable is a real <button> on the web only
// when it has a button-like role (accessibilityRole="button"/"link"/...) or no role at all and is not a dismiss scrim; the
// common modal pattern (a tap-to-dismiss scrim wrapping a card) renders as a div and is not a defect. So this reports a
// Pressable with accessibilityRole="button" opened inside another Pressable with accessibilityRole="button".
function nested(source: string): number[] {
  const hits: number[] = [];
  const stack: boolean[] = []; // true when the open element is a button
  const re = /<(\/?)Pressable\b((?:[^>{]|\{(?:[^{}]|\{[^{}]*\})*\})*?)(\/?)>/gs;
  for (const m of source.matchAll(re)) {
    const closing = m[1] === "/", selfClosing = m[3] === "/";
    const line = source.slice(0, m.index).split("\n").length;
    if (closing) { stack.pop(); continue; }
    const isButton = /accessibilityRole=["{]\s*["']?button/.test(m[2]);
    if (isButton && stack.some(Boolean)) hits.push(line);
    if (!selfClosing) stack.push(isButton);
  }
  return hits;
}

test("the detector finds a Pressable inside a Pressable and ignores siblings", () => {
  const B = 'accessibilityRole="button"';
  assert.deepEqual(nested(`<Pressable ${B}>\n<Pressable ${B}>x</Pressable>\n</Pressable>`), [2]);
  assert.deepEqual(nested(`<Pressable ${B}>x</Pressable>\n<Pressable ${B}>y</Pressable>`), []);
  assert.deepEqual(nested(`<Pressable ${B}>\n<Pressable ${B} />\n</Pressable>`), [2]);
  assert.deepEqual(nested(`<Pressable onPress={() => {}}>\n<Pressable ${B}>x</Pressable>\n</Pressable>`), [], "a scrim wrapping a card is not a button");
  assert.deepEqual(nested(`<Pressable ${B} onPress={() => { go(); }}>\n<Pressable ${B} hitSlop={8}>x</Pressable>\n</Pressable>`), [2], "braces in props do not confuse it");
});

test("no Pressable is nested inside another Pressable", () => {
  const found = files.flatMap(f => nested(fs.readFileSync(f, "utf8")).map(line => `${path.relative(root, f)}:${line}`));
  assert.deepEqual(found, [], "split these into sibling controls");
});
