// Entitlements over the real API, with the agent's network gate on: a person asks and confirms, their manager is
// told and grants, and only then does that person's agent get through the proxy. Managers come from who invited
// whom, from "invite your manager", or from an owner's choice.
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
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-entitlements-http-"));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PUSH_CONFIG = path.join(directory, "push.json");
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
const config = { host: "127.0.0.1", port: 0, name: "Example team", agentName: "Agent", publicUrl: "", discoveryUrl: "", adminKey: "", upstreams: {},
  agentEgress: { mode: "ask", port: 0, always: ["models.example.gov"] }, agentCapabilities: { mode: "ask", waitSeconds: 0 } };
// A stand-in for the agent: it records what each turn was sent with and holds the reply until the test lets go.
const turns = [];
let release = () => {}, checksSupported = true;
const agent = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const json = (status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  // An agent whose bridge asks before a tool call (and has no durable runs, so turns stream).
  if (req.url === "/v1/capabilities") return json(200, { features: { servant_entitlement_checks: checksSupported } });
  if (req.method === "POST" && req.url === "/api/sessions") return json(201, { session: { id: "made" } });
  if (req.method === "POST" && req.url.endsWith("/chat/stream")) {
    turns.push({ url: req.url, token: req.headers["x-servant-egress-token"], door: req.headers["x-servant-door"] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": started\n\n");
    release = () => res.end('event: assistant.completed\ndata: {"content":"Done"}\n\n');
    return;
  }
  if (req.method === "GET" && req.url.endsWith("/messages")) return json(200, { data: [] });
  return json(200, { session: { id: "known" } });
});

const pushes = [];
globalThis.__servantPushSend = async (target, notification) => { pushes.push({ to: target.token, title: notification.title, body: notification.body }); return { ok: true }; };
const echo = net.createServer(socket => socket.on("data", chunk => socket.write(String(chunk).replace("ping", "pong"))));
globalThis.__servantEgressTest = { resolve: async () => [{ address: "203.0.113.9" }], connect: () => net.connect(echo.address().port, "127.0.0.1") };

const people = { owner: { name: "Ana Ruiz", role: "owner" }, jo: { name: "Jo Park", role: "member" }, pat: { name: "Pat Tester", role: "member" }, sam: { name: "Sam Lee", role: "member" } };
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
      state.devices[crypto.createHash("sha256").update(p.token).digest("hex")] = { id: `dev_${key}`, userId: p.id, label: "Phone", createdAt: Date.now(), lastSeenAt: Date.now(),
        push: { platform: "ios", token: `push-${key}`, environment: "production" } };
    }
  });
  while (!mod.egressForTest().port) await new Promise(r => setTimeout(r, 10));
});
after(async () => { release(); await server?.shutdown(); echo.close(); agent.close(); agent.closeAllConnections?.(); delete globalThis.__servantPushSend; delete globalThis.__servantEgressTest; fs.rmSync(directory, { recursive: true, force: true }); });

async function call(token, method, route, body) {
  const response = await testFetch(directory, `${base}/v1/${route}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
const api = (who, method, route, body) => call(people[who].token, method, route, body);
async function pushed(count) {
  for (let i = 0; i < 300 && pushes.length < count; i++) await new Promise(r => setTimeout(r, 20));
  return pushes.splice(0);
}
function connectThrough(target, token, send = "ping") {
  return new Promise((resolve, reject) => {
    const socket = net.connect(mod.egressForTest().port, "127.0.0.1");
    let data = "", sent = false;
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${token ? `Proxy-Authorization: Basic ${Buffer.from(`${token}:`).toString("base64")}\r\n` : ""}\r\n`));
    socket.on("data", chunk => { data += chunk; if (!sent && data.startsWith("HTTP/1.1 200")) { sent = true; socket.write(send); } if (data.includes("pong")) socket.end(); });
    socket.on("close", () => resolve({ status: Number(data.slice(9, 12)), text: data }));
  });
}
const TERMS = async () => { const t = await import("./terms.mjs"); return { version: t.TERMS_VERSION, items: t.TERMS_ITEMS }; };

test("everyone's manager starts as the owner; an owner or the current manager can hand someone on, never into a loop", async () => {
  const start = (await api("pat", "GET", "entitlements")).body;
  assert.deepEqual(start.manager, { id: people.owner.id, name: "Ana Ruiz" });
  assert.deepEqual(start.reports, []);
  assert.equal((await api("owner", "GET", "entitlements")).body.manager, null, "an owner has none");
  assert.equal((await api("sam", "PUT", `people/${people.pat.id}/manager`, { managerId: people.sam.id })).status, 403, "not Pat's manager, not an owner");
  assert.equal((await api("pat", "PUT", `people/${people.pat.id}/manager`, { managerId: people.sam.id })).status, 403, "nobody picks their own approver");
  const set = await api("owner", "PUT", `people/${people.pat.id}/manager`, { managerId: people.jo.id });
  assert.deepEqual(set.body.person.manager, { id: people.jo.id, name: "Jo Park" });
  assert.deepEqual(await pushed(1), [{ to: "push-jo", title: "Entitlements", body: "You now decide Pat Tester's entitlement requests" }]);
  assert.deepEqual((await api("jo", "GET", "entitlements")).body.reports, [{ id: people.pat.id, name: "Pat Tester" }]);
  assert.equal((await api("owner", "PUT", `people/${people.jo.id}/manager`, { managerId: people.pat.id })).body.error.code, "manager_loop");
  assert.equal((await api("owner", "PUT", `people/${people.pat.id}/manager`, { managerId: people.pat.id })).status, 400);
  assert.equal((await api("owner", "PUT", `people/${people.owner.id}/manager`, { managerId: people.jo.id })).status, 400);
  assert.equal((await api("owner", "PUT", `people/${people.pat.id}/manager`, { managerId: "usr_nobody" })).status, 400);
  // Jo, as Pat's manager, can hand Pat on to Sam, and then no longer decides for Pat.
  assert.equal((await api("jo", "PUT", `people/${people.pat.id}/manager`, { managerId: people.sam.id })).status, 200);
  assert.equal((await api("jo", "PUT", `people/${people.pat.id}/manager`, { managerId: people.jo.id })).status, 403);
  assert.equal((await api("owner", "PUT", `people/${people.pat.id}/manager`, { managerId: people.jo.id })).status, 200);
  const org = (await api("owner", "GET", "entitlements")).body.org;
  assert.deepEqual(org.map(p => [p.name, p.manager?.name ?? null]), [["Ana Ruiz", null], ["Jo Park", "Ana Ruiz"], ["Pat Tester", "Jo Park"], ["Sam Lee", "Ana Ruiz"]]);
  assert.equal("org" in (await api("jo", "GET", "entitlements")).body, false);
  // The People list carries the same chart for everyone, so the app can draw it.
  const list = (await api("sam", "GET", "people")).body.people;
  assert.deepEqual(list.map(p => [p.name, p.managerId ?? null]), [["Ana Ruiz", null], ["Jo Park", people.owner.id], ["Pat Tester", people.jo.id], ["Sam Lee", people.owner.id]]);
  await pushed(2);
});

test("ask, confirm, be granted: the agent reaches a host only for the person who holds the entitlement", async () => {
  assert.equal((await api("pat", "POST", "entitlements", { name: "Tax data API", hosts: ["api.example.gov"] })).status, 403, "only an owner makes one");
  const made = await api("owner", "POST", "entitlements", { name: "Tax data API", description: "Read-only tax data", hosts: ["api.example.gov", "*.data.example.gov"], confirmation: "I hold the Tax data role myself." });
  assert.equal(made.status, 201);
  const id = made.body.entitlement.id;
  assert.equal((await api("owner", "POST", "entitlements", { name: "Bad", hosts: ["https://example.gov/x"] })).status, 400);

  // Before anything is granted, Pat's agent is refused and Pat is told what to ask for, once.
  const patToken = mod.egressForTest().mint(people.pat.id, "chat_1");
  const refused = await connectThrough("api.example.gov:443", patToken);
  assert.equal(refused.status, 403);
  assert.match(refused.text, /it needs the entitlement "Tax data API"/);
  await connectThrough("api.example.gov:443", patToken);
  assert.deepEqual(await pushed(1), [{ to: "push-pat", title: "Agent · access needed", body: "The agent couldn't reach api.example.gov. Ask for Tax data API in Entitlements" }]);
  // A host no entitlement covers goes to the owners instead.
  assert.equal((await connectThrough("elsewhere.example.org:443", patToken)).status, 403);
  assert.deepEqual(await pushed(1), [{ to: "push-owner", title: "Agent · blocked", body: "Pat Tester's agent tried elsewhere.example.org, which no entitlement covers" }]);

  // Pat sees the entitlement and what they would confirm, and nobody else's standing.
  const seen = (await api("pat", "GET", "entitlements")).body;
  assert.equal(seen.canCreate, false);
  assert.deepEqual(seen.egress, { mode: "ask" });
  assert.equal(seen.entitlements.find(e => e.id === id).confirmation, "I hold the Tax data role myself.");
  assert.equal(seen.entitlements.find(e => e.id === id).mine, null);
  assert.deepEqual(seen.entitlements.find(e => e.id === id).people, []);

  assert.equal((await api("pat", "POST", `entitlements/${id}/request`, { note: "no confirmation" })).body.error.code, "confirmation_required");
  const asked = await api("pat", "POST", `entitlements/${id}/request`, { confirmed: true, note: "Example-app team" });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.entitlement.mine.status, "requested");
  assert.equal((await api("pat", "POST", `entitlements/${id}/request`, { confirmed: true })).status, 200, "asking twice is harmless");
  assert.deepEqual(await pushed(1), [{ to: "push-jo", title: "Entitlement request", body: "Pat Tester asked for Tax data API" }], "Pat's manager is told, once");
  assert.equal((await connectThrough("api.example.gov:443", patToken)).status, 403, "asking opens nothing");

  // Sam isn't Pat's manager. Jo is, sees the request, but can't hand on what Jo doesn't hold.
  assert.equal((await api("sam", "POST", `entitlements/${id}/people/${people.pat.id}`, { decision: "grant" })).status, 403);
  assert.equal((await api("pat", "POST", `entitlements/${id}/people/${people.pat.id}`, { decision: "grant" })).status, 403);
  const joView = (await api("jo", "GET", "entitlements")).body;
  assert.equal(joView.waiting, 1);
  assert.deepEqual(joView.entitlements.find(e => e.id === id).people.map(p => [p.name, p.status, p.note]), [["Pat Tester", "requested", "Example-app team"]]);
  assert.deepEqual((await api("sam", "GET", "entitlements")).body.entitlements.find(e => e.id === id).people, [], "Sam sees nobody else's request");
  assert.equal((await api("jo", "POST", `entitlements/${id}/people/${people.pat.id}`, { decision: "grant" })).body.error.code, "not_held");
  // Jo asks; Jo's manager is the owner, who grants; now Jo can grant Pat.
  await api("jo", "POST", `entitlements/${id}/request`, { confirmed: true });
  assert.deepEqual(await pushed(1), [{ to: "push-owner", title: "Entitlement request", body: "Jo Park asked for Tax data API" }]);
  assert.equal((await api("owner", "POST", `entitlements/${id}/people/${people.jo.id}`, { decision: "grant" })).status, 200);
  assert.deepEqual(await pushed(1), [{ to: "push-jo", title: "Entitlements", body: "You now have Tax data API" }]);
  assert.equal((await api("jo", "POST", `entitlements/${id}/people/${people.pat.id}`, { decision: "grant" })).status, 200);
  assert.deepEqual(await pushed(1), [{ to: "push-pat", title: "Entitlements", body: "You now have Tax data API" }]);

  const open = await connectThrough("api.example.gov:443", patToken);
  assert.equal(open.status, 200);
  assert.match(open.text, /pong/);
  assert.equal((await connectThrough("files.data.example.gov:443", patToken)).status, 200, "the pattern covers names under it");
  assert.equal((await connectThrough("api.example.gov:443", mod.egressForTest().mint(people.sam.id))).status, 403, "Sam holds nothing");
  assert.equal((await connectThrough("models.example.gov:443", "")).status, 200, "the always list needs no person");
  await pushed(1);

  // Taken back: closed again at once, and Pat is told. The history shows every step with names.
  assert.equal((await api("owner", "POST", `entitlements/${id}/people/${people.pat.id}`, { decision: "revoke", reason: "Moved teams" })).status, 200);
  assert.deepEqual(await pushed(1), [{ to: "push-pat", title: "Entitlements", body: "Tax data API was taken back" }]);
  assert.equal((await connectThrough("api.example.gov:443", patToken)).status, 403);
  assert.equal((await api("jo", "GET", `entitlements/${id}/history`)).status, 403);
  const history = (await api("owner", "GET", `entitlements/${id}/history`)).body.history;
  assert.deepEqual(history.map(h => [h.action, h.byName, h.name ?? null]).reverse(), [["created", "Ana Ruiz", null], ["requested", "Pat Tester", "Pat Tester"], ["requested", "Jo Park", "Jo Park"],
    ["granted", "Ana Ruiz", "Jo Park"], ["granted", "Jo Park", "Pat Tester"], ["revoked", "Ana Ruiz", "Pat Tester"]]);
  const ownerView = (await api("owner", "GET", "entitlements")).body;
  assert.deepEqual(ownerView.egress.always, ["models.example.gov"]);
  assert.ok(ownerView.egress.refused.some(r => r.name === "Pat Tester" && r.host === "elsewhere.example.org"));
});

test("invite your manager: whoever accepts becomes the sender's manager, and reports to an owner", async () => {
  assert.equal((await api("owner", "POST", "people/me/manager-invite", { name: "Lee Chen" })).status, 400, "an owner has no manager");
  assert.equal((await api("sam", "POST", "people/me/manager-invite", { name: "" })).body.error.code, "name_required");
  assert.equal((await api("sam", "POST", "people/me/manager-invite", { name: "jo park" })).body.error.code, "name_taken");
  const invite = await api("sam", "POST", "people/me/manager-invite", { name: "Lee Chen" });
  assert.equal(invite.status, 201);
  assert.ok(invite.body.code && invite.body.link);
  const joined = await call(null, "POST", "pair", { code: invite.body.code, device: "Phone", terms: await TERMS() });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.user.name, "Lee Chen");
  assert.deepEqual((await api("sam", "GET", "entitlements")).body.manager, { id: joined.body.user.id, name: "Lee Chen" });
  const lee = (await call(joined.body.token, "GET", "entitlements")).body;
  assert.deepEqual(lee.manager, { id: people.owner.id, name: "Ana Ruiz" }, "the new manager reports to an owner, not to the person who invited them");
  assert.deepEqual(lee.reports, [{ id: people.sam.id, name: "Sam Lee" }]);
  assert.equal((await call(null, "POST", "pair", { code: invite.body.code, device: "Phone", terms: await TERMS() })).status, 403, "the invite works once");

  // The new manager holds nothing, so they can't open anything for Sam until an owner has granted it to them.
  const id = (await api("owner", "POST", "entitlements", { name: "Jira", hosts: ["jira.example.gov"] })).body.entitlement.id;
  await api("sam", "POST", `entitlements/${id}/request`, { confirmed: true });
  assert.equal((await call(joined.body.token, "POST", `entitlements/${id}/people/${people.sam.id}`, { decision: "grant" })).body.error.code, "not_held");
  assert.equal((await call(joined.body.token, "POST", `entitlements/${id}/people/${people.sam.id}`, { decision: "deny", reason: "Ask me first" })).status, 200);
});

test("a turn tells the agent whose it is, and while it runs unnamed traffic counts as that person's", async () => {
  const chat = (await api("sam", "POST", "chats", {})).body.chat;
  // The reply streams until the agent finishes, so the request is left open while the turn is examined.
  const sending = testFetch(directory, `${base}/v1/chats/${chat.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${people.sam.token}` }, body: JSON.stringify({ text: "Fetch the report", requestId: "request_egress_1" }) });
  for (let i = 0; i < 300 && !turns.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(turns.length, 1, "the agent received the turn");
  assert.match(turns[0].token, /^[A-Za-z0-9._-]{20,600}$/);
  assert.equal(turns[0].token, mod.egressForTest().mint(people.sam.id, chat.id), "the token is Sam's, for this chat");
  assert.equal(turns[0].door, String(mod.egressForTest().port), "and where to ask before a tool call");
  await pushed(0); pushes.length = 0;
  // While this turn runs, a tool call that needs something Sam doesn't hold shows on the reply as waiting on Sam's manager.
  const samToken = turns[0].token;
  const waited = await (await fetch(`http://127.0.0.1:${mod.egressForTest().port}/use`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: samToken, needs: ["fs-write"], detail: "Write report.md" }) })).json();
  assert.equal(waited.verdict, "wait");
  const running = (await api("sam", "GET", `chats/${chat.id}`)).body.latestTurn ?? (await api("sam", "GET", `chats/${chat.id}/turns`)).body;
  assert.match(JSON.stringify(running), /Waiting for .+ to allow Filesystem write/, "the reply says who it is waiting on and for what");
  await pushed(1); pushes.length = 0;
  // A command that presents the token is Sam's.
  assert.equal((await connectThrough("named.example.org:443", turns[0].token)).status, 403);
  assert.deepEqual(await pushed(1), [{ to: "push-owner", title: "Agent · blocked", body: "Sam Lee's agent tried named.example.org, which no entitlement covers" }]);
  // One that presents nothing is judged for whoever's agent is working: Sam, while this turn runs.
  const unnamed = await connectThrough("unnamed.example.org:443", "");
  assert.equal(unnamed.status, 403);
  assert.doesNotMatch(unnamed.text, /no agent turn is running/);
  assert.deepEqual(await pushed(1), [{ to: "push-owner", title: "Agent · blocked", body: "Sam Lee's agent tried unnamed.example.org, which no entitlement covers" }]);
  // A reply outside an agent chat (to @agent in a channel) counts the same way while it lasts.
  release();
  const sent = await sending;
  assert.ok(sent.status < 300, `the turn was accepted: ${sent.status}`);
  await sent.body?.cancel();
  for (let i = 0; i < 300; i++) { const r = await connectThrough("idle.example.org:443", ""); if (/no agent turn is running/.test(r.text)) break; await new Promise(r => setTimeout(r, 20)); }
  assert.match((await connectThrough("idle.example.org:443", "")).text, /no agent turn is running/, "once the turn ends nobody is working");
  const done = mod.egressForTest().working(people.sam.id);
  assert.doesNotMatch((await connectThrough("channel.example.org:443", "")).text, /no agent turn is running/);
  done();
  assert.match((await connectThrough("idle.example.org:443", "")).text, /no agent turn is running/);
  await pushed(1); pushes.length = 0;
});

// What the bridge does before a tool call: POST /use to the local listener, with the turn's token.
async function use(who, needs, detail) {
  const response = await fetch(`http://127.0.0.1:${mod.egressForTest().port}/use`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: who === null ? "made.up.token" : mod.egressForTest().mint(people[who].id, "chat_use"), needs, detail }) });
  return { status: response.status, ...(await response.json()) };
}

test("built-in entitlements: the first use asks the manager, who allows once or always, and it is recorded", async () => {
  await pushed(0); pushes.length = 0;
  const builtIn = (await api("owner", "GET", "entitlements")).body;
  assert.deepEqual(builtIn.capabilities, { mode: "ask" });
  assert.deepEqual(builtIn.entitlements.filter(e => e.native).map(e => [e.name, e.capability]), [["Filesystem read", "fs-read"], ["Filesystem write", "fs-write"], ["GitHub read", "github-read"], ["GitHub write", "github-write"]]);
  await api("owner", "PUT", `people/${people.pat.id}/manager`, { managerId: people.owner.id });
  await pushed(1); pushes.length = 0;

  // Nobody's turn, or the owner's own: nothing to ask.
  assert.deepEqual(await use(null, ["fs-write"], "Write x"), { status: 403, verdict: "deny", message: "Servant doesn't know whose turn this is, so it can't be allowed." });
  assert.equal((await use("owner", ["github-write", "fs-write"], "Run: git push")).verdict, "allow", "an owner's own agent is not held back");
  assert.equal((await use("pat", [], "Use todo")).verdict, "allow");
  assert.equal((await use("pat", ["sudo"], "x")).verdict, "allow", "only the four built-in ones are checked");

  // Pat's agent is about to commit and push. Pat's manager is told once about each thing it needs; the agent is told to wait.
  const held = await use("pat", ["github-write", "fs-write"], "Run: git commit -am fix && git push");
  assert.equal(held.verdict, "wait");
  assert.equal(held.capability, "github-write", "the weightiest is named first");
  assert.match(held.message, /^Servant is holding this: Ana Ruiz has been asked to allow GitHub write and Filesystem write for Pat Tester/);
  assert.equal((await use("pat", ["github-write"], "Run: git push")).verdict, "wait");
  assert.deepEqual((await pushed(2)).sort((a, b) => a.body.localeCompare(b.body)), [
    { to: "push-owner", title: "Entitlement request", body: "Pat Tester's agent needs Filesystem write" },
    { to: "push-owner", title: "Entitlement request", body: "Pat Tester's agent needs GitHub write" },
  ], "told once about each, without what the agent was doing");
  const waiting = (await api("owner", "GET", "entitlements")).body.entitlements.find(e => e.capability === "github-write").people;
  assert.deepEqual(waiting.map(p => [p.name, p.status, p.via, p.detail]), [["Pat Tester", "requested", "use", "Run: git push"]], "the manager sees the latest thing it tried");
  assert.equal((await api("pat", "GET", "entitlements")).body.entitlements.find(e => e.capability === "github-write").mine.status, "requested");

  // Allow once for GitHub write. The commit-and-push also needs files, which is still waiting, so the single
  // allowance is not spent on it.
  assert.equal((await api("owner", "POST", `entitlements/native-github-write/people/${people.pat.id}`, { decision: "once" })).status, 200);
  assert.deepEqual(await pushed(1), [{ to: "push-pat", title: "Entitlements", body: "GitHub write was allowed once" }]);
  const still = await use("pat", ["github-write", "fs-write"], "Run: git commit -am fix && git push");
  assert.deepEqual([still.verdict, still.capability], ["wait", "fs-write"]);
  assert.equal((await connectThrough("github.com:443", mod.egressForTest().mint(people.pat.id, "chat_use"))).status, 403, "nothing was used, so nothing opened");
  assert.deepEqual(await pushed(1), [{ to: "push-pat", title: "Agent · access needed", body: "The agent couldn't reach github.com. Ask for GitHub read or GitHub write in Entitlements" }]);
  // A push by itself needs only GitHub write: it goes ahead, can reach GitHub, and uses the allowance up.
  assert.equal((await use("pat", ["github-write"], "Run: git push")).verdict, "allow");
  assert.equal((await connectThrough("github.com:443", mod.egressForTest().mint(people.pat.id, "chat_use"))).status, 200, "the push can reach GitHub");
  assert.equal((await use("pat", ["github-write"], "Run: git push")).verdict, "wait", "once was used up");
  assert.deepEqual(await pushed(1), [{ to: "push-owner", title: "Entitlement request", body: "Pat Tester's agent needs GitHub write" }]);

  // Allow always, answered while the agent is still waiting: the held call goes through without asking again.
  config.agentCapabilities.waitSeconds = 10;
  const pending = use("pat", ["github-write"], "Run: git push");
  await new Promise(r => setTimeout(r, 150));
  assert.equal((await api("owner", "POST", `entitlements/native-github-write/people/${people.pat.id}`, { decision: "grant" })).status, 200);
  assert.equal((await pending).verdict, "allow");
  config.agentCapabilities.waitSeconds = 0;
  for (let i = 0; i < 2; i++) assert.equal((await use("pat", ["github-write"], "Run: git push")).verdict, "allow");
  assert.equal((await use("pat", ["github-read"], "Run: gh pr list")).verdict, "allow", "write covers read");
  await pushed(1); pushes.length = 0;

  // Declined: refused from then on without asking again, with words for the agent to pass on.
  assert.equal((await api("owner", "POST", `entitlements/native-fs-write/people/${people.pat.id}`, { decision: "deny" })).status, 200);
  const refused = await use("pat", ["fs-write"], "Write notes.md");
  assert.equal(refused.verdict, "deny");
  assert.match(refused.message, /Pat Tester asked for Filesystem write and was declined/);
  await pushed(1); pushes.length = 0;
  assert.equal((await use("pat", ["fs-write"], "Write notes.md")).verdict, "deny");
  assert.deepEqual(await pushed(0), [], "a no is not asked about again");

  // Every step is on the record, with what the agent was about to do.
  const history = (await api("owner", "GET", "entitlements/native-github-write/history")).body.history.filter(h => h.userId === people.pat.id).reverse();
  assert.deepEqual(history.map(h => [h.action, h.byName]), [["requested", "Pat Tester"], ["once", "Ana Ruiz"], ["used", "Pat Tester"], ["requested", "Pat Tester"], ["granted", "Ana Ruiz"]]);
  assert.deepEqual(history[0].detail, { via: "use", detail: "Run: git commit -am fix && git push" });
  assert.equal((await api("owner", "DELETE", "entitlements/native-github-write")).status, 400, "a built-in entitlement can't be retired");
  assert.equal((await api("owner", "POST", `entitlements/native-github-write/people/${people.pat.id}`, { decision: "revoke" })).status, 200);
  await pushed(1); pushes.length = 0;

  // The action log has every checked call with how it ended: the owner's own, the waits, the single allowance, the no.
  assert.equal((await api("pat", "GET", "entitlements/actions")).status, 403, "owners only");
  const log = (await api("owner", "GET", "entitlements/actions?limit=200")).body.actions.reverse().filter(a => a.name !== "Sam Lee");
  assert.deepEqual(log.slice(0, 6).map(a => [a.name, a.verdict, a.needs.join("+"), a.detail]), [
    ["Ana Ruiz", "allowed-owner", "github-write+fs-write", "Run: git push"],
    ["Pat Tester", "waiting", "github-write+fs-write", "Run: git commit -am fix && git push"],
    ["Pat Tester", "waiting", "github-write", "Run: git push"],
    ["Pat Tester", "waiting", "github-write+fs-write", "Run: git commit -am fix && git push"],
    ["Pat Tester", "allowed-once", "github-write", "Run: git push"],
    ["Pat Tester", "waiting", "github-write", "Run: git push"],
  ]);
  assert.ok(log.every(a => a.chatId === "chat_use"), "each line names the chat it happened in");
  assert.deepEqual([...new Set(log.map(a => a.verdict))].sort(), ["allowed", "allowed-once", "allowed-owner", "denied", "waiting"]);
  assert.equal(log.filter(a => a.verdict === "denied").length, 2);
  const patOnly = (await api("owner", "GET", `entitlements/actions?user=${people.pat.id}&limit=3`)).body.actions;
  assert.equal(patOnly.length, 3);
  assert.ok(patOnly.every(a => a.name === "Pat Tester"));

  // An agent whose bridge can't ask is not handed a turn while the checks are on. With them off, nothing is asked.
  checksSupported = false;
  const chat = (await api("pat", "POST", "chats", {})).body.chat;
  const before = turns.length;
  const sent = await testFetch(directory, `${base}/v1/chats/${chat.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${people.pat.token}` }, body: JSON.stringify({ text: "Push it", requestId: "request_unchecked" }) });
  await sent.body?.cancel();
  await new Promise(r => setTimeout(r, 400));
  assert.equal(turns.length, before, "the turn never reached the agent");
  checksSupported = true;
  config.agentCapabilities.mode = "off";
  assert.equal((await use("pat", ["github-write", "fs-write"], "Run: git push")).verdict, "allow");
  config.agentCapabilities.mode = "ask";
});

test("someone who joins from an owner's team link reports to that owner", async () => {
  const link = await api("owner", "POST", "invites", { fresh: true });
  const joined = await call(null, "POST", "pair", { code: link.body.code, name: "Riley Kim", device: "Phone", terms: await TERMS() });
  assert.equal(joined.status, 201);
  assert.deepEqual((await call(joined.body.token, "GET", "entitlements")).body.manager, { id: people.owner.id, name: "Ana Ruiz" });
});

test("removing a person revokes what they held and stops their agent's traffic; retiring closes the entitlement", async () => {
  const id = (await api("owner", "POST", "entitlements", { name: "GitHub", hosts: ["github.com"] })).body.entitlement.id;
  await api("pat", "POST", `entitlements/${id}/request`, { confirmed: true });
  assert.equal((await api("owner", "POST", `entitlements/${id}/people/${people.pat.id}`, { decision: "grant" })).status, 200);
  const patToken = mod.egressForTest().mint(people.pat.id);
  assert.equal((await connectThrough("github.com:443", patToken)).status, 200);
  // Pat's manager leaves: Pat's requests go to the owner again.
  assert.equal((await api("owner", "DELETE", `people/${people.jo.id}`)).status, 200);
  assert.deepEqual((await api("pat", "GET", "entitlements")).body.manager, { id: people.owner.id, name: "Ana Ruiz" });
  assert.equal((await api("owner", "DELETE", `people/${people.pat.id}`)).status, 200);
  assert.equal((await connectThrough("github.com:443", patToken)).status, 403);
  const after = (await api("owner", "GET", "entitlements")).body.entitlements.find(e => e.id === id);
  assert.deepEqual(after.people.map(p => [p.name, p.status]), [["Pat Tester", "revoked"]]);
  assert.equal((await api("sam", "PATCH", `entitlements/${id}`, { name: "Git" })).status, 403);
  assert.equal((await api("owner", "PATCH", `entitlements/${id}`, { hosts: ["github.com", "api.github.com"] })).body.entitlement.hosts.length, 2);
  assert.equal((await api("owner", "DELETE", `entitlements/${id}`)).status, 200);
  assert.equal((await api("owner", "GET", "entitlements")).body.entitlements.some(e => e.id === id), false);
  assert.equal((await api("sam", "POST", `entitlements/${id}/request`, { confirmed: true })).status, 404);
});

test("someone's own GitHub token is the access; the entitlement is still the permission", async () => {
  // Sam connects a GitHub token of their own (docs/connections.md). With the checks on, the bridge is told one place
  // to ask both questions, and GitHub write is still Sam's manager's to allow.
  const token = "ghp_" + "s".repeat(32) + "a1b2";
  globalThis.__servantConnectionCheck = async () => ({ ok: true, account: "@sam-lee" });
  try {
    assert.equal((await api("sam", "PUT", "connections/github", { values: { token } })).status, 200);
    const headers = await mod.connectionsForTest().headers(config, people.sam.id, "cht_own_token");
    assert.equal(headers["X-Servant-Connections-Door"], String(mod.egressForTest().port), "inside the sandbox the gate's listener is the only one the bridge can reach");
    assert.equal(headers["X-Servant-Door"], String(mod.egressForTest().port));
    const answer = async route => { const r = await fetch(`http://127.0.0.1:${mod.egressForTest().port}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: headers["X-Servant-Egress-Token"], needs: ["github-write"], detail: "Run: git push" }) }); return r.json(); };
    assert.equal((await answer("/connections")).env.GH_TOKEN, token);
    const push = await answer("/use");
    assert.notEqual(push.verdict, "allow", "holding a token does not grant GitHub write");
    assert.match(push.message, /GitHub write/);
  } finally { delete globalThis.__servantConnectionCheck; }
});
