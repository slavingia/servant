import assert from "node:assert/strict";
import test from "node:test";
import { clearScreenCaches, createEarlyRequests, createScreenCache, newestPage } from "./screen-cache.ts";

test("a screen gets back what it last showed", () => {
  const cache = createScreenCache<{ posts: string[] }>();
  assert.equal(cache.get("a:c1"), undefined);
  const shown = { posts: ["hello"] };
  cache.set("a:c1", shown);
  assert.equal(cache.get("a:c1"), shown);
  assert.equal(cache.get("a:c2"), undefined);
  // Another account's key never reads this one.
  assert.equal(cache.get("b:c1"), undefined);
  cache.delete("a:c1");
  assert.equal(cache.get("a:c1"), undefined);
});

test("only the screens gone back to most are kept", () => {
  const cache = createScreenCache<number>(3);
  cache.set("one", 1); cache.set("two", 2); cache.set("three", 3);
  // Opening "one" again keeps it; the oldest unopened one goes when a fourth arrives.
  assert.equal(cache.get("one"), 1);
  cache.set("four", 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("two"), undefined);
  assert.deepEqual([cache.get("one"), cache.get("three"), cache.get("four")], [1, 3, 4]);
  // Saving again replaces without growing.
  cache.set("one", 10);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("one"), 10);
});

test("signing out or changing account drops everything every screen kept", async () => {
  const conversations = createScreenCache<string>();
  const chats = createScreenCache<string>();
  const early = createEarlyRequests<Promise<string>>();
  conversations.set("a:c1", "posts");
  chats.set("a:chat1", "messages");
  early.start("a:c1", 0, async () => "on its way");
  clearScreenCaches();
  assert.equal(conversations.get("a:c1"), undefined);
  assert.equal(chats.get("a:chat1"), undefined);
  assert.equal(early.take("a:c1"), null);
});

test("a request started at the press is the one the screen uses, once", async () => {
  let clock = 1000, calls = 0;
  const early = createEarlyRequests<Promise<string>>(5000, () => clock);
  early.start("c1", 7, async () => { calls++; return "first page"; });
  // A second press on the same row does not ask twice.
  early.start("c1", 9, async () => { calls++; return "again"; });
  assert.equal(calls, 1);
  clock += 300;
  // Looking leaves it for the screen that takes it.
  assert.equal(await early.peek("c1")?.result, "first page");
  const taken = early.take("c1");
  assert.equal(taken?.mark, 7);
  assert.equal(await taken?.result, "first page");
  // Taken once: the screen's later reloads make their own request.
  assert.equal(early.take("c1"), null);
  assert.equal(early.peek("c1"), null);
  assert.equal(early.take("never-started"), null);
});

test("a request too old to trust is not used, and a new press starts another", async () => {
  let clock = 0, calls = 0;
  const early = createEarlyRequests<Promise<number>>(5000, () => clock);
  early.start("c1", 0, async () => ++calls);
  clock = 5001;
  assert.equal(early.take("c1"), null);
  early.start("c1", 0, async () => ++calls);
  clock = 9000;
  early.start("c1", 0, async () => ++calls);
  assert.equal(calls, 2, "the request from 5001 is still fresh at 9000");
  clock = 11000;
  early.start("c1", 0, async () => ++calls);
  assert.equal(calls, 3);
  assert.equal(await early.take("c1")?.result, 3);
});

test("several requests can be started together and awaited one by one", async () => {
  const early = createEarlyRequests<{ info: Promise<string>; messages: Promise<string[]> }>();
  early.start("chat1", 0, () => ({ info: Promise.resolve("mine"), messages: Promise.resolve(["hello"]) }));
  // One part answers a question before the screen exists; the screen then takes all of it.
  assert.equal(await early.peek("chat1")!.result.info, "mine");
  const taken = early.take("chat1")!.result;
  assert.deepEqual(await taken.messages, ["hello"]);
  assert.equal(early.peek("chat1"), null);
});

test("what is kept is the newest page, like a fresh open", () => {
  const posts = Array.from({ length: 120 }, (_, i) => i);
  const kept = newestPage(posts, false, 50);
  assert.equal(kept.items.length, 50);
  assert.deepEqual([kept.items[0], kept.items[49]], [70, 119]);
  assert.equal(kept.more, true, "older messages were left out, so the list can load them again");
  assert.deepEqual(newestPage([1, 2, 3], false, 50), { items: [1, 2, 3], more: false });
  assert.deepEqual(newestPage([1, 2, 3], true, 50), { items: [1, 2, 3], more: true });
  const exact = Array.from({ length: 50 }, (_, i) => i);
  assert.equal(newestPage(exact, false, 50).more, false);
  assert.notEqual(newestPage(exact, false, 50).items, exact);
});

// The screens that use it.
const read = async (file: string) => (await import("node:fs")).readFileSync((await import("node:path")).join(import.meta.dirname, "..", file), "utf8");

test("an open conversation starts from what it last showed, and keeps what it shows", async () => {
  const source = await read("app/c/[id].tsx");
  assert.match(source, /useState\(\(\) => keptConversation\(account, id\)\)/);
  assert.match(source, /useState<Post\[\] \| null>\(kept\?\.posts \?\? null\)/, "the messages are there on the first frame");
  assert.match(source, /kept\?\.conversation \?\? peek\(id\) \?\? null/, "a first visit takes its title from the list");
  // The first fresh copy replaces what was kept, and only a loaded conversation is kept.
  assert.match(source, /replace: reset \|\| needsSnapshot\.current \|\| showingKept\.current/);
  assert.match(source, /else if \(posts !== null && loaded\.current\) keepConversation\(account, id, \{ conversation: conv, joined, posts, more \}\)/);
  assert.match(source, /if \(unavailable\) forgetConversation\(account, id\)/);
});

test("a conversation's request leaves at the press, and the screen takes that one", async () => {
  for (const file of ["components/ChannelList.tsx", "app/(tabs)/messages.tsx", "components/Sidebar.tsx"]) {
    const source = await read(file);
    const at = source.indexOf("openingConversation(account,");
    assert.ok(at > 0, file);
    assert.ok(source.indexOf('pathname: "/c/[id]"', at) > at, `${file}: the request starts before navigating`);
  }
  const screen = await read("app/c/[id].tsx");
  assert.match(screen, /const early = reset \? null : earlyConversation\(account, id\);/);
  assert.match(screen, /\(early\?\.result \?\? fetchConversation\(account, id\)\)\.then\(/);
  // Anything that arrived between the press and the screen listening sends it back for a fresh copy.
  assert.match(screen, /if \(early && liveEventCount\(id\) !== early\.mark\) reload\.current\(\);/);
});

test("kept screens are dropped when the signed-in account changes", async () => {
  const session = await read("lib/session.tsx");
  const changed = session.slice(session.indexOf("if (credentialChanged) {"));
  assert.match(changed.slice(0, changed.indexOf("}")), /clearScreenCaches\(\);/);
  // Nothing kept is written to the device.
  assert.doesNotMatch(await read("lib/screen-cache.ts"), /setItem|SecureStore|localStorage|AsyncStorage/);
  assert.doesNotMatch(await read("lib/conversation-cache.ts"), /setItem|SecureStore|localStorage|AsyncStorage/);
});
