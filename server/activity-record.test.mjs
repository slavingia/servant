// The agent action log and the gate's connection record are the source of truth for what agents did (diagram 02,
// "Append-only agent action log and recorded gate connections"). They are written before the action, not after it:
// these tests break the write on purpose and show the action is then refused, so the record can't fall behind
// what the agent actually did.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { testFetch } from "./encrypted-test-client.mjs";

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === "API_SERVER_KEY") delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-activity-record-"));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PUSH_CONFIG = path.join(directory, "push.json");
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
const config = { host: "127.0.0.1", port: 0, name: "Example team", agentName: "Agent", publicUrl: "", discoveryUrl: "", adminKey: "", upstreams: {},
  agentEgress: { mode: "ask", port: 0, always: ["models.example.gov"] }, agentCapabilities: { mode: "ask", waitSeconds: 0 } };
globalThis.__servantPushSend = async () => ({ ok: true });
const echo = net.createServer(socket => socket.on("data", chunk => socket.write(String(chunk).replace("ping", "pong"))));
globalThis.__servantEgressTest = { resolve: async () => [{ address: "203.0.113.9" }], connect: () => net.connect(echo.address().port, "127.0.0.1") };

const owner = { id: "usr_owner", name: "Ana Ruiz", token: crypto.randomBytes(32).toString("base64url") };
let server, base, mod;
before(async () => {
  await new Promise(done => echo.listen(0, "127.0.0.1", done));
  mod = await import("./server.mjs"); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`;
  mod.mutateStateForTest(state => {
    state.users[owner.id] = { id: owner.id, name: owner.name, role: "owner", createdAt: Date.now() - 1000, agentTier: 3 };
    state.devices[crypto.createHash("sha256").update(owner.token).digest("hex")] = { id: "dev_owner", userId: owner.id, label: "Phone", createdAt: Date.now(), lastSeenAt: Date.now() };
  });
  while (!mod.egressForTest().port) await new Promise(r => setTimeout(r, 10));
});
after(async () => { await server?.shutdown(); echo.close(); delete globalThis.__servantPushSend; delete globalThis.__servantEgressTest; fs.rmSync(directory, { recursive: true, force: true }); });

const actionLog = async () => (await (await testFetch(directory, `${base}/v1/entitlements/actions`, { headers: { Authorization: `Bearer ${owner.token}` } })).json()).actions;
const use = async detail => (await fetch(`http://127.0.0.1:${mod.egressForTest().port}/use`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: mod.egressForTest().mint(owner.id, "cht_audit"), needs: ["fs-write"], detail }) })).json();
function connectThrough(target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(mod.egressForTest().port, "127.0.0.1");
    let data = "", sent = false;
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", chunk => { data += chunk; if (!sent && data.startsWith("HTTP/1.1 200")) { sent = true; socket.write("ping"); } if (data.includes("pong")) socket.end(); });
    socket.on("close", () => resolve({ status: Number(data.slice(9, 12)), text: data }));
  });
}
// Break one table's inserts from outside, the way a full disk or a locked file would, then mend it.
function breakInserts(file, table) {
  const db = new DatabaseSync(path.join(directory, file));
  db.exec(`CREATE TRIGGER break_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  return () => { db.exec(`DROP TRIGGER break_${table}`); db.close(); };
}

test("a checked tool call is in the action log before it is allowed; one that can't be logged is refused", async () => {
  assert.equal((await use("Write notes.md")).verdict, "allow");
  assert.deepEqual((await actionLog()).map(a => [a.detail, a.verdict]), [["Write notes.md", "allowed-owner"]]);
  const mend = breakInserts("entitlements.db", "actions");
  try {
    const refused = await use("Write secret.md");
    assert.equal(refused.verdict, "deny", "not logged, not done");
    assert.match(refused.message, /couldn't record this, so it wasn't done/);
  } finally { mend(); }
  assert.deepEqual((await actionLog()).map(a => a.detail), ["Write notes.md"], "the log shows nothing that was allowed without it");
  assert.equal((await use("Write notes2.md")).verdict, "allow", "allowed again once the log can be written");
});

test("a connection the gate lets through is recorded before it is made; one that can't be recorded isn't made", async () => {
  assert.equal((await connectThrough("models.example.gov:443")).status, 200);
  const count = () => { const db = new DatabaseSync(path.join(directory, "egress.db"), { readOnly: true }); try { return db.prepare("SELECT COALESCE(SUM(connections),0) AS n FROM reached WHERE host='models.example.gov'").get().n; } finally { db.close(); } };
  assert.equal(count(), 1);
  const mend = breakInserts("egress.db", "reached");
  try {
    const refused = await connectThrough("models.example.gov:443");
    assert.equal(refused.status, 403);
    assert.match(refused.text, /could not record this connection, so it was not made/);
    assert.doesNotMatch(refused.text, /pong/, "no bytes went through");
  } finally { mend(); }
  assert.equal(count(), 1, "the record matches what went through");
});

test("the action log can't be changed or deleted, even from outside the server", () => {
  const db = new DatabaseSync(path.join(directory, "entitlements.db"));
  try {
    assert.throws(() => db.exec("UPDATE actions SET verdict='allowed'"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM actions"), /append-only/);
  } finally { db.close(); }
});
