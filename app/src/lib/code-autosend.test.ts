import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCode, expectedLength, shouldAutoSend } from "./code-autosend.ts";

test("a six-digit code sends itself when the automation gave no length", () => {
  assert.equal(shouldAutoSend("554100", undefined, null), true);
  assert.equal(shouldAutoSend("554 100", undefined, null), true, "spaces people type are ignored");
  assert.equal(shouldAutoSend("554-100", undefined, null), true, "so are dashes");
  assert.equal(shouldAutoSend("55410", undefined, null), false, "not until it is complete");
  assert.equal(shouldAutoSend("5541009", undefined, null), false, "seven digits waits for a tap");
  assert.equal(shouldAutoSend("ABC123", undefined, null), false, "letters wait for a tap without a stated length");
});

test("a stated length is what the screen waits for", () => {
  assert.equal(shouldAutoSend("12345678", 8, null), true);
  assert.equal(shouldAutoSend("1234567", 8, null), false);
  assert.equal(shouldAutoSend("554100", 8, null), false, "six digits is not enough when eight are expected");
  assert.equal(shouldAutoSend("AB12CD", 6, null), true, "letters count when the automation said how many");
  assert.equal(shouldAutoSend("AB12C!", 6, null), false, "only letters and numbers");
});

test("the same code is never sent twice", () => {
  assert.equal(shouldAutoSend("554100", undefined, "554100"), false, "a code the server turned down stays to be corrected");
  assert.equal(shouldAutoSend("554 100", undefined, "554100"), false, "however it is spaced");
  assert.equal(shouldAutoSend("554101", undefined, "554100"), true, "a corrected code sends");
});

test("only sensible lengths are trusted", () => {
  assert.equal(expectedLength(6), 6);
  assert.equal(expectedLength(12), 12);
  for (const bad of [undefined, null, 3, 13, 6.5, "6", NaN]) assert.equal(expectedLength(bad), null, String(bad));
  assert.equal(cleanCode(" 55 41-00 "), "554100");
});
