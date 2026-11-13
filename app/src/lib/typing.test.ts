import { test } from "node:test";
import assert from "node:assert/strict";
import { typingText } from "./typing-text.ts";

test("agent replying", () => {
  assert.equal(typingText(["Agent"]), "Agent is replying…");
  assert.equal(typingText(["Pat", "Agent"]), "Pat is typing · Agent is replying…");
  assert.equal(typingText(["Pat"]), "Pat is typing…");
});
