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
  const { classifyTopic } = await import("./usage-topics.mjs");
  assert.deepEqual(classifyTopic("Payment plan: user is not able to save the changes to the scheduled payment"), { theme: "MANAGE_MODIFY_OR_REINSTATE", kind: "technical_bug" });
  assert.equal(classifyTopic("Round search box more pill shape").theme, "NOT_IRS_APP");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-usage-"));
  const store = createUsageStore(path.join(dir, "usage.db"));
  store.record({ eventId: "a", userId: "u", usage: { total_tokens: 900 }, text: "Fix the payment plan cancel flow" });
  store.record({ eventId: "b", userId: "u", usage: { total_tokens: 100 }, text: "Add a pill search box" });
  store.record({ eventId: "c", userId: "u", usage: { total_tokens: 50 } });
  const r = store.topics();
  assert.equal(r.irsAppTokens, 900); assert.equal(r.otherTokens, 100); assert.equal(r.unlabelledTurns, 1);
  assert.equal(r.themes[0].id, "STATUS_CANCELLATION_OR_DEFAULT"); assert.equal(r.themes[0].bugTokens, 900);
  assert.equal(store.backfillTopics({ c: "x", b: "again" }), 1);
  assert.equal(store.topics().unlabelledTurns, 0);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});
