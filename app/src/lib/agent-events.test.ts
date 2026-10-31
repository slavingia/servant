import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentEventDecoder, parseAgentEvent, type StreamEvent } from "./agent-events.ts";

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
