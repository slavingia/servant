import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveOpens, LIVE_OPENS_PER_MINUTE } from "./live-opens.mjs";

test("a device may open the live connection a few times a minute; past that it is refused and told when to return", () => {
  const time = { now: 1_000_000 };
  const opens = createLiveOpens({ clock: () => time.now });
  for (let i = 0; i < LIVE_OPENS_PER_MINUTE; i++) { assert.deepEqual(opens.take("dev_a"), { ok: true }); time.now += 1000; }
  // The seventh within the minute is refused; the wait is until the first one is a minute old.
  assert.deepEqual(opens.take("dev_a"), { ok: false, retryAfter: 60 - LIVE_OPENS_PER_MINUTE });
  // A refusal is not counted: hammering does not push the return time out.
  for (let i = 0; i < 50; i++) opens.take("dev_a");
  assert.deepEqual(opens.take("dev_a"), { ok: false, retryAfter: 60 - LIVE_OPENS_PER_MINUTE });
  // Another device is not affected.
  assert.deepEqual(opens.take("dev_b"), { ok: true });
  // When the first open is a minute old there is room for one more, and only one.
  time.now = 1_000_000 + 60_000;
  assert.deepEqual(opens.take("dev_a"), { ok: true });
  assert.equal(opens.take("dev_a").ok, false);
});

test("ordinary use is never refused, and quiet devices are forgotten", () => {
  const time = { now: 5_000_000 };
  const opens = createLiveOpens({ clock: () => time.now });
  // Reconnecting every 15 seconds for an hour (a phone coming back to the app, a server restart) is fine.
  for (let i = 0; i < 240; i++) { assert.equal(opens.take("dev_a").ok, true, `open ${i}`); time.now += 15_000; }
  for (let i = 0; i < 100; i++) opens.take(`dev_${i}`);
  assert.equal(opens.size(), 101);
  time.now += 120_000;
  opens.take("dev_new");
  assert.equal(opens.size(), 1, "devices with nothing in the last minute are dropped");
  assert.equal(createLiveOpens({ perMinute: 2 }).take(undefined).ok, true);
});
