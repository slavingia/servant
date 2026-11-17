// Production runs the API and the push worker as separate processes (docs/deployment.md). Code requests live only in
// the API's memory, so the worker must still alert the person's phone when one is made, and must not alert once the
// request has expired or the API that made it has dropped it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === "API_SERVER_KEY") delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-code-requests-worker-"));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = "external";
process.env.SERVANT_PUSH_CONFIG = path.join(directory, "push.json");
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
const config = { host: "127.0.0.1", port: 0, name: "Example team", agentName: "Agent", publicUrl: "", discoveryUrl: "", adminKey: "", upstreams: {} };

const pushes = [];
globalThis.__servantPushSend = async (target, notification) => { pushes.push({ to: target.token, ...notification }); return { ok: true }; };
const devices = { phone: { label: "Phone", push: true }, runner: { label: "QA runner" } };
let server, base, worker, mod;
before(async () => {
  mod = await import("./server.mjs");
  server = await mod.startServer(config);
  base = `http://127.0.0.1:${server.address().port}`;
  mod.mutateStateForTest(state => {
    state.users.usr_pat = { id: "usr_pat", name: "Pat Tester", role: "owner", createdAt: Date.now() };
    for (const [key, d] of Object.entries(devices)) {
      d.token = crypto.randomBytes(32).toString("base64url");
      state.devices[crypto.createHash("sha256").update(d.token).digest("hex")] = { id: `dev_${key}`, userId: "usr_pat", label: d.label, createdAt: Date.now(), lastSeenAt: Date.now(),
        ...(d.push ? { push: { platform: "ios", token: `push-${key}`, environment: "production" } } : {}) };
    }
  });
  // The worker process's own services, as worker.mjs builds them: no access to the API's code requests.
  // A second module instance has its own empty memory, like worker.mjs in its own process.
  const workerModule = await import(`./server.mjs?worker=${Date.now()}`);
  worker = workerModule.createWorkerServices();
});
after(async () => {
  await server?.shutdown();
  try { worker?.push.close?.(); worker?.agentTurns?.close(); worker?.messaging.close(); worker?.closeState?.(); } catch { /* already closed */ }
  delete globalThis.__servantPushSend;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function api(who, method, route, body) {
  const response = await testFetch(directory, `${base}/v1/${route}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${devices[who].token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}

test("the separate push worker alerts the phone for a code request the API holds", async () => {
  pushes.length = 0;
  const made = await api("runner", "POST", "code-requests", { label: "Login.gov sign-in", hint: "Texted to the number ending 0000" });
  assert.equal(made.status, 201);
  await worker.push.drain();
  assert.equal(pushes.length, 1, "the worker sent the alert instead of dropping it");
  const [alert] = pushes;
  assert.equal(alert.to, "push-phone");
  assert.equal(alert.title, "Code needed");
  assert.equal(alert.body, "QA runner is waiting for your Login.gov sign-in code");
  assert.deepEqual(alert.data, { userId: "usr_pat", deviceId: "dev_phone", codeRequestId: made.body.request.id });
  assert.ok(!JSON.stringify(alert).includes("0000"), "the hint stays in the app, not in the alert");
});

test("the worker sends nothing for a code request that has already expired", async () => {
  pushes.length = 0;
  const made = await api("runner", "POST", "code-requests", { label: "Expired sign-in", ttlSeconds: 60 });
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try { await worker.push.drain(); } finally { Date.now = realNow; }
  assert.equal(pushes.length, 0);
  await api("runner", "POST", `code-requests/${made.body.request.id}/cancel`);
});

test("a request cancelled before its alert is sent is not alerted by a process that holds it", async () => {
  pushes.length = 0;
  const made = await api("runner", "POST", "code-requests", { label: "Cancelled sign-in" });
  await api("runner", "POST", `code-requests/${made.body.request.id}/cancel`);
  // The API process itself holds the request, as a single-process install does: it drops the cancelled one.
  const api_services = mod.createWorkerServices();
  try { await api_services.push.drain(); } finally { api_services.push.close?.(); api_services.agentTurns?.close(); api_services.messaging.close(); api_services.closeState?.(); }
  assert.equal(pushes.length, 0);
});
