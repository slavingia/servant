// The onboarding tour over the real API: a person chooses their own role and nobody else's, the role opens
// nothing, each person is told their own limit and price, and the tour is due once for someone who just joined.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";
import { JOB_ROLES } from "./job-roles.mjs";
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === "API_SERVER_KEY") delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-tour-http-"));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PUSH_CONFIG = path.join(directory, "push.json");
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
const config = { host: "127.0.0.1", port: 0, name: "Example team", agentName: "Agent", publicUrl: "", discoveryUrl: "", adminKey: "", defaultAgentTier: 3,
  upstreams: { owner: { url: "http://127.0.0.1:9", key: "fixture-key", model: "example-model", usdPerMillion: { input: 2, output: 10 } } } };

const people = {
  ana: { name: "Ana Ruiz", role: "owner" },
  pat: { name: "Pat Tester", role: "member", agentTier: 3 },
  jo: { name: "Jo Park", role: "member", agentTier: 4 },
  sam: { name: "Sam Lee", role: "member", agentTier: 2, tokenLimit: 5_000_000 },
  noa: { name: "Noa Kim", role: "member", agentTier: 0 },
};
let server, base, mod;
before(async () => {
  mod = await import("./server.mjs"); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`;
  mod.mutateStateForTest(state => {
    let at = Date.now() - 10_000;
    for (const [key, p] of Object.entries(people)) {
      p.id = `usr_${key}`; p.token = crypto.randomBytes(32).toString("base64url");
      state.users[p.id] = { id: p.id, name: p.name, role: p.role, createdAt: at++, ...("agentTier" in p ? { agentTier: p.agentTier } : {}), ...(p.tokenLimit ? { tokenLimit: p.tokenLimit } : {}) };
      state.devices[crypto.createHash("sha256").update(p.token).digest("hex")] = { id: `dev_${key}`, userId: p.id, label: "Phone", createdAt: Date.now(), lastSeenAt: Date.now() };
    }
  });
});
after(async () => { await server?.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });

async function call(token, method, route, body) {
  const response = await testFetch(directory, `${base}/v1/${route}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
const api = (who, method, route, body) => call(people[who].token, method, route, body);
const stored = who => { let user; mod.mutateStateForTest(state => { user = structuredClone(state.users[people[who].id]); }); return user; };
// Everything about a person that decides what their agent may do.
const access = async who => {
  const { role, agentTier, tokenLimit, unlimitedTokens, vibeCoder, managerId, invitedBy } = stored(who);
  const tour = (await api(who, "GET", "tour")).body;
  const entitlements = (await api(who, "GET", "entitlements")).body.entitlements.map(e => [e.id, e.mine?.status ?? null]);
  return { role, agentTier, tokenLimit, unlimitedTokens, vibeCoder, managerId, invitedBy, agent: tour.agent, limit: tour.limit, approvals: tour.approvals, entitlements };
};

test("a person sets their own role, and it shows on their profile and in People", async () => {
  const set = await api("pat", "PATCH", "people/me", { jobRole: "designer" });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.user.jobRole, { id: "designer", label: "Designer" });
  assert.equal(stored("pat").jobRole, "designer");
  assert.deepEqual((await api("pat", "GET", "me")).body.user.jobRole, { id: "designer", label: "Designer" });
  // The owner sees it in People; so does everyone else, like a name.
  for (const who of ["ana", "jo"]) {
    const list = (await api(who, "GET", "people")).body.people;
    assert.deepEqual(list.find(p => p.id === people.pat.id).jobRole, { id: "designer", label: "Designer" }, who);
    assert.equal(list.find(p => p.id === people.jo.id).jobRole, undefined);
  }
  assert.equal((await api("pat", "GET", "tour")).body.jobRole, "designer");
  // Changed, then cleared.
  assert.equal((await api("pat", "PATCH", "people/me", { jobRole: "content" })).body.user.jobRole.label, "Content");
  assert.equal((await api("pat", "PATCH", "people/me", { jobRole: null })).body.user.jobRole, undefined);
  assert.equal("jobRole" in stored("pat"), false);
  // A name change still works beside it, and neither touches the other.
  await api("pat", "PATCH", "people/me", { jobRole: "designer" });
  assert.equal((await api("pat", "PATCH", "people/me", { name: "Pat Tester" })).body.user.jobRole.id, "designer");
});

test("a role that isn't on the list is refused and nothing is saved", async () => {
  for (const bad of ["owner", "Software engineer", "Designer", "", 3, true, ["designer"], { id: "designer" }, "__proto__"]) {
    const out = await api("jo", "PATCH", "people/me", { jobRole: bad });
    assert.equal(out.status, 400, JSON.stringify(bad));
    assert.equal(out.body.error.code, "bad_role");
  }
  // A bad role beside a good name saves neither.
  assert.equal((await api("jo", "PATCH", "people/me", { name: "Jo P", jobRole: "admin" })).status, 400);
  assert.equal(stored("jo").name, "Jo Park");
  assert.equal("jobRole" in stored("jo"), false);
});

test("nobody sets someone else's role, an owner included", async () => {
  const before = stored("jo");
  // The owner's own route for changing a person takes no role.
  const byOwner = await api("ana", "PATCH", `people/${people.jo.id}`, { jobRole: "manager" });
  assert.equal(byOwner.status, 400);
  // Beside a field it does take, the role is ignored.
  assert.equal((await api("ana", "PATCH", `people/${people.jo.id}`, { name: "Jo Park", jobRole: "manager" })).status, 200);
  // A member can't reach it at all, and naming someone else in the body of their own changes only themselves.
  assert.equal((await api("pat", "PATCH", `people/${people.jo.id}`, { jobRole: "manager" })).status, 400);
  assert.equal((await api("pat", "PATCH", `people/${people.jo.id}`, { name: "Jo Park", jobRole: "manager" })).status, 403);
  await api("pat", "PATCH", "people/me", { jobRole: "engineer", userId: people.jo.id, id: people.jo.id });
  assert.deepEqual(stored("jo"), before);
  assert.equal(stored("pat").jobRole, "engineer");
  assert.equal((await call("", "PATCH", "people/me", { jobRole: "designer" })).status, 401);
});

test("choosing a role never changes level, limit, entitlements or approvals", async () => {
  for (const who of ["pat", "jo", "sam", "noa", "ana"]) {
    await api(who, "PATCH", "people/me", { jobRole: null });
    const was = await access(who);
    for (const role of JOB_ROLES) {
      assert.equal((await api(who, "PATCH", "people/me", { jobRole: role.id })).status, 200);
      assert.deepEqual(await access(who), was, `${who} as ${role.id}`);
    }
    // Only the role itself was written.
    const { jobRole, ...rest } = stored(who);
    await api(who, "PATCH", "people/me", { jobRole: null });
    assert.deepEqual(stored(who), rest);
    assert.equal(jobRole, JOB_ROLES.at(-1).id);
  }
  // Fields that do decide access are not accepted on a person's own route.
  await api("noa", "PATCH", "people/me", { jobRole: "engineer", agentTier: 3, tokenLimit: 50_000_000, unlimitedTokens: true, role: "owner", managerId: people.noa.id });
  const noa = stored("noa");
  assert.deepEqual([noa.role, noa.agentTier, noa.tokenLimit, noa.unlimitedTokens, noa.managerId], ["member", 0, undefined, undefined, undefined]);
  assert.equal((await api("noa", "GET", "tour")).body.agent.kind, "none");
});

test("each person is told their own level, limit and price", async () => {
  const pat = (await api("pat", "GET", "tour")).body;
  assert.deepEqual(pat.agent, { tier: 3, name: "Software engineer", kind: "full" });
  assert.deepEqual(pat.limit, { tokens: 20_000_000, unlimited: false });
  // $2 in and $10 out with one token in ten out: $2.80 a million.
  assert.deepEqual(pat.price, { perMillion: 2.8 });
  assert.deepEqual(pat.today, { tokens: 0, usd: 0 });
  assert.equal(pat.owner, false);
  assert.equal(pat.team, undefined);
  assert.deepEqual(pat.approvals, { asks: false, logged: false, networkGate: false, manager: { name: "Ana Ruiz" } });
  assert.equal(pat.server.name, "Example team");
  assert.deepEqual(pat.roles.map(r => r.id), JOB_ROLES.map(r => r.id));

  assert.deepEqual((await api("jo", "GET", "tour")).body.agent, { tier: 4, name: "User researcher", kind: "researcher" });
  assert.deepEqual((await api("sam", "GET", "tour")).body.limit, { tokens: 5_000_000, unlimited: false });
  const noa = (await api("noa", "GET", "tour")).body;
  assert.deepEqual([noa.agent.kind, noa.limit, noa.price, noa.today], ["none", { tokens: 0, unlimited: false }, undefined, undefined]);
  const ana = (await api("ana", "GET", "tour")).body;
  assert.deepEqual([ana.owner, ana.limit, ana.team], [true, { tokens: null, unlimited: true }, { tokens: 0, usd: 0 }]);
  assert.equal((await call("", "GET", "tour")).status, 401);
  // Nothing about the agent's model or its separate prices goes to a member.
  assert.equal(/example-model|usdPerMillion|"input"|"output"/.test(JSON.stringify(pat)), false);
});

test("the tour says approvals are on only when this server checks, and restricted when members are", async () => {
  // The server reads its settings again on every request; the test's are this object.
  const write = change => { delete config.agentAccess; delete config.agentCapabilities; Object.assign(config, change); };
  try {
    write({ agentCapabilities: { mode: "ask" } });
    assert.deepEqual((await api("pat", "GET", "tour")).body.approvals, { asks: true, logged: true, networkGate: false, manager: { name: "Ana Ruiz" } });
    assert.deepEqual((await api("ana", "GET", "tour")).body.approvals, { asks: false, logged: true, networkGate: false });
    assert.equal((await api("jo", "GET", "tour")).body.approvals.asks, false);
    write({ agentAccess: "limited", agentCapabilities: { mode: "ask" } });
    const pat = (await api("pat", "GET", "tour")).body;
    assert.deepEqual([pat.agent.kind, pat.approvals.asks], ["restricted", false]);
    assert.equal((await api("ana", "GET", "tour")).body.agent.kind, "full");
  } finally { write({}); }
});

test("the tour is due once for someone who just joined, and seen everywhere after", async () => {
  // People who were here before the tour are never interrupted by it.
  assert.deepEqual((await api("pat", "GET", "me")).body.tour, { due: false });
  assert.equal((await api("pat", "GET", "tour")).body.seen, true);
  // Someone joins with an invite.
  const invite = await api("ana", "POST", "invites", {});
  assert.equal(invite.status, 200);
  const paired = await call("", "POST", "pair", { code: invite.body.code, name: "Kai Moss", device: "Phone", terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
  const token = paired.body.token;
  assert.ok(token, JSON.stringify(paired.body));
  assert.deepEqual(paired.body.tour, { due: true }, "the app can open the tour straight from joining");
  assert.deepEqual((await call(token, "GET", "me")).body.tour, { due: true });
  assert.equal((await call(token, "GET", "tour")).body.seen, false);
  // Choosing a role is not finishing.
  await call(token, "PATCH", "people/me", { jobRole: "researcher" });
  assert.deepEqual((await call(token, "GET", "me")).body.tour, { due: true });
  // Skipping and finishing are the same call.
  assert.deepEqual((await call(token, "POST", "tour/seen", {})).body, { tour: { due: false } });
  assert.deepEqual((await call(token, "GET", "me")).body.tour, { due: false });
  assert.equal((await call(token, "GET", "tour")).body.seen, true);
  // Reopened from Settings and finished again: still fine, and the role is kept.
  assert.equal((await call(token, "POST", "tour/seen", {})).status, 200);
  assert.equal((await call(token, "GET", "tour")).body.jobRole, "researcher");
  assert.equal((await call("", "POST", "tour/seen", {})).status, 401);
});
