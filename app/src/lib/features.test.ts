import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_FEATURES, anyTalk, conversationHidden, landingHref, normalizeFeatures, sameFeatures, tabsFor, withDeepWork } from "./features.ts";

const off = { channels: false, directMessages: false, meetings: false, secureInbox: false };

test("every flag is on unless the server said exactly false", () => {
  assert.deepEqual(normalizeFeatures(undefined), ALL_FEATURES);
  assert.deepEqual(normalizeFeatures(null), ALL_FEATURES);
  assert.deepEqual(normalizeFeatures("nope"), ALL_FEATURES);
  assert.deepEqual(normalizeFeatures([]), ALL_FEATURES);
  assert.deepEqual(normalizeFeatures({ channels: "false", directMessages: 0, meetings: null }), ALL_FEATURES);
  assert.deepEqual(normalizeFeatures({ meetings: false }), { ...ALL_FEATURES, meetings: false });
  assert.deepEqual(normalizeFeatures({ ...off, other: false }), off);
  assert.ok(sameFeatures(normalizeFeatures({}), ALL_FEATURES));
  assert.ok(!sameFeatures(normalizeFeatures({ channels: false }), ALL_FEATURES));
});

test("tabs: Home first with channels; the agent first without; People and You always stay", () => {
  assert.deepEqual(tabsFor(ALL_FEATURES), ["channels", "messages", "agent", "members", "you"]);
  assert.deepEqual(tabsFor({ ...ALL_FEATURES, directMessages: false }), ["channels", "agent", "members", "you"]);
  assert.deepEqual(tabsFor({ ...ALL_FEATURES, channels: false }), ["agent", "messages", "members", "you"]);
  assert.deepEqual(tabsFor(off), ["agent", "members", "you"]);
  // Meetings have no tab; the flag changes nothing here.
  assert.deepEqual(tabsFor({ ...ALL_FEATURES, meetings: false }), tabsFor(ALL_FEATURES));
});

test("the landing screen follows Home: the agent when channels are off", () => {
  assert.equal(landingHref(ALL_FEATURES), "/channels");
  assert.equal(landingHref({ ...ALL_FEATURES, directMessages: false, meetings: false }), "/channels");
  assert.equal(landingHref({ ...ALL_FEATURES, channels: false }), "/agent");
  assert.equal(landingHref(off), "/agent");
});

test("deep work hides channels, DMs and meetings on top of the server's flags, and never turns one back on", () => {
  assert.deepEqual(withDeepWork(ALL_FEATURES, true), off);
  assert.equal(withDeepWork(ALL_FEATURES, false), ALL_FEATURES, "off: the server's flags, untouched");
  assert.deepEqual(withDeepWork({ ...ALL_FEATURES, meetings: false }, true), off);
  assert.deepEqual(withDeepWork(off, true), off);
  const serverSaysNoChannels = { ...ALL_FEATURES, channels: false };
  assert.deepEqual(withDeepWork(serverSaysNoChannels, false), serverSaysNoChannels, "switching deep work off never grants what the server has off");
  // Everything the hiding hangs on follows: only Agent, People and You remain, the app lands on the agent, and no channel or DM opens.
  assert.deepEqual(tabsFor(withDeepWork(ALL_FEATURES, true)), ["agent", "members", "you"]);
  assert.equal(landingHref(withDeepWork(ALL_FEATURES, true)), "/agent");
  assert.ok(conversationHidden("ch_abc", withDeepWork(ALL_FEATURES, true)) && conversationHidden("dm_abc", withDeepWork(ALL_FEATURES, true)));
  assert.ok(!conversationHidden("cht_abc", withDeepWork(ALL_FEATURES, true)), "agent chats stay");
  assert.ok(!anyTalk(withDeepWork(ALL_FEATURES, true)));
});

test("conversation ids the app must not open, and whether there is anywhere left to talk", () => {
  assert.equal(conversationHidden("ch_abc", ALL_FEATURES), false);
  assert.equal(conversationHidden("ch_abc", { ...ALL_FEATURES, channels: false }), true);
  assert.equal(conversationHidden("dm_abc", { ...ALL_FEATURES, channels: false }), false);
  assert.equal(conversationHidden("dm_abc", { ...ALL_FEATURES, directMessages: false }), true);
  assert.equal(conversationHidden("cht_abc", off), false, "agent chats are never hidden");
  assert.equal(conversationHidden(undefined, off), false);
  assert.ok(anyTalk(ALL_FEATURES) && anyTalk({ ...off, channels: true }) && anyTalk({ ...off, directMessages: true }));
  assert.ok(!anyTalk(off));
});

test("secure inbox defaults on, can be hidden independently, and participates in flag refresh", () => {
  assert.equal(normalizeFeatures({}).secureInbox, true);
  assert.equal(normalizeFeatures({ secureInbox: false }).secureInbox, false);
  assert.ok(!sameFeatures(ALL_FEATURES, { ...ALL_FEATURES, secureInbox: false }));
  assert.deepEqual(tabsFor({ ...ALL_FEATURES, secureInbox: false }), tabsFor(ALL_FEATURES));
});
