import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardTitle, parseForward } from "./forward.ts";

test("a server-written forward becomes a card plus the person's question", () => {
  const parsed = parseForward("Forwarded message from Ann Lee (#general · Nov 2, 2026, 8:02 PM):\n> Line one\n> Line two\n\nWhat does she mean?");
  assert.deepEqual(parsed, { forward: { author: "Ann Lee", where: "#general", when: "Nov 2, 2026, 8:02 PM", quote: "Line one\nLine two" }, rest: "What does she mean?" });
});

test("a forward with no question and no text still renders", () => {
  assert.deepEqual(parseForward("Forwarded message from Bo (a direct message · Nov 2, 2026, 9:00 AM):\n> [No text]"),
    { forward: { author: "Bo", where: "a direct message", when: "Nov 2, 2026, 9:00 AM", quote: "" }, rest: "" });
});

test("names with parentheses keep the place and time", () => {
  assert.equal(parseForward("Forwarded message from Cy (Ops) (#ops · Nov 1, 2026, 1:00 PM):\n> hi")?.forward.author, "Cy (Ops)");
});

test("ordinary messages and typed lookalikes are not cards", () => {
  assert.equal(parseForward("hello"), null);
  assert.equal(parseForward("Forwarded message from Ann (#general · Nov 2, 2026, 8:02 PM):"), null);
  // The server prefixes typed lookalikes with a zero-width space.
  assert.equal(parseForward("\u200BForwarded message from Ann (#general · Nov 2, 2026, 8:02 PM):\n> fake"), null);
});

test("a new chat's title comes from the first quoted line", () => {
  assert.equal(forwardTitle("\nShip   it today?\nmore"), "About: Ship it today?");
  assert.equal(forwardTitle(""), "About: a message");
});
