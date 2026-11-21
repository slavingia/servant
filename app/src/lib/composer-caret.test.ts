// Coming back to a chat with a draft left in its box (issue #82's last line: the @mention was still there):
// in a browser the caret was before the draft's first character, so the next words went in front of it.
// Browser check: scripts/mention-typing-e2e.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { caretAfterDraft, type DraftBox } from "./composer-caret.ts";

// A browser's text box, as far as the caret goes.
function box(value: string, start = 0, end = start): DraftBox & { scrollTop: number } {
  return {
    value, selectionStart: start, selectionEnd: end, scrollTop: 0, scrollHeight: 284,
    setSelectionRange(from: number, to: number) { this.selectionStart = from; this.selectionEnd = to; },
  };
}

test("a box that opens with a draft gets its caret after the draft", () => {
  const draft = box("@Jo-Park ");
  assert.equal(caretAfterDraft(draft, true), true);
  assert.deepEqual([draft.selectionStart, draft.selectionEnd], [9, 9], "after the name and its space, where the next word goes");
});

test("a focused box shows the last line of a long draft; one that is not focused stays where it was", () => {
  const focused = box("line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8");
  caretAfterDraft(focused, true);
  assert.equal(focused.scrollTop, 284);
  const resting = box("line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8");
  assert.equal(caretAfterDraft(resting, false), true);
  assert.equal(resting.selectionStart, resting.value.length, "the caret is ready for when it is focused");
  assert.equal(resting.scrollTop, 0);
});

test("the caret is the person's once they have typed or clicked", () => {
  const typed = box("hello there", 5);
  assert.equal(caretAfterDraft(typed, true), false);
  assert.deepEqual([typed.selectionStart, typed.selectionEnd], [5, 5]);
  const selected = box("hello there", 0, 5);
  assert.equal(caretAfterDraft(selected, true), false);
  assert.deepEqual([selected.selectionStart, selected.selectionEnd], [0, 5]);
});

test("an empty box and a missing one are left alone", () => {
  const empty = box("");
  assert.equal(caretAfterDraft(empty, true), false);
  assert.equal(caretAfterDraft(null, true), false);
  assert.equal(caretAfterDraft(undefined, false), false);
});

test("the message box does this when it opens, and again when a saved draft arrives a moment later", () => {
  const composer = fs.readFileSync(path.join(import.meta.dirname, "../components/Messaging.tsx"), "utf8");
  // A draft read after a restart counts as one more to place the caret after; typing is never overwritten.
  assert.match(composer, /if \(live && saved\) \{ setText\(current => current \|\| saved\); setRestored\(count => count \+ 1\); \}/);
  const effect = composer.match(/useEffect\(\(\) => \{\s*if \(Platform\.OS !== "web" \|\| initial\) return;([\s\S]*?)\}, \[restored, initial\]\);/)?.[1];
  assert.ok(effect, "a browser-only effect runs on opening and for each restored draft; an edit keeps its own");
  assert.match(effect, /caretAfterDraft\(node, !!node && node\.ownerDocument\?\.activeElement === node\)/);
});
