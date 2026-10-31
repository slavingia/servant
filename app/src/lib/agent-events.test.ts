import { test } from "node:test";
import assert from "node:assert/strict";
import { bufferAgentReply, createAgentEventDecoder, parseAgentEvent, type StreamEvent } from "./agent-events.ts";

const photo = { id: "chat_file_1", name: "Lake.jpg", mime: "image/jpeg", size: 1200 };
const frame = (name: string, value: unknown) => `event: ${name}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;

test("fragmented streams retain accepted image-only messages and assistant images", () => {
  const received: StreamEvent[] = [];
  const decoder = createAgentEventDecoder(event => received.push(event));
  const wire = new TextEncoder().encode(
    frame("sent", { message: { id: "user_1", role: "user", text: "", at: 10, attachments: [photo] } })
    + frame("delta", { text: "Beautiful 湖" })
    + frame("message", { id: "agent_1", text: "Beautiful 湖", at: 11, attachments: [{ ...photo, id: "chat_file_2" }] })
    + frame("done", {}),
  );
  for (let i = 0; i < wire.length; i += 7) decoder.push(wire.slice(i, i + 7));
  decoder.finish();
  assert.equal(received[0].type, "sent");
  if (received[0].type === "sent") assert.deepEqual(received[0].message.attachments, [photo]);
  assert.deepEqual(received[1], { type: "delta", text: "Beautiful 湖" });
  assert.equal(received[2].type, "message");
  if (received[2].type === "message") assert.equal(received[2].attachments?.[0].id, "chat_file_2");
  assert.deepEqual(received[3], { type: "done" });
});

test("older text-only message events still render and keepalives are ignored", () => {
  const received: StreamEvent[] = [];
  const decoder = createAgentEventDecoder(event => received.push(event));
  decoder.push(new TextEncoder().encode(': keepalive\n\nevent: message\ndata: {"text":"Hello"}\n\nevent: done\ndata: {}\n\n'));
  decoder.finish();
  assert.equal(received.length, 2);
  assert.equal(received[0].type === "message" && received[0].text, "Hello");
});

test("broken streams cannot report a completed turn", () => {
  const events: StreamEvent[] = [];
  const partial = createAgentEventDecoder(event => events.push(event));
  partial.push(new TextEncoder().encode('event: message\ndata: {"attachments":'));
  assert.throws(() => partial.finish(), /mid-frame/);
  const missingDone = createAgentEventDecoder(event => events.push(event));
  missingDone.push(new TextEncoder().encode(frame("delta", { text: "Partial" })));
  assert.throws(() => missingDone.finish(), /before completion/);
  assert.equal(events.some(event => event.type === "done"), false);
});

test("invalid attachment acknowledgements never clear an unsent image draft", () => {
  assert.equal(parseAgentEvent("sent", { message: { id: "u1", role: "user", text: "", attachments: [{ ...photo, id: "../../private" }] } }), null);
  assert.equal(parseAgentEvent("sent", { message: { id: "a1", role: "assistant", text: "hello" } }), null);
  const result = parseAgentEvent("message", { text: "Image", attachments: [{ ...photo, url: "https://example.test/private" }] });
  assert.deepEqual(result?.type === "message" && result.attachments, [photo]);
});

test("completed replies arrive once while acknowledgements, work, and approvals remain live", () => {
  const received: StreamEvent[] = [];
  const decoder = createAgentEventDecoder(bufferAgentReply(event => received.push(event)));
  const push = (wire: string) => {
    const bytes = new TextEncoder().encode(wire);
    for (let i = 0; i < bytes.length; i += 7) decoder.push(bytes.slice(i, i + 7));
  };
  const turn = { id: "turn_1", chatId: "chat_1", status: "waiting_for_approval", accepted: true, text: "Draw", assistantText: "Draft", canStop: true, createdAt: 10, updatedAt: 11 };
  const approval = { id: "approval_1", command: "draw", description: "Draw the image", choices: ["once", "deny"] };
  push(frame("sent", { message: { id: "user_1", role: "user", text: "Draw", at: 10 } })
    + frame("delta", { text: "Draft 湖" })
    + frame("status", { text: "Working" })
    + frame("turn", { turn })
    + frame("approval", { approval })
    + frame("message", { id: "reply_1", text: "Superseded caption", at: 12 })
    + frame("message", { id: "reply_1", text: "", at: 12, attachments: [photo] }));
  assert.deepEqual(received.map(event => event.type), ["sent", "status", "turn", "approval"]);
  push(frame("turn", { turn: { ...turn, status: "completed", updatedAt: 12 } }) + frame("done", {}));
  decoder.finish();
  assert.deepEqual(received.slice(-2), [
    { type: "message", id: "reply_1", text: "", at: 12, attachments: [photo] },
    { type: "done" },
  ]);
  push(frame("done", {}) + frame("delta", { text: "Late draft" }));
  assert.equal(received.filter(event => event.type === "message").length, 1);
  assert.equal(received.filter(event => event.type === "done").length, 1);
});

test("a connection lost before done cannot display buffered text or media", () => {
  const received: StreamEvent[] = [];
  const decoder = createAgentEventDecoder(bufferAgentReply(event => received.push(event)));
  decoder.push(new TextEncoder().encode(frame("delta", { text: "Partial" })
    + frame("message", { id: "reply_1", text: "Unconfirmed reply", attachments: [photo] })));
  assert.throws(() => decoder.finish(), /before completion/);
  assert.deepEqual(received, []);
});

test("legacy delta-only replies publish together after done", () => {
  const received: StreamEvent[] = [];
  const buffer = bufferAgentReply(event => received.push(event));
  buffer({ type: "delta", text: "Hello " });
  buffer({ type: "delta", text: "there" });
  assert.deepEqual(received, []);
  buffer({ type: "done" });
  assert.deepEqual(received, [{ type: "message", text: "Hello there" }, { type: "done" }]);
});

test("failed, stopped, interrupted, and unconfirmed turns never publish draft deltas as completed replies", () => {
  for (const status of ["running", "failed", "cancelled", "interrupted"] as const) {
    const received: StreamEvent[] = [];
    const buffer = bufferAgentReply(event => received.push(event));
    buffer({ type: "delta", text: "Unfinished thought" });
    buffer({ type: "turn", turn: { id: "turn_1", chatId: "chat_1", status, accepted: true, text: "Question", assistantText: "Unfinished thought", canStop: false, createdAt: 10, updatedAt: 11 } });
    buffer({ type: "done" });
    assert.deepEqual(received.map(event => event.type), ["turn", "done"]);
  }
  const received: StreamEvent[] = [];
  const buffer = bufferAgentReply(event => received.push(event));
  buffer({ type: "delta", text: "Unfinished thought" });
  buffer({ type: "error", message: "The agent stopped" });
  buffer({ type: "done" });
  assert.deepEqual(received, [{ type: "error", message: "The agent stopped" }, { type: "done" }]);
});
