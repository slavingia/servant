import test from "node:test";
import assert from "node:assert/strict";
import { nudgeVisible, NUDGE_SNOOZE_MS } from "./email-nudge-rules.ts";

test("the banner shows only when the account has no confirmed email", () => {
  assert.equal(nudgeVisible(true, null), true);
  assert.equal(nudgeVisible(false, null), false);
  assert.equal(nudgeVisible(null, null), false, "unknown yet: nothing flashes");
});

test("closing it hides it for a week, then it comes back", () => {
  const now = 1_800_000_000_000;
  assert.equal(nudgeVisible(true, now - 1000, now), false);
  assert.equal(nudgeVisible(true, now - NUDGE_SNOOZE_MS + 1, now), false);
  assert.equal(nudgeVisible(true, now - NUDGE_SNOOZE_MS, now), true);
  assert.equal(nudgeVisible(true, Number.NaN, now), true, "a damaged timestamp never hides it forever");
});
