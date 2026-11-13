import test from "node:test";
import assert from "node:assert/strict";
import { getWebWorkspace, validWorkspace } from "./desktop.ts";

const KEY = "02" + "ab".repeat(32);
const good = JSON.stringify({ server: "https://servant.example.com", serverKey: KEY, discovery: "https://gist.githubusercontent.com/x/raw/hub.json" });

test("a web workspace needs a browser, a valid key and an https server", () => {
  // No window (node): never a workspace, so store builds and tests are unaffected.
  assert.equal(getWebWorkspace(good), null);
  (globalThis as any).window = {};
  try {
    assert.deepEqual(getWebWorkspace(good), JSON.parse(good));
    assert.equal(getWebWorkspace(undefined), null, "not configured: the normal welcome screen");
    assert.equal(getWebWorkspace("not json"), null);
    assert.equal(getWebWorkspace(JSON.stringify({ server: "https://servant.example.com", serverKey: "nope" })), null);
    assert.equal(getWebWorkspace(JSON.stringify({ server: "http://servant.example.com", serverKey: KEY })), null, "plain http is refused");
    assert.equal(getWebWorkspace(JSON.stringify({ server: "https://user:pw@servant.example.com", serverKey: KEY })), null);
    assert.equal(getWebWorkspace(JSON.stringify({ server: "https://servant.example.com", serverKey: KEY, discovery: "http://x.example/hub.json" })), null);
    assert.equal(getWebWorkspace(JSON.stringify({ server: "http://127.0.0.1:8787", serverKey: KEY }))?.server, "http://127.0.0.1:8787", "loopback http is fine for local testing");
    // The Mac app keeps using its own bundled workspace, never this one.
    (globalThis as any).window = { servantDesktop: { platform: "macos" } };
    assert.equal(getWebWorkspace(good), null);
  } finally { delete (globalThis as any).window; }
  assert.equal(validWorkspace(null), null);
});
