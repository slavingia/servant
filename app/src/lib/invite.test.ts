import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { INVITE_EXAMPLE, parseInvite } from "./invite.ts";

const D = "https://gist.githubusercontent.com/u/abc/raw/hub.json";

test("preserves the pinned encryption key and rejects malformed pins", () => {
  const key = '02' + 'ab'.repeat(32);
  const link = `servant://pair?code=ABCDE-FGH23&d=${encodeURIComponent(D)}&key=${key}`;
  assert.equal(parseInvite(link)?.serverKey, key);
  assert.equal(parseInvite(link.replace(key, 'bad-key')), null);
});

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

test("the web invite link (https://<server>/join?…) parses like the servant:// one", () => {
  const key = "02" + "ab".repeat(32);
  const web = `https://servant.example.com/join?code=ZFB5W-UKJ68&key=${key}&d=${encodeURIComponent("https://gist.githubusercontent.com/x/raw/hub.json")}`;
  const got = parseInvite(`Tap to join: ${web}`);
  assert.equal(got?.code, "ZFB5W-UKJ68");
  assert.equal(got?.serverKey, key);
  assert.equal(parseInvite("https://servant.example.com/other?code=ZFB5W-UKJ68&d=https://x.y/z"), null);
});

// Welcome says only "Paste your invite link". The example under the field shows what one looks like, so a person
// can tell the link from the sentence around it in the message they were sent.
test("Welcome shows what an invite link looks like, and the example has a real link's shape", () => {
  const url = new URL(INVITE_EXAMPLE);
  assert.equal(url.protocol, "https:");
  assert.equal(url.pathname, "/join", "the web form of an invite");
  assert.match(url.hostname, /(^|\.)example\.gov$/, "a placeholder address, nobody's real server");
  // With where the server is (which a real link also carries), the example is a link the app accepts.
  assert.equal(parseInvite(`${INVITE_EXAMPLE}&server=${encodeURIComponent("https://servant.example.gov")}`)?.code, "ABCDE-FGH23");
  const welcome = fs.readFileSync(path.join(import.meta.dirname, "../app/welcome.tsx"), "utf8");
  assert.match(welcome, /<Text nativeID="inviteExample" style=\{styles\.hint\}>Example: \{INVITE_EXAMPLE\}<\/Text>/, "under the label, where it stays while typing");
  assert.match(welcome, /aria-describedby="inviteExample"/, "and a screen reader hears it with the field");
  assert.match(fs.readFileSync(path.join(import.meta.dirname, "../app/join-server.tsx"), "utf8"), /Example: \{INVITE_EXAMPLE\}/, "the same on Join another server");
});
