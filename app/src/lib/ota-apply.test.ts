import { test } from "node:test";
import assert from "node:assert/strict";
import { APPLY_WINDOW_MS, shouldApplyNow } from "./ota-apply.ts";

test("an update that arrives right after launch starts at once", () => {
  assert.equal(shouldApplyNow({ msSinceLaunch: 1500, returningToApp: false }), true);
});

test("a late update waits until the person comes back to the app", () => {
  assert.equal(shouldApplyNow({ msSinceLaunch: APPLY_WINDOW_MS + 1, returningToApp: false }), false);
  assert.equal(shouldApplyNow({ msSinceLaunch: 60 * 60 * 1000, returningToApp: true }), true);
});
