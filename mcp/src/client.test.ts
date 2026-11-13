import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkspace } from "./client.ts";

const key = "02" + "ab".repeat(32);
test("workspace from an invite link, a hub link or JSON", () => {
  assert.deepEqual(parseWorkspace(`servant://pair?code=X&key=${key}&server=https://a.example/`), { server: "https://a.example", serverKey: key });
  assert.deepEqual(parseWorkspace(`https://servant.example/join?hub=https://b.example&key=${key}&discovery=https://g.example/x.json`), { server: "https://b.example", serverKey: key, discovery: "https://g.example/x.json" });
  assert.deepEqual(parseWorkspace(JSON.stringify({ server: "https://c.example/", serverKey: key })), { server: "https://c.example", serverKey: key });
  assert.deepEqual(parseWorkspace(`servant://pair?code=X&key=${key}&d=https://g.example/h.json`), { server: "", serverKey: key, discovery: "https://g.example/h.json" });
  assert.throws(() => parseWorkspace("servant://pair?code=X"), /no server address and key/);
});
