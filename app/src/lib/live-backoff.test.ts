import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { FIRST_WAIT_MS, LONGEST_WAIT_MS, nextWait, spread, STEADY_AFTER_MS } from "./live-backoff.ts";

test("the wait doubles after each attempt that failed or was cut short, up to half a minute", () => {
  let wait = FIRST_WAIT_MS;
  const seen = [];
  for (let i = 0; i < 7; i++) { wait = nextWait(wait, 0); seen.push(wait); }
  assert.deepEqual(seen, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  // A connection that came up and was cut after a few seconds counts as a failure, not a fresh start.
  assert.equal(nextWait(8000, 3000), 16000);
  assert.equal(nextWait(LONGEST_WAIT_MS, STEADY_AFTER_MS - 1), LONGEST_WAIT_MS);
});

test("only a connection that lasted puts the wait back to the start", () => {
  assert.equal(nextWait(LONGEST_WAIT_MS, STEADY_AFTER_MS), FIRST_WAIT_MS);
  assert.equal(nextWait(16000, 10 * 60_000), FIRST_WAIT_MS);
  assert.equal(nextWait(0, 0), 2000, "never shorter than the first wait doubled");
});

test("each wait is spread between half and all of itself, so apps don't return together", () => {
  assert.equal(spread(10000, 0), 5000);
  assert.equal(spread(10000, 1), 10000);
  assert.equal(spread(10000, 0.5), 7500);
  assert.deepEqual([spread(10000, -3), spread(10000, 9)], [5000, 10000]);
  const waits = new Set(Array.from({ length: 50 }, () => spread(30000)));
  assert.ok(waits.size > 10 && [...waits].every(w => w >= 15000 && w <= 30000));
});

test("the live connection uses them: no reset on connect, a spread wait, and the longer wait after a refusal", () => {
  const live = readFileSync(new URL("./live.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(live, /setUnreachableFor\(""\);\s*delay = 1000;/, "connecting no longer resets the wait by itself");
  assert.match(live, /delay = nextWait\(delay, /);
  assert.match(live, /setTimeout\(r, spread\(delay\)\)/);
});
