import test from "node:test";
import assert from "node:assert/strict";
import { createSessionExpiryStore } from "./session-expiry-state.ts";

test("inactive server expiration cannot lock or change the active account", () => {
  const store = createSessionExpiryStore();
  store.select("one:token");
  store.noteInfo({ expiresAt: 200, maxHours: 8, email: "one@example.test" }, "one:token");
  store.noteExpired(4, "two:token");
  assert.equal(store.snapshot().expired, false);
  assert.equal(store.snapshot().info?.email, "one@example.test");
  store.select("two:token");
  assert.equal(store.snapshot().expired, true);
  assert.equal(store.snapshot().info?.maxHours, 4);
  store.clear("two:token");
  store.select("one:token");
  assert.equal(store.checkResume(201), true);
});

test("a late expiry from a revoked token does not affect its replacement", () => {
  const store = createSessionExpiryStore();
  store.select("one:new-token");
  store.noteExpired(8, "one:old-token");
  assert.equal(store.snapshot().expired, false);
  store.noteExpired(8, "two:token");
  store.reset("one:old-token");
  store.select("two:token");
  assert.equal(store.snapshot().expired, true);
});
