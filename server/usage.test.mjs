import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUsageStore, normalizeUsage } from "./usage.mjs";

test("normalizeUsage accepts Hermes and OpenAI shapes and ignores empty or junk values", () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }), { input: 10, output: 5, total: 15 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 3, completion_tokens: 4 }), { input: 3, output: 4, total: 7 });
  assert.equal(normalizeUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }), null);
  assert.equal(normalizeUsage(null), null);
  assert.deepEqual(normalizeUsage({ input_tokens: -5, output_tokens: "7", total_tokens: "x" }), { input: 0, output: 7, total: 7 });
});

test("a turn counts once, and the leaderboard ranks people by total with period filters", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-usage-"));
  const store = createUsageStore(path.join(dir, "usage.db"));
  try {
    const now = Date.now();
    assert.equal(store.record({ eventId: "chat:1", userId: "a", source: "chat", usage: { input_tokens: 100, output_tokens: 50 }, at: now }), true);
    assert.equal(store.record({ eventId: "chat:1", userId: "a", source: "chat", usage: { input_tokens: 100, output_tokens: 50 }, at: now }), false, "retry ignored");
    store.record({ eventId: "channel:9", userId: "b", source: "channel", usage: { total_tokens: 400 }, at: now });
    store.record({ eventId: "chat:old", userId: "a", source: "chat", usage: { total_tokens: 1000 }, at: now - 40 * 864e5 });
    assert.equal(store.record({ eventId: "chat:empty", userId: "a", source: "chat", usage: {} }), false);
    const all = store.leaderboard();
    assert.deepEqual(all.people.map(p => [p.userId, p.total]), [["a", 1150], ["b", 400]]);
    assert.deepEqual(all.totals, { input: 100, output: 50, total: 1550, turns: 3 });
    const recent = store.leaderboard({ since: now - 30 * 864e5 });
    assert.deepEqual(recent.people.map(p => [p.userId, p.total, p.chat, p.channel]), [["b", 400, 0, 400], ["a", 150, 150, 0]]);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("members stop at one million tokens a day, the owner never does, and the day resets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-usage-"));
  let now = new Date(2026, 10, 3, 12).getTime();
  const store = createUsageStore(path.join(dir, "usage.db"), { clock: () => now });
  const member = { id: "m", role: "member" }, owner = { id: "o", role: "owner" };
  store.record({ eventId: "a", userId: "m", usage: { total_tokens: 999_999 }, at: now });
  store.record({ eventId: "b", userId: "o", usage: { total_tokens: 9_000_000 }, at: now });
  assert.equal(store.overLimit(member), false);
  store.record({ eventId: "c", userId: "m", usage: { total_tokens: 1 }, at: now });
  assert.equal(store.overLimit(member), true);
  assert.equal(store.overLimit(owner), false);
  assert.equal(store.overLimit({ ...member, unlimitedTokens: true }), false);
  assert.equal(store.overLimit({ id: "other", role: "member" }), false);
  now = new Date(2026, 10, 4, 0, 1).getTime();
  assert.equal(store.overLimit(member), false);
  store.close();
});

test("a conversation's running total is kept per chat", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-usage-"));
  const store = createUsageStore(path.join(dir, "usage.db"));
  store.record({ eventId: "a", userId: "u1", source: "chat", chatId: "c1", usage: { input_tokens: 100, output_tokens: 20 } });
  store.record({ eventId: "b", userId: "u1", source: "chat", chatId: "c1", usage: { input_tokens: 50, output_tokens: 10 } });
  store.record({ eventId: "c", userId: "u1", source: "chat", chatId: "c2", usage: { input_tokens: 5, output_tokens: 5 } });
  assert.deepEqual(store.chatTotals("c1"), { input: 150, output: 30, total: 180, turns: 2 });
  assert.equal(store.chatTotals("none").turns, 0);
  store.close();
});

test("tokens are labelled by survey theme, and the report sets them against survey comments", async () => {
  const { classifyTopic, topicReport, OTHER_THEME } = await import("./usage-topics.mjs");
  assert.equal(OTHER_THEME, "OTHER");
  assert.deepEqual(classifyTopic("Payments: user is not able to save the changes to the scheduled payment"), { theme: "ACCOUNT_CHANGES", kind: "technical_bug" });
  assert.deepEqual(classifyTopic("Customers want a reminder notification before a payment is due"), { theme: "NOTIFICATIONS", kind: "feature_request" });
  assert.equal(classifyTopic("Sign-in: the password screen is broken").theme, "SIGN_IN_OR_ACCESS");
  assert.equal(classifyTopic("Billing: the refund page is slow").theme, "PAYMENTS_OR_BILLING");
  assert.equal(classifyTopic("The example app home screen").theme, "GENERAL_INFORMATION", "product work with no theme falls back");
  assert.equal(classifyTopic("Round search box more pill shape").theme, "OTHER");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-usage-"));
  const store = createUsageStore(path.join(dir, "usage.db"));
  store.record({ eventId: "a", userId: "u", usage: { total_tokens: 900 }, text: "Fix the payment plan cancel flow" });
  store.record({ eventId: "b", userId: "u", usage: { total_tokens: 100 }, text: "Add a pill search box" });
  store.record({ eventId: "c", userId: "u", usage: { total_tokens: 50 } });
  const r = store.topics();
  assert.equal(r.productTokens, 900); assert.equal(r.otherTokens, 100); assert.equal(r.unlabelledTurns, 1);
  assert.equal(r.themes[0].id, "ACCOUNT_CHANGES"); assert.equal(r.themes[0].bugTokens, 900);
  assert.equal(store.backfillTopics({ c: "x", b: "again" }), 1);
  assert.equal(store.topics().unlabelledTurns, 0);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
  // Rows labelled with a theme the dataset no longer has (an older dataset's "other" label included) count as other.
  const old = topicReport([{ theme: "ACCOUNT_CHANGES", total: 70, turns: 1, bug: 0, feature: 0 }, { theme: "NOT_IN_DATASET", total: 20, turns: 2 }, { theme: "OTHER", total: 10, turns: 1 }]);
  assert.deepEqual([old.productTokens, old.otherTokens, old.otherTurns], [70, 30, 3]);
  assert.equal(old.source.dataset, "Example app support feedback");
});

import { agentTierOf, TIER_TOKEN_LIMITS } from './usage.mjs';
test('agent tiers scale the daily limit and tier 0 has no agent', () => {
  const store = createUsageStore(':memory:');
  assert.equal(agentTierOf({ role: 'owner' }), 3);
  assert.equal(agentTierOf({ role: 'member', agentTier: 0 }), 0);
  assert.equal(agentTierOf({ role: 'member' }), 1);
  assert.equal(agentTierOf({ role: 'member', vibeCoder: true }), 2);
  assert.ok(TIER_TOKEN_LIMITS[1] < TIER_TOKEN_LIMITS[2] && TIER_TOKEN_LIMITS[2] < TIER_TOKEN_LIMITS[3]);
  assert.equal(store.overLimit({ id: 'x', role: 'member', agentTier: 0 }), true);
  assert.equal(store.limitFor({ role: 'member', agentTier: 2 }), TIER_TOKEN_LIMITS[2]);
  store.record({ userId: 'u', source: 'chat', usage: { total_tokens: 1_500_000 } });
  assert.equal(store.overLimit({ id: 'u', role: 'member', agentTier: 1 }), true);
  assert.equal(store.overLimit({ id: 'u', role: 'member', agentTier: 2 }), false);
});

test('tier 4 is the researcher: its own limit, never promoted, owner stays 3', () => {
  assert.equal(agentTierOf({ role: 'member', agentTier: 4 }), 4);
  assert.equal(agentTierOf({ role: 'owner', agentTier: 4 }), 3);
  assert.equal(agentTierOf({ role: 'member', agentTier: 5 }), 5);
  assert.equal(agentTierOf({ role: 'member', agentTier: 6 }), 1);
  assert.ok(TIER_TOKEN_LIMITS[4] > 0);
  const store = createUsageStore(':memory:');
  assert.equal(store.limitFor({ role: 'member', agentTier: 4 }), TIER_TOKEN_LIMITS[4]);
  assert.equal(store.overLimit({ id: 'r', role: 'member', agentTier: 4 }), false);
});

test('a personal tokenLimit overrides the tier limit for members only, and must be a known step', () => {
  const store = createUsageStore(':memory:');
  assert.equal(store.limitFor({ role: 'member', agentTier: 1, tokenLimit: 20_000_000 }), 20_000_000);
  assert.equal(store.limitFor({ role: 'member', agentTier: 1, tokenLimit: 123 }), TIER_TOKEN_LIMITS[1]);
  assert.equal(store.limitFor({ role: 'member', agentTier: 0, tokenLimit: 20_000_000 }), 0);
  assert.equal(store.limitFor({ role: 'member', agentTier: 5 }), TIER_TOKEN_LIMITS[5]);
  store.record({ userId: 'u', source: 'chat', usage: { total_tokens: 1_500_000 } });
  assert.equal(store.overLimit({ id: 'u', role: 'member', agentTier: 1 }), true);
  assert.equal(store.overLimit({ id: 'u', role: 'member', agentTier: 1, tokenLimit: 5_000_000 }), false);
});

test("the store adds up tokens in and out since a moment, for pricing a limit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-usage-"));
  const store = createUsageStore(path.join(dir, "usage.db"));
  try {
    const now = Date.now();
    assert.deepEqual(store.mix(), { input: 0, output: 0 });
    store.record({ eventId: "chat:1", userId: "a", source: "chat", usage: { input_tokens: 900, output_tokens: 100 }, at: now });
    store.record({ eventId: "channel:2", userId: "b", source: "channel", usage: { input_tokens: 300, output_tokens: 200 }, at: now - 10 * 864e5 });
    store.record({ eventId: "chat:old", userId: "a", source: "chat", usage: { input_tokens: 5000, output_tokens: 5000 }, at: now - 40 * 864e5 });
    // A turn that reported only a total says nothing about the split, so it adds to neither side.
    store.record({ eventId: "chat:total", userId: "a", source: "chat", usage: { total_tokens: 700 }, at: now });
    assert.deepEqual(store.mix({ since: now - 30 * 864e5 }), { input: 1200, output: 300 });
    assert.deepEqual(store.mix({ since: now - 864e5 }), { input: 900, output: 100 });
    assert.deepEqual(store.mix(), { input: 6200, output: 5300 });
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
