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
  assert.equal(store.overLimit({ id: "other", role: "member" }), false);
  now = new Date(2026, 10, 4, 0, 1).getTime();
  assert.equal(store.overLimit(member), false);
  store.close();
});
