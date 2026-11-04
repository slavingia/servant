import { test } from "node:test";
import assert from "node:assert/strict";
import { callDuration } from "./call-clock.ts";

test("call time reads like a phone call timer", () => {
  assert.equal(callDuration(0), "0:00");
  assert.equal(callDuration(65_400), "1:05");
  assert.equal(callDuration(3_729_000), "1:02:09");
  assert.equal(callDuration(-5), "0:00");
});
