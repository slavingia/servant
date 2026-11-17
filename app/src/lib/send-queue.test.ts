import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { backInBox, createSendQueue } from "./send-queue.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
// A request whose answer the test decides.
const request = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("messages go to the server one at a time, in the order they were written", async () => {
  const queue = createSendQueue();
  const started: string[] = [];
  const first = request<string>(), second = request<string>(), third = request<string>();
  const a = queue.inTurn(() => { started.push("first"); return first.promise; });
  const b = queue.inTurn(() => { started.push("second"); return second.promise; });
  const c = queue.inTurn(() => { started.push("third"); return third.promise; });
  await tick();
  assert.deepEqual(started, ["first"], "the second waits for the first's answer");
  first.resolve("one");
  assert.equal(await a, "one");
  await tick();
  assert.deepEqual(started, ["first", "second"]);
  second.resolve("two"); third.resolve("three");
  assert.deepEqual(await Promise.all([b, c]), ["two", "three"]);
  assert.deepEqual(started, ["first", "second", "third"]);
});

test("a message that fails does not hold up the ones after it, and fails by itself", async () => {
  const queue = createSendQueue();
  const first = request<string>();
  const a = queue.inTurn(() => first.promise);
  const b = queue.inTurn(async () => "second went");
  first.reject(new Error("offline"));
  await assert.rejects(a, /offline/);
  assert.equal(await b, "second went");
  assert.equal(await queue.inTurn(async () => "and a third"), "and a third");
});

test("a send that throws before it starts is a failure like any other", async () => {
  const queue = createSendQueue();
  await assert.rejects(queue.inTurn(() => { throw new Error("no account"); }), /no account/);
  assert.equal(await queue.inTurn(async () => 1), 1);
});

test("words that could not be sent go back in the box without losing what was typed since", () => {
  assert.equal(backInBox("", "first"), "first");
  assert.equal(backInBox("  \n", "first"), "first");
  assert.equal(backInBox("typing the next one", "first"), "typing the next one\nfirst");
  assert.equal(backInBox("first", "second"), "first\nsecond", "two failures come back in the order they were sent");
  assert.equal(backInBox("first", "first"), "first", "not twice");
  assert.equal(backInBox("next\nfirst", "first"), "next\nfirst");
  assert.equal(backInBox("still here", ""), "still here");
});

test("channels and threads free the box when a message leaves, and send in turn", () => {
  const composer = read("../components/Messaging.tsx");
  // Only a plain new message: one with files, an edit, a command, or a screen that has not asked keeps the box until the answer.
  assert.match(composer, /let free = false;\n\s+try \{/);
  assert.match(composer, /\n\s+free = freeOnSend && clearNow && !uploads\.length && !command;/);
  assert.match(composer, /if \(free\) \{ sending\.current = false; setBusy\(false\); \}\n\s+const ok = await onSend\(body, uploads, how\);/);
  // The answer to a freed send must not unlock or clear a later one that is still being sent.
  assert.match(composer, /finally \{ if \(!free\) \{ sending\.current = false; setBusy\(false\); \} \}/);
  assert.match(composer, /if \(ok\) \{ if \(!clearNow\) setText\(""\); if \(!free\) \{ setFiles\(\[\]\); setInsertedSelection\(undefined\); \} \}/);
  assert.match(composer, /else if \(clearNow\) setText\(current => backInBox\(current, restore\(\)\)\);/);
  for (const screen of ["../app/c/[id].tsx", "../app/thread.tsx"]) {
    const source = read(screen);
    assert.match(source, /const \[turns\] = useState\(createSendQueue\);/, screen);
    assert.match(source, /await turns\.inTurn\(\(\) => withPiiConfirm\(askPii, confirmPii => api\.post\(/, screen);
    assert.match(source, /<Composer [^\n]*\bfreeOnSend\b[^\n]*onSend=\{send\}/, screen);
    // The row is shown before the message waits its turn.
    assert.ok(source.indexOf("outbox.add(") < source.indexOf("turns.inTurn("), screen);
  }
  // The agent's composer has its own rules for a message sent during a reply (steer, queue): it is left alone.
  assert.doesNotMatch(read("../app/chat/[id].tsx"), /freeOnSend/);
});
