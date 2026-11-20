// Trust boundaries from docs/architecture/README.md ("Trust boundaries"), crossed on purpose over the real API.
// Each check sends a request that has no right to cross and shows it is refused, not merely undocumented:
// network to API, one person to another person's chats and conversations, a member to owner-only routes, and one
// person's agent to the network access another person was granted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === "API_SERVER_KEY") delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-trust-boundaries-"));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PUSH_CONFIG = path.join(directory, "push.json");
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
const config = { host: "127.0.0.1", port: 0, name: "Example team", agentName: "Agent", publicUrl: "", discoveryUrl: "", adminKey: "", upstreams: {},
  agentEgress: { mode: "ask", port: 0, always: [] }, agentCapabilities: { mode: "ask", waitSeconds: 0 } };

// A stand-in agent: it records which session each turn went to and answers at once.
const turns = [];
const agent = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const json = (status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  if (req.url === "/v1/capabilities") return json(200, { features: { servant_entitlement_checks: true } });
  if (req.method === "POST" && req.url === "/api/sessions") return json(201, { session: { id: "made" } });
  if (req.method === "POST" && req.url.endsWith("/chat/stream")) {
    turns.push({ url: req.url, key: req.headers["x-hermes-session-key"], token: req.headers["x-servant-egress-token"] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    return res.end('event: assistant.completed\ndata: {"content":"Done"}\n\n');
  }
  if (req.method === "GET" && req.url.endsWith("/messages")) return json(200, { data: [] });
  return json(200, { session: { id: "known" } });
});
globalThis.__servantPushSend = async () => ({ ok: true });
const echo = net.createServer(socket => socket.on("data", chunk => socket.write(String(chunk).replace("ping", "pong"))));
globalThis.__servantEgressTest = { resolve: async () => [{ address: "203.0.113.9" }], connect: () => net.connect(echo.address().port, "127.0.0.1") };

const people = { owner: { name: "Ana Ruiz", role: "owner" }, pat: { name: "Pat Tester", role: "member" }, jo: { name: "Jo Park", role: "member" } };
let server, base, mod;
before(async () => {
  await new Promise(done => echo.listen(0, "127.0.0.1", done));
  await new Promise(done => agent.listen(0, "127.0.0.1", done));
  config.upstreams = { owner: { url: `http://127.0.0.1:${agent.address().port}`, key: "fixture-key" } };
  mod = await import("./server.mjs"); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`;
  mod.mutateStateForTest(state => {
    let at = Date.now() - 10_000;
    for (const [key, p] of Object.entries(people)) {
      p.id = `usr_${key}`; p.token = crypto.randomBytes(32).toString("base64url");
      state.users[p.id] = { id: p.id, name: p.name, role: p.role, createdAt: at++, agentTier: 3 };
      state.devices[crypto.createHash("sha256").update(p.token).digest("hex")] = { id: `dev_${key}`, userId: p.id, label: "Phone", createdAt: Date.now(), lastSeenAt: Date.now() };
    }
  });
  while (!mod.egressForTest().port) await new Promise(r => setTimeout(r, 10));
});
after(async () => { await server?.shutdown(); echo.close(); agent.close(); agent.closeAllConnections?.(); delete globalThis.__servantPushSend; delete globalThis.__servantEgressTest; fs.rmSync(directory, { recursive: true, force: true }); });

async function call(token, method, route, body) {
  const response = await testFetch(directory, `${base}/v1/${route}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* a stream */ }
  return { status: response.status, body: json, text };
}
const api = (who, method, route, body) => call(people[who].token, method, route, body);
function connectThrough(target, token) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(mod.egressForTest().port, "127.0.0.1");
    let data = "", sent = false;
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${token ? `Proxy-Authorization: Basic ${Buffer.from(`${token}:x`).toString("base64")}\r\n` : ""}\r\n`));
    socket.on("data", chunk => { data += chunk; if (!sent && data.startsWith("HTTP/1.1 200")) { sent = true; socket.write("ping"); } if (data.includes("pong")) socket.end(); });
    socket.on("close", () => resolve({ status: Number(data.slice(9, 12)), text: data }));
  });
}

test("network to API: plaintext is refused, and an encrypted request without a device token gets nothing", async () => {
  for (const [method, route] of [["GET", "/v1/chats"], ["GET", "/v1/conversations"], ["GET", "/v1/entitlements"]]) {
    const plain = await fetch(base + route, { method });
    assert.equal(plain.status, 426, `${route} in plaintext`);
  }
  for (const route of ["chats", "conversations", "people", "entitlements"]) {
    assert.equal((await call(null, "GET", route)).status, 401, `${route} with no token`);
    assert.equal((await call("made-up-token", "GET", route)).status, 401, `${route} with a made-up token`);
  }
});

test("person to person: a private agent chat and a direct conversation stay closed to everyone outside them", async () => {
  const chat = (await api("pat", "POST", "chats", { shared: false })).body.chat;
  assert.equal((await api("pat", "POST", `chats/${chat.id}/messages`, { text: "my own work" })).status, 200);
  assert.equal((await api("jo", "GET", `chats/${chat.id}/messages`)).status, 404, "Jo can't read Pat's private chat");
  assert.equal((await api("jo", "POST", `chats/${chat.id}/messages`, { text: "let me in" })).status, 404, "nor write in it");
  assert.equal((await api("jo", "DELETE", `chats/${chat.id}`)).status, 404, "nor delete it");
  assert.ok(!(await api("jo", "GET", "chats?scope=org")).body.orgChats.some(c => c.id === chat.id), "nor see it listed");

  const dm = (await api("pat", "POST", "conversations", { kind: "dm", userIds: [people.owner.id] })).body.conversation;
  assert.equal((await api("pat", "POST", `conversations/${dm.id}/messages`, { text: "between us" })).status, 201);
  assert.equal((await api("jo", "GET", `conversations/${dm.id}/messages`)).status, 404, "Jo can't read a DM she isn't in");
  assert.equal((await api("jo", "POST", `conversations/${dm.id}/messages`, { text: "hi" })).status, 404, "nor post in it");
  assert.ok(!(await api("jo", "GET", "conversations")).body.conversations.some(c => c.id === dm.id), "nor see it listed");
});

test("person to agent session: each person's turn goes to their own session, carrying a token for them alone", async () => {
  const pats = (await api("pat", "POST", "chats", {})).body.chat;
  const jos = (await api("jo", "POST", "chats", {})).body.chat;
  const from = turns.length;
  await api("pat", "POST", `chats/${pats.id}/messages`, { text: "pat's turn" });
  await api("jo", "POST", `chats/${jos.id}/messages`, { text: "jo's turn" });
  const [pat, jo] = turns.slice(from);
  assert.ok(pat.key.endsWith(pats.id) && jo.key.endsWith(jos.id), "a session per chat");
  assert.notEqual(pat.url, jo.url);
  assert.equal(pat.token, mod.egressForTest().mint(people.pat.id, pats.id), "Pat's turn carries Pat's token");
  assert.equal(jo.token, mod.egressForTest().mint(people.jo.id, jos.id));
});

test("member to owner: owner-only routes refuse a member", async () => {
  for (const [method, route, body] of [["GET", "devices"], ["POST", "invites", { fresh: true }], ["GET", "entitlements/actions"], ["POST", "entitlements", { name: "Mine", hosts: ["example.gov"] }],
    ["PATCH", `people/${people.jo.id}`, { agentTier: 3 }], ["PUT", `people/${people.pat.id}/manager`, { managerId: people.pat.id }]]) {
    const r = await api("pat", method, route, body);
    assert.equal(r.status, 403, `${method} ${route}: ${r.text}`);
  }
});

test("agent to network: one person's agent can't use what another person was granted, and a forged token is nobody", async () => {
  const id = (await api("owner", "POST", "entitlements", { name: "Tax data API", hosts: ["api.example.gov"] })).body.entitlement.id;
  assert.equal((await api("jo", "POST", `entitlements/${id}/request`, { confirmed: true })).status, 201);
  assert.equal((await api("owner", "POST", `entitlements/${id}/people/${people.jo.id}`, { decision: "grant" })).status, 200);
  { const r = await connectThrough("api.example.gov:443", mod.egressForTest().mint(people.jo.id, "cht_jo")); assert.equal(r.status, 200, "Jo holds it: " + JSON.stringify(r.text)); }
  assert.equal((await connectThrough("api.example.gov:443", mod.egressForTest().mint(people.pat.id, "cht_pat"))).status, 403, "Pat doesn't");
  // A token made up, or Jo's token with Pat's name swapped in, is nobody's.
  const [, chatPart, signature] = mod.egressForTest().mint(people.jo.id, "cht_jo").split(".");
  const swapped = `${Buffer.from(people.pat.id).toString("base64url")}.${chatPart}.${signature}`;
  for (const forged of ["made.up.token", swapped]) {
    assert.equal((await connectThrough("api.example.gov:443", forged)).status, 403);
    const asked = await fetch(`http://127.0.0.1:${mod.egressForTest().port}/use`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: forged, needs: ["fs-read"], detail: "Read README.md" }) });
    assert.equal(asked.status, 403, "the tool check doesn't know whose turn it is");
    assert.equal((await asked.json()).verdict, "deny");
  }
  // Pat's own built-in entitlement is asked of Pat's manager; Jo's standing doesn't count for Pat.
  const pats = await fetch(`http://127.0.0.1:${mod.egressForTest().port}/use`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: mod.egressForTest().mint(people.pat.id, "cht_pat"), needs: ["fs-write"], detail: "Write notes.md" }) });
  assert.notEqual((await pats.json()).verdict, "allow");
});
