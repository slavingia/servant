import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveEventDecoder, validEventCursor, type EventFrame } from "./live-events.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const frame = (id: string, event: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test("reconnect resumes after delivered events and suppresses duplicate delivery", () => {
  const received: EventFrame[] = [];
  let cursor: string | undefined;
  const first = createLiveEventDecoder(event => received.push(event), { onCursor: value => { cursor = value; } });
  first.push(bytes(frame("4", "ready", { cursor: "4", reset: true }) + frame("5", "message.created", { text: "Hello" })));
  first.finish();
  assert.equal(cursor, "5");
  const next = createLiveEventDecoder(event => received.push(event), { cursor, onCursor: value => { cursor = value; } });
  next.push(bytes(frame("5", "message.created", { text: "Hello" }) + frame("6", "message.updated", { text: "Changed" })));
  next.push(bytes(frame("8", "ready", { cursor: "8", reset: false })));
  assert.deepEqual(received.map(e => e.event), ["ready", "message.created", "message.updated", "ready"]);
  assert.equal(cursor, "8", "ready advances over events the user cannot see");
});

test("chunked Unicode, CRLF, comments and multi-line JSON preserve event framing", () => {
  const received: EventFrame[] = [];
  const decoder = createLiveEventDecoder(event => received.push(event));
  const source = bytes(': keepalive\r\n\r\nid: 1\r\nevent: message.created\r\ndata: {"text":\r\ndata: "Zoë 🌈"}\r\n\r\n');
  for (const byte of source) decoder.push(Uint8Array.of(byte));
  decoder.finish();
  assert.equal(received[0].data.text, "Zoë 🌈");
  assert.equal(decoder.cursor, "1");
});

test("a reset can lower the cursor; old servers disable resume", () => {
  const decoder = createLiveEventDecoder(() => {}, { cursor: "100" });
  decoder.push(bytes(frame("2", "ready", { cursor: "2", reset: true })));
  assert.equal(decoder.cursor, "2");
  decoder.push(bytes('event: ready\ndata: {}\n\n'));
  assert.equal(decoder.cursor, undefined);
  decoder.push(bytes('event: message.created\ndata: {"text":"legacy"}\n\n'));
  assert.equal(decoder.cursor, undefined);
});

test("corrupt or truncated frames never acknowledge an undelivered event", () => {
  for (const source of [
    'id: 6\nevent: message.created\ndata: broken\n\n',
    frame("9007199254740992", "message.created", {}),
    frame("6", "checkpoint", { cursor: "7" }),
    frame("6", "checkpoint", {}),
    frame("6", "ready", { cursor: "6", reset: "yes" }),
    frame("4", "ready", { cursor: "4", reset: false }),
  ]) {
    const decoder = createLiveEventDecoder(() => {}, { cursor: "5" });
    assert.throws(() => decoder.push(bytes(source)));
    assert.equal(decoder.cursor, "5");
  }
  const partial = createLiveEventDecoder(() => {}, { cursor: "5" });
  partial.push(bytes('id: 6\nevent: message.created\ndata: {"text":"unfinished'));
  assert.throws(() => partial.finish(), /mid-frame/);
  assert.equal(partial.cursor, "5");
});

test("consumer failure and oversized frames preserve the last acknowledged cursor", () => {
  const decoder = createLiveEventDecoder(() => { throw new Error("consumer failed"); }, { cursor: "5" });
  assert.throws(() => decoder.push(bytes(frame("6", "message.created", {}))), /consumer failed/);
  assert.equal(decoder.cursor, "5");
  const oversized = createLiveEventDecoder(() => {}, { cursor: "5" });
  assert.throws(() => oversized.push(bytes("x".repeat(256 * 1024 + 1))), /too large/);
  assert.equal(oversized.cursor, "5");
  for (const cursor of ["-1", "1.5", "01", "NaN", "9007199254740992"]) assert.equal(validEventCursor(cursor), false);
});
