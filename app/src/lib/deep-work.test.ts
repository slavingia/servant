import { test } from "node:test";
import assert from "node:assert/strict";
import { DEEP_WORK_HINT, deepWorkFromServer } from "./deep-work.ts";

test("the switch is on only when the server says exactly true; an older server says nothing", () => {
  assert.equal(deepWorkFromServer(true), true);
  for (const raw of [false, undefined, null, "true", 1, {}, []]) assert.equal(deepWorkFromServer(raw), false);
});

test("deep work explains what it hides", () => {
  assert.match(DEEP_WORK_HINT, /^Hides channels, direct messages, the secure inbox and People\./);
});
