import { test } from "node:test";
import assert from "node:assert/strict";
import { autoTitle, autoTitleDue, cleanChatTitle, titleFromReply, titleTranscript } from "./chat-title.mjs";

test("chat titles: what someone types is one trimmed line", () => {
  assert.equal(cleanChatTitle("  Refunds\n for   Q3 "), "Refunds for Q3");
  assert.equal(cleanChatTitle("x".repeat(200)).length, 80);
  assert.equal(cleanChatTitle(null), "");
});

test("chat titles: named at 4 messages and again at 16, never when named by hand", () => {
  assert.equal(autoTitleDue({}, 3), null);
  assert.equal(autoTitleDue({}, 4), 4);
  assert.equal(autoTitleDue({ autoTitledAt: 4 }, 10), null);
  assert.equal(autoTitleDue({ autoTitledAt: 4 }, 16), 16);
  assert.equal(autoTitleDue({}, 20), 16, "a long chat seen late is named once, at the latest mark");
  assert.equal(autoTitleDue({ autoTitledAt: 16 }, 400), null);
  assert.equal(autoTitleDue({ titledBy: "user" }, 4), null);
  assert.equal(autoTitleDue({ deletedAt: 1 }, 4), null);
});

test("chat titles: the reply is cleaned into a title, or refused", () => {
  assert.equal(titleFromReply('Title: "Refund backlog for Q3."'), "Refund backlog for Q3");
  assert.equal(titleFromReply("**Fixing the login bug**\n\nBecause…"), "Fixing the login bug");
  assert.equal(titleFromReply(""), "");
  assert.equal(titleFromReply("this is far too long to be a title for anything at all really"), "");
});

test("chat titles: the namer reads the latest messages, cut short", () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i} ` + "x".repeat(1000) }));
  const t = titleTranscript(messages);
  assert.equal(t.split("\n").length, 12);
  assert.ok(t.startsWith("Person: m8 "));
  assert.ok(t.split("\n").every(line => line.length < 620));
});

test("chat titles: autoTitle saves only when due, and never throws", async () => {
  const chat = {};
  const messages = [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c" }, { role: "assistant", text: "d" }];
  const saved = [];
  const deps = { read: () => ({ chat, messages }), ask: async () => "Letters a to d", write: (id, title, due) => { saved.push([id, title, due]); return true; } };
  assert.equal(await autoTitle("c1", deps), "Letters a to d");
  assert.deepEqual(saved, [["c1", "Letters a to d", 4]]);
  assert.equal(await autoTitle("c1", { ...deps, ask: null }), null);
  assert.equal(await autoTitle("c1", { ...deps, ask: async () => { throw new Error("down"); } }), null);
  assert.equal(await autoTitle("c1", { ...deps, read: () => ({ chat: { titledBy: "user" }, messages }) }), null);
});
