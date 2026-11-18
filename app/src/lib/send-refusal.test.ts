// Why a message did not send stays on screen until the person sends again (send-refusal.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refusedByServer } from "./send-refusal.ts";

test("the server saying no to a message is a refusal; a failed connection is not", () => {
  for (const status of [400, 403, 409, 413, 429]) assert.equal(refusedByServer({ status }), true, String(status));
  for (const error of [{ status: 0 }, { status: 500 }, { status: 502 }, {}, null, undefined, new Error("offline"), { status: "400" }]) assert.equal(refusedByServer(error), false);
});

test("the agent chat keeps a refusal until the next send: looking at the conversation again does not clear it", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../app/chat/[id].tsx"), "utf8");
  // "That looks like a GitHub token. Use Connections so it stays out of chat." was shown for under half a second
  // before the next refresh of the conversation wiped it, so the message seemed to vanish for no reason.
  assert.match(source, /setLoadError\(null\); if \(!refused\.current\) setSendError\(null\);/, "a refresh leaves a refusal where it is");
  assert.doesNotMatch(source, /setLoadError\(null\); setSendError\(null\);/);
  assert.equal(source.match(/refused\.current = refusedByServer\(e\)/g)?.length, 2, "both ways a message is sent (now, and waiting behind a reply) remember a refusal");
  assert.equal(source.match(/refused\.current = false;/g)?.length, 2, "and the next send starts clean");
});
