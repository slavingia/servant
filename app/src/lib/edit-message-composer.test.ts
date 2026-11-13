// Editing a message works like Slack: Up Arrow opens the last one with the caret at the end,
// Escape leaves it unchanged, Enter saves, and saving an empty box asks to delete the message.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const composer = read("components/Messaging.tsx");
const screens = [read("app/c/[id].tsx"), read("app/thread.tsx")];

test("an edit opens with the caret after the last character", () => {
  assert.match(composer, /useState<\{ start: number; end: number \} \| undefined>\(\(\) => initial \? \{ start: initial\.length, end: initial\.length \} : undefined\)/);
  assert.match(composer, /node\.setSelectionRange\(end, end\);/);
  assert.match(composer, /node\.scrollTop = node\.scrollHeight;/);
});

test("Escape cancels an edit without saving", () => {
  assert.match(composer, /if \(onCancel && key\.key === "Escape" && !key\.isComposing && !busy && !sending\.current\) \{\s*event\.preventDefault\(\);\s*onCancel\(\);/);
  assert.match(composer, /onCancel && enterSends \? "Esc to cancel, Enter to save"/);
});

test("saving an empty edit asks to delete the message instead", () => {
  assert.match(composer, /if \(!body && !files\.length && !canSendEmpty\) \{ if \(onCancel && onDeleteEmpty\) onDeleteEmpty\(\); return; \}/);
  assert.match(composer, /const deletesWhenEmpty = !!onCancel && !!onDeleteEmpty;/);
  for (const screen of screens) {
    assert.match(screen, /onDeleteEmpty=\{\(\) => setConfirmDelete\(editing\)\}/);
    assert.match(screen, /<ConfirmDialog visible=\{!!confirmDelete\} title="Delete message\?"/);
  }
});
