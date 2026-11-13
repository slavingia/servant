import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createStateStore } from "./state-store.mjs";
import { testFetch } from "./encrypted-test-client.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-loops-"));
process.env.SERVANT_DATA_DIR = directory;
const token = "loops-member-device";
let server, base, state, fake, asked = [];

before(async () => {
  fake = http.createServer((req, res) => {
    asked.push(req.url);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jobs: [{ id: "a1", name: "Hourly watch (safety net)", prompt: "SECRET", script: "s.sh", schedule: { kind: "cron", expr: "0 * * * *" }, enabled: true, state: "scheduled", last_run_at: "2026-11-12T17:00:00Z", last_status: "ok", next_run_at: "2026-11-12T18:00:00Z" }] }));
  });
  await new Promise(r => fake.listen(0, "127.0.0.1", r));
  const up = { url: `http://127.0.0.1:${fake.address().port}`, key: "k" };
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 0, name: "Loops test", publicUrl: "https://loops.example.test", upstreams: { owner: up, member: up, researcher: up } }));
  state = createStateStore({ directory });
  state.mutate(s => {
    s.users.m = { id: "m", name: "Member", role: "member", agentTier: 1 };
    s.devices[crypto.createHash("sha256").update(token).digest("hex")] = { id: "m-device", userId: "m" };
  });
  const { startServer } = await import("./server.mjs");
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { await server?.shutdown(); state?.close(); fake?.close(); fs.rmSync(directory, { recursive: true, force: true }); });

const get = who => testFetch(directory, `${base}/v1/loops`, { headers: who ? { Authorization: `Bearer ${token}` } : {} });

test("signed-out people cannot see loops", async () => {
  assert.equal((await get(false)).status, 401);
});

test("any member sees the agent's loops, with nothing private in them", async () => {
  const r = await get(true);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.available, true);
  assert.equal(body.loops.length, 1);
  assert.equal(body.loops[0].name, "Hourly watch");
  assert.equal(body.loops[0].cadence, "Every hour");
  assert.ok(!JSON.stringify(body).includes("SECRET"));
  assert.deepEqual(asked, ["/api/jobs?include_disabled=true"]);
  await get(true);
  assert.equal(asked.length, 1, "a second look inside 30 seconds is served from the cache");
});
