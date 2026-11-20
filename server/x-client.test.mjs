// The X client against a stand-in for the network: what is signed, what is asked for, and what is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXClient, oauthHeader, readPost, xKeys, xLength } from "./x-client.mjs";

const keys = { apiKey: "xvz1evFS4wEEPTGEFPHBog", apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", accessTokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" };

test("a request is signed the way X's own worked example is", () => {
  // The example in X's "Creating a signature" guide: these inputs give this signature.
  const header = oauthHeader({ method: "POST", url: "https://api.twitter.com/1.1/statuses/update.json", keys, nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: 1318622958,
    query: { include_entities: "true", status: "Hello Ladies + Gentlemen, a signed OAuth request!" } });
  assert.match(header, /^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", /);
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});

test("the four values come from config.json or the environment, and all four are needed", () => {
  assert.equal(xKeys({ apiKey: "a", apiSecret: "b", accessToken: "c" }, {}), null);
  assert.deepEqual(xKeys({ apiKey: " a ", apiSecret: "b", accessToken: "c", accessTokenSecret: "d" }, {}), { apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: "d" });
  assert.equal(xKeys({}, { SERVANT_X_API_KEY: "a", SERVANT_X_API_SECRET: "b", SERVANT_X_ACCESS_TOKEN: "c", SERVANT_X_ACCESS_TOKEN_SECRET: "d" }).accessTokenSecret, "d");
});

test("length is counted the way X counts it", () => {
  assert.equal(xLength("Hello"), 5);
  assert.equal(xLength("See https://example.gov/a/very/long/address/that/goes/on/and/on?with=things for more"), 4 + 23 + 9);
  assert.equal(xLength("日本語"), 6);
  assert.equal(xLength("é"), 1);
  assert.equal(xLength("ok 👍"), 5);
});

test("a post is reduced to what Servant keeps, and its address is built from its id", () => {
  const users = new Map([["7", { id: "7", name: "Jo Park\u0000", username: "jopark", profile_image_url: "https://pbs.twimg.com/profile_images/1/a_normal.jpg" }]]);
  const post = readPost({ id: "1900000000000000001", author_id: "7", text: "Where is the form?", created_at: "2026-11-20T15:00:00.000Z", public_metrics: { like_count: 3, retweet_count: -1 }, url: "https://evil.example/x" }, users);
  assert.deepEqual(post, { remoteId: "1900000000000000001", authorId: "7", authorHandle: "jopark", authorName: "Jo Park", authorAvatar: "https://pbs.twimg.com/profile_images/1/a_normal.jpg",
    text: "Where is the form?", postedAt: Date.parse("2026-11-20T15:00:00.000Z"), url: "https://x.com/jopark/status/1900000000000000001", likes: 3, reposts: 0, replies: 0 });
  assert.equal(readPost({ id: "not-an-id", text: "x" }, users), null);
  // A picture from anywhere but X's own image host is dropped, and a bad handle is not used in an address.
  const odd = readPost({ id: "5", author_id: "8", text: "hi" }, new Map([["8", { username: "bad/handle", profile_image_url: "https://evil.example/a.png" }]]));
  assert.deepEqual([odd.authorAvatar, odd.authorHandle, odd.url, odd.authorName], ["", "", "https://x.com/i/status/5", "Someone on X"]);
});

test("mentions, search and a reply ask X for the right things, signed", async () => {
  const calls = [];
  const answer = (status, body, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body });
  const x = createXClient({ keys, api: "http://x.test/", fetch: async (url, init) => {
    calls.push({ url: new URL(url), method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const { pathname } = new URL(url);
    if (pathname === "/2/users/me") return answer(200, { data: { id: "42", username: "exampleorg", name: "Example Org" } });
    if (pathname === "/2/tweets" && init.method === "POST") return answer(201, { data: { id: "99", text: "hi" } });
    return answer(200, { data: [{ id: "11", author_id: "7", text: "hello @exampleorg", created_at: "2026-11-20T15:00:00.000Z" }], includes: { users: [{ id: "7", username: "jopark", name: "Jo Park" }] } });
  } });
  assert.deepEqual(await x.me(), { id: "42", handle: "exampleorg", name: "Example Org" });
  const mentions = await x.mentions("42", "10");
  assert.deepEqual([mentions.length, mentions[0].authorHandle], [1, "jopark"]);
  assert.deepEqual([calls[1].url.pathname, calls[1].url.searchParams.get("since_id"), calls[1].url.searchParams.get("expansions")], [`/2/users/${"42"}/mentions`, "10", "author_id"]);
  await x.search("\"Example Org\" -is:retweet");
  assert.deepEqual([calls[2].url.pathname, calls[2].url.searchParams.get("query"), calls[2].url.searchParams.has("since_id")], ["/2/tweets/search/recent", "\"Example Org\" -is:retweet", false]);
  assert.deepEqual(await x.post("Thanks for asking.", "11"), { id: "99" });
  assert.deepEqual(calls[3].body, { text: "Thanks for asking.", reply: { in_reply_to_tweet_id: "11" } });
  await x.post("An announcement.");
  assert.deepEqual(calls[4].body, { text: "An announcement." });
  for (const call of calls) assert.match(call.auth, /^OAuth .*oauth_signature="[^"]+"/);
});

test("X's refusals come back in words, and a rate limit says when to try again", async () => {
  const answer = (status, body, headers = {}) => async () => ({ ok: false, status, headers: new Headers(headers), json: async () => body });
  const failing = fetch => createXClient({ keys, api: "http://x.test", fetch }).post("hi").then(() => assert.fail("should refuse"), error => error);
  const limited = await failing(answer(429, {}, { "x-rate-limit-reset": "1800000000" }));
  assert.deepEqual([limited.code, limited.retryAt], ["x_rate_limit", 1800000000000]);
  assert.equal((await failing(answer(401, {}))).code, "x_keys");
  const refused = await failing(answer(403, { detail: "You are not allowed to create a Tweet with duplicate content." }));
  assert.deepEqual([refused.code, refused.message], ["x_refused", "X refused this: You are not allowed to create a Tweet with duplicate content."]);
  assert.equal((await failing(async () => { throw new Error("socket hang up"); })).code, "x_unreachable");
  assert.equal((await failing(answer(500, {}))).message, "X returned 500");
});
