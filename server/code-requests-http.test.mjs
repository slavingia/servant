// Code requests over the real API: a runner signed in as Pat asks for a code, Pat's phone gets an alert that names
// the request but not the code, Pat answers from the phone and the runner picks the code up exactly once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === "API_SERVER_KEY") delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-code-requests-http-"));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PUSH_CONFIG = path.join(directory, "push.json");
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
const config = { host: "127.0.0.1", port: 0, name: "Example team", agentName: "Agent", publicUrl: "", discoveryUrl: "", adminKey: "", upstreams: {} };

const pushes = [];
globalThis.__servantPushSend = async (target, notification) => { pushes.push({ to: target.token, ...notification }); return { ok: true }; };
const devices = { phone: { user: "pat", label: "Phone", push: true }, runner: { user: "pat", label: "QA runner" }, jo: { user: "jo", label: "Phone", push: true } };
let server, base, mod;
before(async () => {
  mod = await import("./server.mjs"); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`;
  mod.mutateStateForTest(state => {
    state.users.usr_pat = { id: "usr_pat", name: "Pat Tester", role: "owner", createdAt: Date.now() - 2 };
    state.users.usr_jo = { id: "usr_jo", name: "Jo Park", role: "member", createdAt: Date.now() - 1 };
    for (const [key, d] of Object.entries(devices)) {
      d.token = crypto.randomBytes(32).toString("base64url");
      state.devices[crypto.createHash("sha256").update(d.token).digest("hex")] = { id: `dev_${key}`, userId: `usr_${d.user}`, label: d.label, createdAt: Date.now(), lastSeenAt: Date.now(),
        ...(d.push ? { push: { platform: "ios", token: `push-${key}`, environment: "production" } } : {}) };
    }
  });
});
after(async () => { await server?.shutdown(); delete globalThis.__servantPushSend; fs.rmSync(directory, { recursive: true, force: true }); });

async function api(who, method, route, body) {
  const response = await testFetch(directory, `${base}/v1/${route}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${devices[who].token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function pushed(count) {
  for (let i = 0; i < 300 && pushes.length < count; i++) await new Promise(r => setTimeout(r, 20));
  return pushes.splice(0);
}

test("a runner asks, the phone is alerted and answers, the runner picks up the code once", async () => {
  const made = await api("runner", "POST", "code-requests", { label: "Login.gov sign-in", hint: "Texted to the number ending 0000" });
  assert.equal(made.status, 201);
  const id = made.body.request.id;
  assert.equal(made.body.request.device, "QA runner");

  const [alert, ...others] = await pushed(1);
  assert.equal(others.length, 0, "only Pat's phone, not the runner (no push token) and not Jo");
  assert.equal(alert.to, "push-phone");
  assert.equal(alert.title, "Code needed");
  assert.equal(alert.body, "QA runner is waiting for your Login.gov sign-in code");
  assert.deepEqual(alert.data, { userId: "usr_pat", deviceId: "dev_phone", codeRequestId: id });

  assert.deepEqual((await api("phone", "GET", "code-requests")).body.requests.map(r => r.id), [id]);
  assert.deepEqual((await api("jo", "GET", "code-requests")).body.requests, []);
  assert.equal((await api("jo", "POST", `code-requests/${id}/answer`, { code: "999999" })).status, 404);
  assert.equal((await api("runner", "POST", `code-requests/${id}/claim`)).body.status, "pending");

  const answered = await api("phone", "POST", `code-requests/${id}/answer`, { code: "554 100" });
  assert.equal(answered.status, 200);
  assert.ok(!JSON.stringify(answered.body).includes("554100"), "the phone's response does not echo the code");
  assert.equal((await api("phone", "POST", `code-requests/${id}/claim`)).status, 404, "the phone cannot pick it up");
  assert.deepEqual((await api("runner", "POST", `code-requests/${id}/claim`)).body, { status: "answered", code: "554100" });
  assert.deepEqual((await api("runner", "POST", `code-requests/${id}/claim`)).body, { status: "claimed" });
  assert.ok(!fs.readdirSync(directory, { recursive: true }).some(name => {
    const file = path.join(directory, String(name));
    return fs.statSync(file).isFile() && fs.readFileSync(file).includes("554100");
  }), "the code is never written to the data directory");
});

test("a cancelled request is not alerted and cannot be answered", async () => {
  const made = await api("runner", "POST", "code-requests", { label: "Login.gov sign-in" });
  const id = made.body.request.id;
  await pushed(1);
  assert.equal((await api("runner", "POST", `code-requests/${id}/cancel`)).body.request.status, "cancelled");
  assert.equal((await api("phone", "POST", `code-requests/${id}/answer`, { code: "123456" })).status, 410);
  assert.equal((await api("runner", "POST", "code-requests", {})).status, 400);
});

// Read SSE from /v1/events until `want` matches or time runs out.
async function events(who, want, ms = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const seen = [];
  try {
    const response = await testFetch(directory, `${base}/v1/events`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${devices[who].token}`, Accept: "text/event-stream" }, body: "{}", signal: ctrl.signal });
    const reader = response.body.getReader(); let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      for (const block of text.split("\n\n").slice(0, -1)) {
        const event = /event: (.+)/.exec(block)?.[1], data = /data: (.+)/.exec(block)?.[1];
        if (event && !seen.some(s => s.raw === block)) seen.push({ raw: block, event, data: data ? JSON.parse(data) : null });
      }
      if (want(seen)) break;
    }
  } catch { /* aborted */ } finally { clearTimeout(timer); ctrl.abort(); }
  return seen.map(({ event, data }) => ({ event, data }));
}

test("an open app hears about a new code request at once: only its id, only for its own person", async () => {
  const patStream = events("phone", seen => seen.some(e => e.event === "code.requested"));
  const joStream = events("jo", () => false, 1500);
  await new Promise(r => setTimeout(r, 400));
  const made = await api("runner", "POST", "code-requests", { label: "Login.gov sign-in", hint: "Texted to the number ending 0000" });
  assert.equal(made.status, 201);
  const pat = await patStream;
  const heard = pat.filter(e => e.event === "code.requested");
  assert.deepEqual(heard, [{ event: "code.requested", data: { requestId: made.body.request.id } }], "just the id: no label, hint or code");
  assert.ok(!(await joStream).some(e => e.event === "code.requested"), "nobody else hears about it");
  await pushed(1);
  await api("phone", "POST", `code-requests/${made.body.request.id}/cancel`);
});
