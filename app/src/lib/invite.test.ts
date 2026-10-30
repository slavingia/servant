import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvite } from "./invite.ts";

const D = "https://gist.githubusercontent.com/u/abc/raw/hub.json";

test("reads a discovery invite link", () => {
  const link = `servant://pair?code=ABCDE-FGH23&d=${encodeURIComponent(D)}`;
  assert.deepEqual(parseInvite(link), { code: "ABCDE-FGH23", server: undefined, discovery: D });
});

test("finds the link inside a pasted message", () => {
  const msg = `You're invited. Open this on your phone: servant://pair?code=abcde-fgh23&hub=https%3A%2F%2Fx.trycloudflare.com`;
  assert.equal(parseInvite(msg)?.server, "https://x.trycloudflare.com");
  assert.equal(parseInvite(msg)?.code, "ABCDE-FGH23");
});

test("reads the newer server= parameter too", () => {
  const link = "servant://pair?code=ABCDE-FGH23&server=https%3A%2F%2Fy.trycloudflare.com";
  assert.equal(parseInvite(link)?.server, "https://y.trycloudflare.com");
});

test("rejects junk and unsafe servers", () => {
  assert.equal(parseInvite("hello"), null);
  assert.equal(parseInvite("servant://pair?code=ABCDE-FGH23"), null);
  assert.equal(parseInvite("servant://pair?code=nope&d=" + encodeURIComponent(D)), null);
  assert.equal(parseInvite("servant://pair?code=ABCDE-FGH23&d=" + encodeURIComponent("http://evil.example/h.json")), null);
  assert.equal(parseInvite("servant://pair?code=ABCDE-FGH23&hub=javascript%3Aalert(1)"), null);
  assert.equal(parseInvite("servant://pair?code=ABCDE-FGH23&server=javascript%3Aalert(1)"), null);
});
