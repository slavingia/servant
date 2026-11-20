// The code-request path against the real API, tried the wrong way round: by someone who is not signed in, by
// someone else, from a device that was signed out, out of order, and by sending a captured request again.
// (docs/code-requests.md, docs/architecture/05-code-request-delivery.) Expiry by the clock is in code-requests.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === "API_SERVER_KEY") delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-code-requests-identity-"));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PUSH_CONFIG = path.join(directory, "push.json");
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
const config = { host: "127.0.0.1", port: 0, name: "Example team", agentName: "Agent", publicUrl: "", discoveryUrl: "", adminKey: "", upstreams: {} };
globalThis.__servantPushSend = async () => ({ ok: true });

const devices = { phone: { user: "pat", label: "Phone" }, runner: { user: "pat", label: "QA runner" }, old: { user: "pat", label: "Old laptop" }, jo: { user: "jo", label: "Phone" } };
const hash = token => crypto.createHash("sha256").update(token).digest("hex");
let server, base, mod;
before(async () => {
  mod = await import("./server.mjs"); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`;
  mod.mutateStateForTest(state => {
    state.users.usr_pat = { id: "usr_pat", name: "Pat Tester", role: "owner", createdAt: Date.now() - 2 };
    state.users.usr_jo = { id: "usr_jo", name: "Jo Park", role: "member", createdAt: Date.now() - 1 };
    for (const [key, d] of Object.entries(devices)) {
      d.token = crypto.randomBytes(32).toString("base64url");
      state.devices[hash(d.token)] = { id: `dev_${key}`, userId: `usr_${d.user}`, label: d.label, createdAt: Date.now(), lastSeenAt: Date.now() };
    }
  });
});
after(async () => { await server?.shutdown(); delete globalThis.__servantPushSend; fs.rmSync(directory, { recursive: true, force: true }); });

async function call(token, method, route, body) {
  const response = await testFetch(directory, `${base}/v1/${route}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
const api = (who, method, route, body) => call(devices[who].token, method, route, body);
const ask = async (who = "runner", extra = {}) => (await api(who, "POST", "code-requests", { label: "Example sign-in", ...extra })).body.request.id;
const code = result => result.body.error?.code;

test("identity: every step needs the person's own signed-in device, and the request names nobody the token doesn't", async () => {
  const id = await ask();
  // Not signed in, a made-up token, and a device that has since been signed out.
  for (const token of [null, crypto.randomBytes(32).toString("base64url")]) {
    for (const [method, route, body] of [["POST", "code-requests", { label: "x" }], ["GET", "code-requests"], ["GET", `code-requests/${id}`], ["POST", `code-requests/${id}/answer`, { code: "123456" }], ["POST", `code-requests/${id}/claim`], ["POST", `code-requests/${id}/cancel`]]) {
      assert.equal((await call(token, method, route, body)).status, 401, `${method} ${route} ${token ? "with a made-up token" : "signed out"}`);
    }
  }
  mod.mutateStateForTest(state => { state.devices[hash(devices.old.token)].revokedAt = Date.now(); });
  assert.equal((await api("old", "POST", `code-requests/${id}/answer`, { code: "123456" })).status, 401, "a signed-out device of the same person");
  assert.equal((await api("old", "GET", "code-requests")).status, 401);

  // Outside the encrypted transport nothing on this path answers at all.
  const plain = await fetch(`${base}/v1/code-requests/${id}/answer`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${devices.phone.token}` }, body: JSON.stringify({ code: "123456" }) });
  assert.ok(plain.status >= 400, `a plain request is refused (${plain.status})`);

  // Someone else on the server, holding the id: every step says it doesn't exist, and nothing about it leaks.
  for (const [method, route, body] of [["GET", `code-requests/${id}`], ["POST", `code-requests/${id}/answer`, { code: "123456" }], ["POST", `code-requests/${id}/claim`], ["POST", `code-requests/${id}/cancel`]]) {
    const result = await api("jo", method, route, body);
    assert.deepEqual([result.status, code(result)], [404, "not_found"], `${method} ${route} as someone else`);
    assert.ok(!JSON.stringify(result.body).includes("Example sign-in"));
  }
  assert.equal((await api("phone", "GET", `code-requests/${id}`)).body.request.status, "pending", "none of that touched it");

  // Who a request belongs to comes from the token. Naming someone else in the body changes nothing.
  const spoofed = await api("jo", "POST", "code-requests", { label: "Jo's own", userId: "usr_pat", deviceId: "dev_runner", device: "QA runner" });
  assert.equal(spoofed.status, 201);
  assert.equal(spoofed.body.request.device, "Phone", "the device name is the caller's own");
  assert.ok(!(await api("phone", "GET", "code-requests")).body.requests.some(r => r.id === spoofed.body.request.id), "Pat never sees it");
  assert.ok((await api("jo", "GET", "code-requests")).body.requests.some(r => r.id === spoofed.body.request.id));

  // The asking device can't answer its own request, and the answering device can't pick the code up.
  assert.deepEqual([(await api("runner", "POST", `code-requests/${id}/answer`, { code: "123456" })).status], [403]);
  await api("phone", "POST", `code-requests/${id}/answer`, { code: "123456" });
  assert.equal((await api("phone", "POST", `code-requests/${id}/claim`)).status, 404);
  assert.deepEqual((await api("runner", "POST", `code-requests/${id}/claim`)).body, { status: "answered", code: "123456" });
});

test("lifecycle: asked, answered, picked up once; no step can be skipped, repeated or done after the end", async () => {
  // Picking up before the answer gives no code.
  const id = await ask();
  assert.deepEqual(Object.keys((await api("runner", "POST", `code-requests/${id}/claim`)).body).sort(), ["expiresAt", "status"]);
  // A code that isn't one is refused and the request stays open.
  assert.deepEqual([(await api("phone", "POST", `code-requests/${id}/answer`, { code: "<script>" })).status, (await api("phone", "GET", `code-requests/${id}`)).body.request.status], [400, "pending"]);
  // Answered once: a second answer can't replace the code.
  assert.equal((await api("phone", "POST", `code-requests/${id}/answer`, { code: "111111" })).status, 200);
  const second = await api("phone", "POST", `code-requests/${id}/answer`, { code: "222222" });
  assert.deepEqual([second.status, code(second)], [410, "code_request_answered"]);
  // Picked up once: the first pick-up gets the first code, every later one gets nothing.
  assert.deepEqual((await api("runner", "POST", `code-requests/${id}/claim`)).body, { status: "answered", code: "111111" });
  for (let i = 0; i < 3; i++) assert.deepEqual((await api("runner", "POST", `code-requests/${id}/claim`)).body, { status: "claimed" });
  // After the end: no answer, and cancelling doesn't bring it back.
  assert.equal(code(await api("phone", "POST", `code-requests/${id}/answer`, { code: "333333" })), "code_request_claimed");
  assert.equal((await api("phone", "POST", `code-requests/${id}/cancel`)).body.request.status, "claimed");
  assert.ok(!(await api("phone", "GET", "code-requests")).body.requests.some(r => r.id === id), "no longer waiting");

  // Cancelled after it was answered: the code is gone before anyone picked it up.
  const stopped = await ask();
  await api("phone", "POST", `code-requests/${stopped}/answer`, { code: "444444" });
  assert.equal((await api("runner", "POST", `code-requests/${stopped}/cancel`)).body.request.status, "cancelled");
  assert.deepEqual((await api("runner", "POST", `code-requests/${stopped}/claim`)).body, { status: "cancelled" });
  assert.equal(code(await api("phone", "POST", `code-requests/${stopped}/answer`, { code: "555555" })), "code_request_cancelled");

  // An id that was never issued, or is not shaped like one, is simply not there.
  for (const bad of ["code_AAAAAAAAAAAA", "code_../../state", "nope"]) assert.equal((await api("phone", "POST", `code-requests/${encodeURIComponent(bad)}/answer`, { code: "123456" })).status, 404, bad);
});

test("replay: an answer or a pick-up captured off the wire can't be sent again", async () => {
  const id = await ask();
  // Record exactly what the app puts on the wire for one request, then send the same bytes a second time.
  const recorded = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { recorded.push({ input, init: { ...init } }); return realFetch(input, init); };
  let answered, picked;
  try {
    answered = await api("phone", "POST", `code-requests/${id}/answer`, { code: "777777" });
    const answerOnWire = recorded.pop();
    picked = await api("runner", "POST", `code-requests/${id}/claim`);
    const claimOnWire = recorded.pop();
    assert.equal(answered.status, 200);
    assert.deepEqual(picked.body, { status: "answered", code: "777777" });
    for (const [name, wire] of [["the answer", answerOnWire], ["the pick-up", claimOnWire]]) {
      assert.ok(wire?.init?.body, `${name} was captured`);
      // What travels is not readable: neither the code nor the token is in it.
      const bytes = Buffer.from(typeof wire.init.body === "string" ? wire.init.body : await new Response(wire.init.body).arrayBuffer());
      assert.ok(!bytes.includes("777777") && !bytes.includes(devices.phone.token) && !bytes.includes(devices.runner.token), `${name} on the wire carries no readable code or token`);
      const again = await realFetch(wire.input, { ...wire.init, body: bytes });
      const refusal = await again.clone().text();
      assert.ok(again.status >= 400, `${name} sent again is refused (${again.status})`);
      // The same bytes the server accepted a moment ago: refused the second time, with the transport's one answer for anything it won't open.
      assert.deepEqual([again.status, JSON.parse(refusal).error.code], [400, "encrypted_request_invalid"]);
      assert.ok(!Buffer.from(await again.arrayBuffer()).includes("777777"), `${name} sent again gives no code back`);
    }
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual((await api("runner", "POST", `code-requests/${id}/claim`)).body, { status: "claimed" }, "and the request is where it was");
});
