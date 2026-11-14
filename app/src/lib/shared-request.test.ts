import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createSharedRequest } from "./shared-request.ts";

function fakeTimer() {
  const due: { run: () => void; cleared: boolean }[] = [];
  return {
    timer: { set: (run: () => void) => { const entry = { run, cleared: false }; due.push(entry); return entry; }, clear: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; } },
    /** The window passes: everything scheduled and not cleared runs. */
    pass() { for (const entry of due.splice(0)) if (!entry.cleared) entry.run(); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("two screens asking in the same moment share one request", async () => {
  const { timer, pass } = fakeTimer();
  let started = 0, finish = () => {};
  const shared = createSharedRequest(() => { started++; return new Promise<void>(resolve => { finish = resolve; }); }, 40, timer);
  let done = 0;
  // Leaving a conversation asks, and Home coming back asks a moment later.
  void shared.request().then(() => done++);
  void shared.request().then(() => done++);
  assert.equal(started, 0, "nothing leaves until the window has passed");
  pass();
  assert.equal(started, 1);
  await tick();
  assert.equal(done, 0, "both wait for the answer");
  finish();
  await tick();
  assert.equal(done, 2);
});

test("a call after the request has left starts its own, so it never gets an older answer", async () => {
  const { timer, pass } = fakeTimer();
  const finishers: (() => void)[] = [];
  const shared = createSharedRequest(() => new Promise<void>(resolve => { finishers.push(resolve); }), 40, timer);
  let first = false, second = false;
  void shared.request().then(() => { first = true; });
  pass();
  assert.equal(finishers.length, 1);
  // The first request is on its way. Something changes on the server, and a screen asks again.
  void shared.request().then(() => { second = true; });
  pass();
  assert.equal(finishers.length, 2, "a second request left");
  finishers[0]!();
  await tick();
  assert.deepEqual([first, second], [true, false], "the second caller waits for its own request");
  finishers[1]!();
  await tick();
  assert.equal(second, true);
});

test("a request that fails lets its callers go, and the next call asks again", async () => {
  const { timer, pass } = fakeTimer();
  let started = 0;
  const shared = createSharedRequest(() => { started++; return Promise.reject(new Error("offline")); }, 40, timer);
  const asked = shared.request();
  pass();
  await asked;
  const again = shared.request();
  pass();
  await again;
  assert.equal(started, 2);
});

test("a request that has not left is dropped when the account changes, and nobody is left waiting", async () => {
  const { timer, pass } = fakeTimer();
  let started = 0;
  const shared = createSharedRequest(async () => { started++; }, 40, timer);
  const asked = shared.request();
  shared.cancel();
  await asked;
  pass();
  assert.equal(started, 0, "the old account's request never leaves");
  // Cancelling with nothing waiting is nothing; the next call works as usual.
  shared.cancel();
  const next = shared.request();
  pass();
  await next;
  assert.equal(started, 1);
});

test("the live connection shares its list refresh and drops a waiting one when the account changes", () => {
  const live = fs.readFileSync(path.join(import.meta.dirname, "live.tsx"), "utf8");
  assert.match(live, /sharing\.current = \{ start: fetchList, shared: createSharedRequest\(fetchList\) \};/);
  assert.match(live, /return sharing\.current\.shared\.request\(\);/);
  assert.match(live, /sharing\.current\?\.shared\.cancel\(\);/);
});
