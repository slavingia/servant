// One-off: label usage rows recorded before topics existed, from the request text
// still held in agent-turns.db (chat) and messages.db (channel). Labels only land
// in usage.db. Usage: node backfill-usage-topics.mjs [dataDir]
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { createUsageStore } from "./usage.mjs";
const dir = process.argv[2] || new URL("./data", import.meta.url).pathname;
const texts = {};
const turns = new DatabaseSync(path.join(dir, "agent-turns.db"), { readOnly: true });
for (const r of turns.prepare("SELECT id, text FROM private_turns").all()) texts[`chat:${r.id}`] = r.text;
const msgs = new DatabaseSync(path.join(dir, "messages.db"), { readOnly: true });
for (const r of msgs.prepare("SELECT seq, text FROM messages").all()) texts[`channel:${r.seq}`] = r.text;
// Uses the same usageTopics words as the server (config.json in the data dir).
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")); } catch { return {}; } })();
const store = createUsageStore(path.join(dir, "usage.db"), { topics: () => cfg.usageTopics || {} });
console.log(`labelled ${store.backfillTopics(texts)} rows`);
console.log(JSON.stringify(store.topics().themes.slice(0, 6).map(t => [t.id, t.tokens, t.turns, t.comments, +t.index.toFixed(2)])));
store.close();
