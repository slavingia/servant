// Entitlements over the real API, with the agent's network gate on: a person asks and confirms, their manager is
// told and grants, and only then does that person's agent get through the proxy. Managers come from who invited
// whom, from "invite your manager", or from an owner's choice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
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
  agentEgress: { mode: "ask", port: 0, always: ["models.example.gov"] } };

const pushes = [];
globalThis.__servantPushSend = async (target, notification) => { pushes.push({ to: target.token, title: notification.title, body: notification.body }); return { ok: true }; };
const echo = net.createServer(socket => socket.on("data", chunk => socket.write(String(chunk).replace("ping", "pong"))));
globalThis.__servantEgressTest = { resolve: async () => [{ address: "203.0.113.9" }], connect: () => net.connect(echo.address().port, "127.0.0.1") };

const people = { owner: { name: "Ana Ruiz", role: "owner" }, jo: { name: "Jo Park", role: "member" }, pat: { name: "Pat Tester", role: "member" }, sam: { name: "Sam Lee", role: "member" } };
let server, base, mod;
before(async () => {
  await new Promise(done => echo.listen(0, "127.0.0.1", done));
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
after(async () => { await server?.shutdown(); echo.close(); delete globalThis.__servantPushSend; delete globalThis.__servantEgressTest; fs.rmSync(directory, { recursive: true, force: true }); });

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
  assert.equal(seen.entitlements[0].confirmation, "I hold the Tax data role myself.");
  assert.equal(seen.entitlements[0].mine, null);
  assert.deepEqual(seen.entitlements[0].people, []);

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
  assert.deepEqual(joView.entitlements[0].people.map(p => [p.name, p.status, p.note]), [["Pat Tester", "requested", "Example-app team"]]);
  assert.deepEqual((await api("sam", "GET", "entitlements")).body.entitlements[0].people, [], "Sam sees nobody else's request");
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
