import assert from "node:assert/strict";
import test from "node:test";
import { tweetEmbedUrl, tweetIds, tweetResizeHeight } from "./tweet-embed.ts";

test("finds tweet links on x.com and twitter.com", () => {
  assert.deepEqual(tweetIds("look https://x.com/naval/status/1234567890123456789?s=20 wow"), ["1234567890123456789"]);
  assert.deepEqual(tweetIds("https://twitter.com/jack/status/20"), ["20"]);
  assert.deepEqual(tweetIds("https://mobile.twitter.com/jack/status/1234567890"), ["1234567890"]);
  assert.deepEqual(tweetIds("(https://www.twitter.com/i/web/status/1234567890)."), ["1234567890"]);
});
test("ignores other links and lookalike hosts", () => {
  assert.deepEqual(tweetIds("https://x.com/naval"), []);
  assert.deepEqual(tweetIds("https://notx.com/a/status/1234567890"), []);
  assert.deepEqual(tweetIds("https://x.com.evil.test/a/status/1234567890"), []);
  assert.deepEqual(tweetIds("https://x.com/a/status/12345678x"), []);
  assert.deepEqual(tweetIds(""), []);
});
test("dedupes and caps", () => {
  const t = (n: number) => `https://x.com/a/status/${1000000000 + n}`;
  assert.deepEqual(tweetIds(`${t(1)} ${t(1)} ${t(2)} ${t(3)}`), ["1000000001", "1000000002"]);
});
test("embed url is Twitter's own and carries the id safely", () => {
  const u = new URL(tweetEmbedUrl("123456789", true));
  assert.equal(u.host, "platform.twitter.com");
  assert.equal(u.searchParams.get("id"), "123456789");
  assert.equal(u.searchParams.get("theme"), "dark");
  assert.equal(u.searchParams.get("dnt"), "true");
});
test("reads Twitter's resize message", () => {
  assert.equal(tweetResizeHeight(JSON.stringify({ "twttr.embed": { method: "twttr.private.resize", params: [{ height: 312.4, width: 550 }] } })), 312);
  assert.equal(tweetResizeHeight({ "twttr.embed": { params: [{ height: 5000 }] } }), 900);
  assert.equal(tweetResizeHeight("hello"), null);
  assert.equal(tweetResizeHeight(null), null);
});
