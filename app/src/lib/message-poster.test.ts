import { test } from "node:test";
import assert from "node:assert/strict";
import { messagePerson, parsePoster } from "./message-poster.ts";
import { parseAgentEvent } from "./agent-events.ts";

const jo = { id: "jo", name: "Jo Park" };

test("a message the owner posted in Jo Park's chat is shown under the owner, not Jo Park", () => {
  assert.deepEqual(messagePerson({ postedBy: { id: "pat", name: "Pat Tester" } }, jo), { id: "pat", name: "Pat Tester" });
});

test("a message with no poster belongs to the chat's author", () => {
  assert.deepEqual(messagePerson({}, jo), jo);
  assert.deepEqual(messagePerson({ postedBy: { id: 4, name: "" } }, jo), jo);
  assert.equal(parsePoster("Pat"), undefined);
});

test("the poster survives the live 'sent' event", () => {
  const sent = parseAgentEvent("sent", { message: { id: "u1", role: "user", text: "Hi", postedBy: { id: "pat", name: "Pat Tester" } } });
  assert.equal(sent?.type, "sent");
  if (sent?.type === "sent") assert.deepEqual(sent.message.postedBy, { id: "pat", name: "Pat Tester" });
});
