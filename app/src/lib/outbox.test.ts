import assert from "node:assert/strict";
import test from "node:test";
import { createOutbox } from "./outbox.ts";
import { canCompactPost, sourceDeviceOf } from "./message-device.ts";
import type { Post } from "./server.ts";

const me = { id: "u1", name: "Pat Tester" };
const jo = { id: "u2", name: "Jo Park" };
const post = (id: string, user = me, extra: Partial<Post> = {}): Post => ({ id, conversationId: "c1", user, threadRoot: null, text: `message ${id}`, deleted: false, pending: false, replyCount: 0, lastReplyAt: null, createdAt: 1763000000000 + Number(id) * 1000, editedAt: null, ...extra });
const input = (text: string, extra = {}) => ({ conversationId: "c1", threadRoot: null, text, user: me, ...extra });

test("a sent message is in the list at once, as a message of mine that is still on its way", () => {
  const outbox = createOutbox(() => 1763000500000);
  assert.deepEqual(outbox.sending(), []);
  const local = outbox.add(input("On my way"));
  assert.deepEqual(outbox.sending(), [local]);
  assert.equal(local.text, "On my way");
  assert.equal(local.user.id, "u1");
  assert.equal(local.sending, true);
  // Not "pending": that is the agent's "Working…" placeholder.
  assert.equal(local.pending, false);
  assert.equal(local.deleted, false);
  assert.equal(local.createdAt, 1763000500000);
  const second = outbox.add(input("And another"));
  assert.notEqual(second.id, local.id);
  assert.deepEqual(outbox.sending().map(p => p.text), ["On my way", "And another"]);
});

test("the server's copy takes the place of the message, in the same row", () => {
  const outbox = createOutbox();
  const local = outbox.add(input("Hello"));
  const before = outbox.sending();
  const sent = post("41", me, { text: "Hello" });
  assert.deepEqual(outbox.settle(local.id, sent), [sent]);
  assert.deepEqual(outbox.sending(), []);
  assert.notEqual(outbox.sending(), before);
  // The list keeps the row: the key of the server's copy is the key the message was first shown with.
  assert.equal(outbox.key(sent), local.id);
  assert.equal(outbox.key(post("40", jo)), "40");
});

test("a message that could not be sent leaves the list", () => {
  const outbox = createOutbox();
  const local = outbox.add(input("Hello"));
  assert.deepEqual(outbox.settle(local.id, null), []);
  assert.deepEqual(outbox.sending(), []);
});

test("my message coming back on the live connection first does not show twice", () => {
  const outbox = createOutbox();
  const local = outbox.add(input("Hello"));
  const echo = post("41", me, { text: "Hello" });
  // Someone else's message, and an update to an older message of mine, show as usual.
  assert.equal(outbox.hold("message.created", post("40", jo), "u1"), false);
  assert.equal(outbox.hold("message.updated", post("12", me), "u1"), false);
  assert.equal(outbox.hold("message.created", echo, "u1"), true);
  // An update to the held message waits with it, and replaces it.
  const marked = { ...echo, reactions: [{ emoji: "👍", userIds: ["u2"] }] };
  assert.equal(outbox.hold("message.updated", marked, "u1"), true);
  const arrived = outbox.settle(local.id, echo);
  assert.deepEqual(arrived, [echo, marked]);
  // Nothing is sending now: my messages arrive as usual.
  assert.equal(outbox.hold("message.created", post("42", me), "u1"), false);
});

test("a held message is let go when the send fails, since it was not that send", () => {
  const outbox = createOutbox();
  const local = outbox.add(input("Hello"));
  const other = post("41", me, { text: "from my other device" });
  assert.equal(outbox.hold("message.created", other, "u1"), true);
  assert.deepEqual(outbox.settle(local.id, null), [other]);
});

test("with two sends waiting, each answer lets go of its own message only", () => {
  const outbox = createOutbox();
  const first = outbox.add(input("one"));
  const second = outbox.add(input("two"));
  const one = post("41", me, { text: "one" }), two = post("42", me, { text: "two" });
  assert.equal(outbox.hold("message.created", one, "u1"), true);
  assert.equal(outbox.hold("message.created", two, "u1"), true);
  assert.deepEqual(outbox.settle(first.id, one), [one, one]);
  assert.deepEqual(outbox.sending().map(p => p.text), ["two"]);
  assert.deepEqual(outbox.settle(second.id, two), [two, two]);
  assert.deepEqual(outbox.sending(), []);
});

test("the message groups with my last one exactly as the server's copy will", () => {
  // The phone's clock is two minutes behind the server's: the new message still follows the last one.
  const outbox = createOutbox(() => 1763000000000);
  const last = post("40", me, { createdAt: 1763000120000, sourceDevice: sourceDeviceOf("mobile") });
  const local = outbox.add(input("Hello", { after: last, sourceDevice: sourceDeviceOf("mobile") }));
  assert.equal(local.createdAt, 1763000120000);
  // The owner sees which device each message came from, and a change of device starts a new group.
  assert.equal(canCompactPost(last, local, "owner"), true);
  assert.equal(canCompactPost(last, outbox.add(input("Hello", { after: last })), "owner"), false);
  // A member is not shown devices: the message carries none and groups all the same.
  const plain = post("39", me, { createdAt: 1763000110000 });
  assert.equal(canCompactPost(plain, outbox.add(input("Hello", { after: plain })), "member"), true);
});

// The screens: the message is shown before the server is asked, and its echo is held while it is on its way.
for (const file of ["app/c/[id].tsx", "app/thread.tsx"]) {
  test(`${file} shows a text message before asking the server`, async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
    const send = source.slice(source.indexOf("const send = async"));
    const shown = send.indexOf("outbox.add("), asked = send.indexOf("api.post(");
    assert.ok(shown > 0 && asked > 0 && shown < asked, "outbox.add comes before api.post");
    assert.match(send.slice(0, asked), /setSending\(outbox\.sending\(\)\)/);
    assert.match(source, /outbox\.hold\(e\.event, p, account\.user\.id\)/);
    assert.match(source, /const postKey = outbox\.key;/);
  });
}
