import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBanner, MAX_BANNER_CHARS } from "./banner.mjs";

test("a banner shows only when enabled with a message", () => {
  assert.equal(normalizeBanner(undefined), null);
  assert.equal(normalizeBanner({ message: "Hi" }), null);
  assert.equal(normalizeBanner({ enabled: "true", message: "Hi" }), null);
  assert.equal(normalizeBanner({ enabled: false, message: "Hi" }), null);
  assert.equal(normalizeBanner({ enabled: true, message: "   " }), null);
  assert.equal(normalizeBanner({ enabled: true }), null);
  assert.equal(normalizeBanner([]), null);
  assert.deepEqual(normalizeBanner({ enabled: true, message: "  Do not use\n this app.  " }), { message: "Do not use this app." });
});

test("a long message is cut to a safe length", () => {
  assert.equal(normalizeBanner({ enabled: true, message: "x".repeat(1000) }).message.length, MAX_BANNER_CHARS);
});
