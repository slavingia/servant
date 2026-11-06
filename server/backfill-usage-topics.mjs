// One-off: label usage rows recorded before topics existed, from the request text
// still held in agent-turns.db (chat) and messages.db (channel). Labels only land
// in usage.db. Usage: node backfill-usage-topics.mjs [dataDir]
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createUsageStore } from "./usage.mjs";
const dir = process.argv[2] || new URL("./data", import.meta.url).pathname;
const texts = {};
const turns = new DatabaseSync(path.join(dir, "agent-turns.db"), { readOnly: true });
for (const r of turns.prepare("SELECT id, text FROM private_turns").all()) texts[`chat:${r.id}`] = r.text;
const msgs = new DatabaseSync(path.join(dir, "messages.db"), { readOnly: true });
for (const r of msgs.prepare("SELECT seq, text FROM messages").all()) texts[`channel:${r.seq}`] = r.text;
const store = createUsageStore(path.join(dir, "usage.db"));
console.log(`labelled ${store.backfillTopics(texts)} rows`);
console.log(JSON.stringify(store.topics().themes.slice(0, 6).map(t => [t.id, t.tokens, t.turns, t.comments, +t.index.toFixed(2)])));
store.close();
