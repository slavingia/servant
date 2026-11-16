import { restrictedTestCapabilities, researcherTestCapabilities } from "./test-hermes-capabilities.mjs";
// node --test server/
// Runs the real server against a fake Hermes API server that speaks the same
// session + SSE protocol as gateway/platforms/api_server.py.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMessaging } from "./messaging.mjs";
import { createStateStore } from "./state-store.mjs";
import { createLiveEventDecoder } from "../app/src/lib/live-events.ts";
import { testFetch } from "./encrypted-test-client.mjs";
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";
const ACCEPT = { version: TERMS_VERSION, items: TERMS_ITEMS };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-test-"));
// config.json is re-read per request; flip agent access for one test.
async function withAgentAccess(value, fn) {
  const file = path.join(dataDir, "config.json");
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), agentAccess: value }));
  try { return await fn(); } finally { fs.writeFileSync(file, before); }
}
process.env.SERVANT_DATA_DIR = dataDir;

function fakeHermes(key, label, capabilities = restrictedTestCapabilities) {
  const sessions = new Map();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/capabilities") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(capabilities));
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401).end();
      return;
    }
    const m = req.url.match(/^\/api\/sessions(?:\/([^/]+))?(\/.*)?$/);
    const sid = m && m[1] && decodeURIComponent(m[1]);
    if (req.method === "POST" && req.url === "/api/sessions") {
      sessions.set(body.id, []);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "hermes.session", session: { id: body.id } }));
      return;
    }
    if (!sessions.has(sid)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET" && !m[2]) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "hermes.session", session: { id: sid } }));
      return;
    }
    if (req.method === "GET" && m[2] === "/messages") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: sessions.get(sid) }));
      return;
    }
    if (req.method === "DELETE" && !m[2]) {
      sessions.delete(sid);
      res.writeHead(200).end("{}");
      return;
    }
    if (req.method === "POST" && m[2] === "/chat/stream") {
      // A request containing WORKCHAT gets the hand-off to a shared agent chat.
      const reply = /WORKCHAT/.test(body.message) ? "Taking this to a shared chat.\n<servant-chat>Refund script update</servant-chat>" : `${label} heard: ${body.message}`;
      const msgs = sessions.get(sid);
      msgs.push({ id: msgs.length + 1, role: "user", content: body.message });
      msgs.push({ id: msgs.length + 2, role: "tool", content: "secret tool output" });
      msgs.push({ id: msgs.length + 3, role: "assistant", content: reply });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const ev = (n, d) => res.write(`event: ${n}\ndata: ${JSON.stringify(d)}\n\n`);
      ev("run.started", {});
      ev("tool.started", { tool_name: "terminal", args: { command: "cat ~/.ssh/id_rsa" } });
      for (const word of reply.split(/(?= )/)) ev("assistant.delta", { delta: word });
      ev("assistant.completed", { content: reply });
      ev("run.completed", { usage: { input_tokens: String(body.message).length, output_tokens: reply.length, total_tokens: String(body.message).length + reply.length } });
      ev("done", {});
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  return { server, calls, sessions };
}

const owner = fakeHermes("owner-key", "owner-agent");
const member = fakeHermes("member-key", "member-agent");
const researcher = fakeHermes("researcher-key", "researcher-agent", researcherTestCapabilities);
let server;
let base;
let mod;

before(async () => {
  await new Promise((r) => owner.server.listen(0, "127.0.0.1", r));
  await new Promise((r) => member.server.listen(0, "127.0.0.1", r));
  await new Promise((r) => researcher.server.listen(0, "127.0.0.1", r));
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      port: 0,
      defaultAgentTier: 3,
      name: "Test server",
      publicUrl: "https://team.example.test",
      discoveryUrl: "https://example.test/hub.json",
      upstreams: {
        owner: { url: `http://127.0.0.1:${owner.server.address().port}`, key: "owner-key" },
        member: { url: `http://127.0.0.1:${member.server.address().port}`, key: "member-key" },
        researcher: { url: `http://127.0.0.1:${researcher.server.address().port}`, key: "researcher-key" },
      },
    }),
  );
  // Projects come from projects.json beside the data (docs/projects.md).
  fs.writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify({
    people: { patgh: "Pat Projects", rogh: "Ro Reader" },
    projects: [
      { id: "servant", name: "Servant", description: "The team app", repo: "slavingia/servant", path: "~/servant", workflow: "main", rules: ["Never rewrite pushed history"], owners: ["bossgh"], access: { merge: ["bossgh"], write: ["patgh"], read: ["rogh"] } },
      { id: "prototypes", name: "Prototypes", repo: "example-org/prototypes", path: "~/prototypes", pages: "https://example-org.github.io/prototypes/", workflow: "main", rules: ["Public information and made-up sample data only"] },
      { id: "secret", name: "Secret", access: { merge: ["nobody-here"] } },
    ],
  }));
  mod = await import("./server.mjs");
  server = await mod.startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await server.shutdown();
  owner.server.close();
  member.server.close();
  researcher.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const api = async (method, p, { token, body } = {}) => {
  const res = await testFetch(dataDir, base + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
};

test("plaintext API access is rejected, including pairing and message history", async () => {
  for (const [method, route] of [["POST", "/v1/pair"], ["GET", "/v1/chats"], ["POST", "/v1/events"]]) {
    const response = await fetch(base + route, { method });
    assert.equal(response.status, 426);
    assert.equal((await response.json()).error.code, "encryption_required");
  }
});

function parseSse(text) {
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((b) => {
      const [e, d] = b.split("\n");
      return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
    });
}

async function pair(role, name) {
  const code = mod.createInvite({ name, role });
  const r = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code: code.toLowerCase(), device: "Test phone" } });
  assert.equal(r.status, 201, r.text);
  return r.json.token;
}

test("the server-wide banner reaches signed-in apps from config, and turns off", async () => {
  const token = await pair("member", "Banner Reader");
  const file = path.join(dataDir, "config.json");
  const before = fs.readFileSync(file, "utf8");
  try {
    assert.equal((await api("GET", "/v1/me", { token })).json.banner, null);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), banner: { enabled: true, message: "Do not use this app until cyber acceptance is granted." } }));
    assert.deepEqual((await api("GET", "/v1/me", { token })).json.banner, { message: "Do not use this app until cyber acceptance is granted." });
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), banner: { enabled: false, message: "Hi" } }));
    assert.equal((await api("GET", "/v1/me", { token })).json.banner, null);
  } finally { fs.writeFileSync(file, before); }
});

test("personal information in a chat message warns first and sends on confirm, only when switched on", { skip: !process.env.SERVANT_PII_REAL }, async () => {
  const token = await pair("member", "Pii Sender");
  const file = path.join(dataDir, "config.json");
  const before = fs.readFileSync(file, "utf8");
  const general = (await api("GET", "/v1/conversations", { token })).json.conversations.find(c => c.name === "general");
  const post = body => api("POST", `/v1/conversations/${general.id}/messages`, { token, body });
  const ssn = "My SSN is 452-78-1934.";
  try {
    assert.equal((await post({ text: ssn })).status, 201, "off by default");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), piiWarning: { enabled: true } }));
    const warned = await post({ text: ssn });
    assert.equal(warned.status, 409);
    assert.equal(warned.json.error.code, "pii_warning");
    assert.deepEqual(warned.json.error.types, ["GOV_ID"]);
    assert.equal((await post({ text: ssn, confirmPii: true })).status, 201, "send anyway");
    assert.equal((await post({ text: "Ask Marcus Delgado about the filing season plans" })).status, 201, "a name alone is fine");
  } finally { fs.writeFileSync(file, before); }
});

test("sensitive business information warns first and sends on confirm, in channels and agent chats, only when switched on", { skip: !process.env.SERVANT_PII_REAL }, async () => {
  const token = await pair("member", "Biz Sender");
  const file = path.join(dataDir, "config.json");
  const before = fs.readFileSync(file, "utf8");
  const general = (await api("GET", "/v1/conversations", { token })).json.conversations.find(c => c.name === "general");
  const post = body => api("POST", `/v1/conversations/${general.id}/messages`, { token, body });
  const chat = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  const ask = body => api("POST", `/v1/chats/${chat.id}/messages`, { token, body });
  const secret = "the vault admin password is Gr33n-Tiger!42, do not share it";
  const bid = "Final proposal price is $4,812,300 and Northgate came in at $5.1M, so we are low. Do not share before the award.";
  const config = piiWarning => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), piiWarning }));
  try {
    config({ enabled: true, businessInfo: true });
    assert.equal((await post({ text: secret })).status, 409);
    const warned = await post({ text: bid });
    assert.equal(warned.status, 409);
    assert.equal(warned.json.error.code, "pii_warning");
    assert.match(warned.json.error.message, /sensitive business information/);
    assert.ok(!warned.json.error.message.includes("4,812,300"), "the warning does not repeat the message");
    assert.deepEqual(warned.json.error.types, []);
    assert.equal((await post({ text: bid, confirmPii: true })).status, 201, "send anyway");
    assert.equal((await post({ text: "what time is the standup tomorrow" })).status, 201, "ordinary chat is fine");
    assert.equal((await post({ text: "What is the standard deduction for 2026 and when is the filing deadline?" })).status, 201, "public tax facts are fine");
    // Agent chats use the same check.
    assert.equal((await ask({ text: secret })).status, 409);
    assert.equal((await ask({ text: "can you summarize what a statement of work is" })).status, 200);
    // Personal information still wins, and still names what it found.
    const ssn = await post({ text: "My SSN is 452-78-1934." });
    assert.deepEqual(ssn.json.error.types, ["GOV_ID"]);
    // Off unless businessInfo is switched on, even with the personal-information warning on.
    config({ enabled: true });
    assert.equal((await post({ text: secret })).status, 201, "business check is off by default");
    config({ enabled: true, businessInfo: true });
    fs.writeFileSync(file, before);
    assert.equal((await post({ text: secret })).status, 201, "and off when the warning is off");
  } finally { fs.writeFileSync(file, before); }
});

test("sending past a business warning and saying it was wrong queues it for the owner, never trains on it, and is refused for personal information", { skip: !process.env.SERVANT_PII_REAL }, async () => {
  const token = await pair("member", "Report Sender");
  const file = path.join(dataDir, "config.json");
  const before = fs.readFileSync(file, "utf8");
  const general = (await api("GET", "/v1/conversations", { token })).json.conversations.find(c => c.name === "general");
  const post = body => api("POST", `/v1/conversations/${general.id}/messages`, { token, body });
  const chat = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  const ask = body => api("POST", `/v1/chats/${chat.id}/messages`, { token, body });
  const config = piiWarning => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), piiWarning }));
  const flagged = "the vault admin password is Gr33n-Tiger!42, do not share it";
  const flaggedChat = "the vault admin password is Tr0ub4dor-Lemon!77, do not share this one either";
  const queue = () => { const db = new DatabaseSync(path.join(dataDir, "business-reports.db")); try { return db.prepare("SELECT status, text FROM reports").all(); } finally { db.close(); } };
  const settle = () => new Promise(r => setTimeout(r, 250));
  try {
    // Reporting off: the warning does not offer it, and a report flag does nothing.
    config({ enabled: true, businessInfo: true });
    assert.equal((await post({ text: flagged })).json.error.reportable, undefined, "no report option unless reporting is on");
    assert.equal((await post({ text: flagged, confirmPii: true, reportFalseAlarm: true })).status, 201);
    await settle();
    assert.equal(fs.existsSync(path.join(dataDir, "business-reports.db")), false, "nothing is stored while reporting is off");

    // Reporting on.
    config({ enabled: true, businessInfo: true, reportFalseAlarms: true });
    assert.equal((await post({ text: flagged })).json.error.reportable, true, "the warning offers to report it");
    assert.equal((await post({ text: "My SSN is 452-78-1934." })).json.error.reportable, undefined, "a personal-information warning is never reportable");

    // Sent anyway without ticking: nothing is kept.
    assert.equal((await post({ text: flagged, confirmPii: true })).status, 201, "send anyway still works");
    await settle();
    assert.equal(fs.existsSync(path.join(dataDir, "business-reports.db")), false, "not reported unless the person says so");

    // Sent anyway and marked wrong: queued, pending.
    assert.equal((await post({ text: flagged, confirmPii: true, reportFalseAlarm: true })).status, 201, "the send is never delayed or blocked by the report");
    await settle();
    let rows = queue();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].status, rows[0].text], ["pending", flagged], "nothing is trained on until the owner approves it");
    // The same for an agent chat.
    assert.equal((await ask({ text: flaggedChat, confirmPii: true, reportFalseAlarm: true })).status, 200);
    await settle();
    assert.equal(queue().length, 2);

    // Only a message the check really flagged, and with no personal information, can be queued.
    await post({ text: "what time is the standup tomorrow", confirmPii: true, reportFalseAlarm: true });
    await post({ text: "My SSN is 452-78-1934 and the vault admin password is Gr33n-Tiger!42", confirmPii: true, reportFalseAlarm: true });
    await post({ text: flagged, confirmPii: true, reportFalseAlarm: true });
    await settle();
    assert.equal(queue().length, 2, "an unflagged message, one with personal information, and a repeat were not queued");
  } finally { fs.writeFileSync(file, before); }
});

test("records preservation: nothing authored is destroyed when it is on, and nothing changes when it is off", async () => {
  const token = await pair("member", "Records Keeper");
  const file = path.join(dataDir, "config.json");
  const before = fs.readFileSync(file, "utf8");
  const config = recordsPreservation => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), ...(recordsPreservation ? { recordsPreservation } : {}) }));
  const general = (await api("GET", "/v1/conversations", { token })).json.conversations.find(c => c.name === "general");
  const db = () => new DatabaseSync(path.join(dataDir, "messages.db"));
  const archived = (where, ...args) => { const d = db(); try { return d.prepare(`SELECT * FROM records_archive WHERE ${where} ORDER BY id`).all(...args); } finally { d.close(); } };
  try {
    // Off: deleting an agent chat destroys it as before, and no archive exists.
    config(undefined);
    const plain = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
    await api("POST", `/v1/chats/${plain.id}/messages`, { token, body: { text: "an ordinary chat that is not preserved" } });
    assert.equal((await api("DELETE", `/v1/chats/${plain.id}`, { token })).status, 200);
    const d0 = db(); try { assert.equal(d0.prepare("SELECT name FROM sqlite_master WHERE name = 'records_archive'").get(), undefined, "no archive when it is off"); } finally { d0.close(); }

    // On: a channel message edited then deleted, an agent chat deleted.
    config({ enabled: true });
    const posted = (await api("POST", `/v1/conversations/${general.id}/messages`, { token, body: { text: "Budget approved at 40,000" } })).json.message;
    assert.equal((await api("PATCH", `/v1/messages/${posted.id}`, { token, body: { text: "Budget approved at 45,000" } })).status, 200);
    assert.equal((await api("DELETE", `/v1/messages/${posted.id}`, { token })).status, 200);
    const edits = archived("event = 'message_edited' AND text = 'Budget approved at 40,000'");
    assert.equal(edits.length, 1, "the wording before the edit is kept");
    const dels = archived("event = 'message_deleted' AND text = 'Budget approved at 45,000'");
    assert.equal(dels.length, 1, "the final wording is kept when it is deleted");

    const chat = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
    const sent = await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "Draft the award memo for vendor Northgate" } });
    assert.equal(sent.status, 200);
    assert.equal((await api("DELETE", `/v1/chats/${chat.id}`, { token })).status, 200);
    const chatRows = archived("conversation_id = ?", chat.id);
    assert.ok(chatRows.some(r => r.event === "agent_chat_deleted"), "the chat itself is recorded");
    assert.ok(chatRows.some(r => /Draft the award memo/.test(r.text || "")), "what the person asked is kept");
    assert.ok(chatRows.some(r => r.event === "agent_turn"), "the turn (prompt, reply, status) is kept");
    const gone = await api("GET", "/v1/chats", { token });
    assert.equal(gone.json.chats.some(c => c.id === chat.id), false, "and it is gone from the person's view, as before");

    // The app is told, so its delete dialogs stop promising erasure; and not told when it is off.
    assert.equal((await api("GET", "/v1/me", { token })).json.recordsKept, true, "the app learns that records are kept");
    config(undefined);
    assert.equal((await api("GET", "/v1/me", { token })).json.recordsKept, undefined, "and is not told when preservation is off");
    config({ enabled: true });

    // The log is intact.
    const d = db(); try {
      const { verifyChain } = await import("./records-preserve.mjs");
      assert.equal(verifyChain(d).ok, true, "the log verifies");
    } finally { d.close(); }
  } finally { fs.writeFileSync(file, before); }
});

test("joining needs all three terms checks, and the acceptance is recorded", async () => {
  const code = mod.createInvite({ name: "Terms Tester", role: "member" });
  const join = terms => api("POST", "/v1/pair", { body: { code, device: "Test phone", ...(terms ? { terms } : {}) } });
  for (const terms of [undefined, { version: TERMS_VERSION, items: ["terms", "ai"] }, { version: "old", items: TERMS_ITEMS }]) {
    const r = await join(terms);
    assert.equal(r.status, 400); assert.equal(r.json.error?.code ?? r.json.code, "terms_required");
  }
  const ok = await join(ACCEPT);
  assert.equal(ok.status, 201, ok.text);
  const saved = createStateStore({ directory: dataDir }).read();
  const user = saved.users[ok.json.user.id];
  assert.equal(user.termsAcceptances.length, 1);
  assert.equal(user.termsAcceptances[0].version, TERMS_VERSION);
  assert.deepEqual(user.termsAcceptances[0].items, TERMS_ITEMS);
  assert.ok(user.termsAcceptances[0].acceptedAt);
  assert.ok(Object.values(saved.devices).some(d => d.id === user.termsAcceptances[0].deviceId));
});

test("the privacy policy is a public page", async () => {
  const r = await fetch(base + "/privacy");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Servant privacy policy/);
  assert.doesNotMatch(html, /mailto:/, "no contact address unless config.json sets contactEmail");
});

test("landing, support and consent pages are public, readable and protected from email rewriting", async () => {
  const file = path.join(dataDir, "config.json");
  const before = fs.readFileSync(file, "utf8");
  try {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), contactEmail: "help@example.gov", footer: "An independent example workspace" }));
    for (const [route, title] of [["/", "Agents for public servants."], ["/support", "Servant support"], ["/privacy", "Servant privacy policy"], ["/terms", "Terms of Service"]]) {
      for (const suffix of route === "/" ? [""] : ["", "/"]) {
        const response = await fetch(base + route + suffix);
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.ok(html.includes(title));
        assert.match(html, /An independent example workspace/);
        assert.doesNotMatch(html, /<script/);
        assert.match(response.headers.get("cache-control"), /no-transform/);
        assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
        if (route !== "/") assert.match(html, /<!--email_off--><a href="mailto:help@example\.gov">help@example\.gov<\/a><!--\/email_off-->/);
        const head = await fetch(base + route + suffix, { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), "");
      }
    }
  } finally { fs.writeFileSync(file, before); }
});

test("everything except health and pairing needs a token", async () => {
  assert.equal((await api("GET", "/health")).status, 200);
  assert.equal((await api("GET", "/v1/chats")).status, 401);
  assert.equal((await api("GET", "/v1/me", { token: "nope" })).status, 401);
});

test("email code sign-in: off by default, then required, wrong/expired/outsider codes refused", async () => {
  const { emailAllowed } = await import("./email-verify.mjs");
  assert.equal(emailAllowed("a@example.gov", ["example.gov"]), true);
  assert.equal(emailAllowed("a@mail.example.gov", ["example.gov"]), true);
  const old = await pair("member", "Early Joiner");
  const otherEarly = await pair("member", "Other Early");
  for (const bad of ["a@example.gov.evil.com", "a@notexample.gov", "a@example.com", "a@evilexample.gov"]) assert.equal(emailAllowed(bad, ["example.gov"]), false, bad);
  const off = await api("GET", "/v1/pair/email");
  assert.deepEqual(off.json, { required: false, domains: [] });
  const file = path.join(dataDir, "config.json");
  const before = fs.readFileSync(file, "utf8");
  const sent = [];
  globalThis.__servantEmailSend = async (m) => { sent.push(m); };
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), emailVerification: { enabled: true } }));
  try {
    // Enabled with no domains fails closed: nobody's address is allowed and nothing is sent.
    assert.deepEqual((await api("GET", "/v1/pair/email")).json, { required: true, domains: [] });
    const closed = mod.createInvite({ name: "Closed Tester", role: "member" });
    assert.equal((await api("POST", "/v1/pair/email", { body: { code: closed, email: "a@example.gov" } })).json.error?.code, "email_not_allowed");
    assert.equal(sent.length, 0);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(before), emailVerification: { enabled: true, domains: ["example.gov"] } }));
    assert.deepEqual((await api("GET", "/v1/pair/email")).json, { required: true, domains: ["example.gov"] });
    const code = mod.createInvite({ name: "Email Tester", role: "member" });
    const join = extra => api("POST", "/v1/pair", { body: { code, device: "Test phone", terms: ACCEPT, ...extra } });
    assert.equal((await join({})).json.error?.code, "email_required");
    const start = e => api("POST", "/v1/pair/email", { body: { code, email: e } });
    assert.equal((await start("x@other.example.com")).json.error?.code, "email_not_allowed");
    assert.equal((await start("nope")).json.error?.code, "email_invalid");
    assert.equal((await api("POST", "/v1/pair/email", { body: { code: "ZZZZ-ZZZZ", email: "a@example.gov" } })).status, 403);
    assert.equal(sent.length, 0);
    const ok = await start("Pat.Tester@Example.gov");
    assert.equal(ok.status, 200, ok.text);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "pat.tester@example.gov");
    assert.match(sent[0].code, /^\d{6}$/);
    assert.ok(!JSON.stringify(ok.json).includes(sent[0].code));
    const wrong = sent[0].code === "000000" ? "111111" : "000000";
    assert.equal((await join({ emailChallenge: ok.json.challenge, emailCode: wrong })).json.error?.code, "email_code_wrong");
    const good = await join({ emailChallenge: ok.json.challenge, emailCode: sent[0].code });
    assert.equal(good.status, 201, good.text);
    const saved = createStateStore({ directory: dataDir }).read();
    assert.equal(saved.users[good.json.user.id].email, "pat.tester@example.gov");
    // the code works once
    const code2 = mod.createInvite({ name: "Second", role: "member" });
    const again = await api("POST", "/v1/pair", { body: { code: code2, device: "x", terms: ACCEPT, emailChallenge: ok.json.challenge, emailCode: sent[0].code } });
    assert.equal(again.json.error?.code, "email_code_expired");
    // #41: the same confirmed email from another device signs in as the same person, not a second one
    const team = (await mod.joinLink({ fresh: true })).code;
    const start2 = await api("POST", "/v1/pair/email", { body: { code: team, email: "pat.tester@example.gov" } });
    assert.equal(start2.status, 200, start2.text);
    const back = await api("POST", "/v1/pair", { body: { code: team, device: "Desktop", terms: ACCEPT, emailChallenge: start2.json.challenge, emailCode: sent.at(-1).code } });
    assert.equal(back.status, 201, back.text);
    assert.equal(back.json.user.id, good.json.user.id);
    // Someone who joined before email codes adds their email from inside the app.
    const me0 = (await api("GET", "/v1/me", { token: old })).json;
    assert.equal(me0.emailRequired, true);
    assert.equal((await api("POST", "/v1/people/me/email", { token: old, body: { email: "pat.tester@example.gov" } })).json.error?.code, "email_taken", "an address someone else confirmed can't be claimed");
    const mine = await api("POST", "/v1/people/me/email", { token: old, body: { email: "early@example.gov" } });
    assert.equal(mine.status, 200, mine.text);
    const bad = await api("POST", "/v1/people/me/email/confirm", { token: old, body: { challenge: mine.json.challenge, code: "x" } });
    assert.equal(bad.json.error?.code, "email_code_wrong");
    const done = await api("POST", "/v1/people/me/email/confirm", { token: old, body: { challenge: mine.json.challenge, code: sent.at(-1).code } });
    assert.equal(done.status, 200, done.text);
    const me1 = (await api("GET", "/v1/me", { token: old })).json;
    assert.deepEqual([me1.emailRequired, me1.user.emailVerified], [false, true]);
    // a challenge for the join flow can't confirm an account email
    const other = await api("POST", "/v1/people/me/email/confirm", { token: otherEarly, body: { challenge: ok.json.challenge, code: "000000" } });
    assert.ok(other.json.error);
  } finally {
    delete globalThis.__servantEmailSend;
    fs.writeFileSync(file, before);
  }
});

test("plaintext transition applies only to explicitly grandfathered unexpired paired devices", async () => {
  const token = await pair("member", "Legacy transition");
  const headers = { Authorization: `Bearer ${token}` };
  const plain = path => fetch(base + path, { headers });
  assert.equal((await plain("/v1/me")).status, 426);
  const s = createStateStore({ directory: dataDir });
  const mutateDevice = fn => s.mutate(state => {
    const device = Object.values(state.devices).find(d => state.users[d.userId]?.name === "Legacy transition");
    fn(device);
  });
  try {
    mutateDevice(d => { d.legacyPlaintextUntil = Date.now() + 60000; });
    const accepted = await plain("/v1/me");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("deprecation"), "true");
    await accepted.json();
    assert.equal((await fetch(base + "/v1/pair", { method: "POST", body: "{}" })).status, 426);
    assert.equal((await fetch(base + "/v1/pair", { method: "POST", headers, body: "{}" })).status, 426);
    mutateDevice(d => { d.legacyPlaintextUntil = Date.now() - 1; });
    assert.equal((await plain("/v1/me")).status, 426);
    mutateDevice(d => { d.legacyPlaintextUntil = Date.now() + 60000; d.revokedAt = Date.now(); });
    assert.equal((await plain("/v1/me")).status, 426);
  } finally { s.close(); }
});

test("server info answers on /v1/server and the older /v1/hub", async () => {
  for (const p of ["/v1/server", "/v1/hub"]) {
    const r = await api("GET", p);
    assert.equal(r.status, 200);
    assert.equal(r.json.name, "Test server");
  }
});

test("invites are single use and pair link carries the discovery URL", async () => {
  const code = mod.createInvite({ name: "Ana", role: "member" });
  assert.match(code, /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
  assert.match(mod.pairLink(code), /^servant:\/\/pair\?code=.+&d=https%3A%2F%2Fexample.test%2Fhub.json$/);
  assert.equal((await api("POST", "/v1/pair", { body: { terms: ACCEPT, code } })).status, 201);
  const again = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code } });
  assert.equal(again.status, 403);
  assert.equal(again.json.error.code, "invite_used");
  assert.match(again.json.error.message, /already used/);
});

test("an owner invite signs the server's own Mac in with a loopback link and no phone", async () => {
  const first = mod.ownerInvite({ name: "Sam" });
  const link = new URL(mod.pairLink(first.code, { port: 8787, discoveryUrl: "https://example.test/hub.json" }, { local: true }));
  assert.equal(link.searchParams.get("server"), "http://127.0.0.1:8787");
  assert.equal(link.searchParams.get("d"), null, "a local link never depends on discovery");
  assert.match(link.searchParams.get("key"), /^(02|03)[0-9a-f]{64}$/);
  const paired = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code: first.code } });
  assert.equal(paired.status, 201);
  assert.equal(paired.json.user.role, "owner");
  const second = mod.ownerInvite();
  assert.equal(second.existing, true, "later owner invites add a device to the same owner");
  const again = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code: second.code } });
  assert.equal(again.json.user.id, paired.json.user.id);
});

test("the join link works for many people, asks each for a name, and a fresh link retires it", async () => {
  const { code } = mod.joinLink();
  assert.equal(mod.joinLink().code, code, "same live link until replaced");
  const noName = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code } });
  assert.equal(noName.status, 400);
  assert.equal(noName.json.error.code, "name_required");
  const a = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code, name: "Gus" } });
  const b = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code, name: "Hana" } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.json.user.role, "member");
  assert.notEqual(a.json.user.id, b.json.user.id);
  assert.equal(b.json.user.name, "Hana");
  const next = mod.joinLink({ fresh: true }).code;
  assert.notEqual(next, code);
  assert.equal((await api("POST", "/v1/pair", { body: { terms: ACCEPT, code, name: "Ivy" } })).status, 403);
  assert.equal((await api("POST", "/v1/pair", { body: { terms: ACCEPT, code: next, name: "Ivy" } })).status, 201);
});

// config.json is re-read per request; set work hours for one test.
test("@agent with real work opens a shared agent chat with the request, linked from the thread", async () => {
  const ana = await pair("owner", "Work Ana");
  const ch = (await api("POST", "/v1/conversations", { token: ana, body: { name: "work-handoff" } })).json.conversation;
  const route = `/v1/conversations/${ch.id}`;
  const ask = (await api("POST", route + "/messages", { token: ana, body: { text: "@agent WORKCHAT update the refund script" } })).json.message;
  let link;
  for (let i = 0; i < 150 && !link; i++) {
    const thread = (await api("GET", `${route}/threads/${ask.id}`, { token: ana })).json;
    link = (thread.replies || thread.messages || []).map(m => m.text).find(t => /\(\/chat\/cht_/.test(t || ""));
    if (!link) await new Promise(r => setTimeout(r, 100));
  }
  assert.doesNotMatch(link, /servant-chat/);
  const chatId = link.match(/\/chat\/(cht_[\w-]+)/)[1];
  const chat = (await api("GET", `/v1/chats/${chatId}`, { token: ana })).json.chat;
  assert.equal(chat.title, "Refund script update");
  assert.equal(chat.shared, true, "shared with the server so anyone can follow");
  const turns = (await api("GET", `/v1/chats/${chatId}/turns`, { token: ana })).json.turns;
  assert.ok(turns.length >= 1, "the agent was started on it");
  assert.match(turns.at(-1).text, /asked for this in #work-handoff/);
});

test("deleting an agent chat removes its prompts, replies and streamed events from the turns database, and only that chat's", async () => {
  const token = await pair("member", "Dana Delete");
  const doomed = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  const kept = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  for (const c of [doomed, kept]) assert.equal((await api("POST", `/v1/chats/${c.id}/messages`, { token, body: { text: `secret words for ${c.id}` } })).status, 200);
  const db = new DatabaseSync(path.join(dataDir, "agent-turns.db"));
  try {
    const turns = chatId => db.prepare("SELECT COUNT(*) AS n FROM private_turns WHERE chat_id=?").get(chatId).n;
    const events = chatId => db.prepare("SELECT COUNT(*) AS n FROM private_turn_events WHERE turn_id IN (SELECT id FROM private_turns WHERE chat_id=?)").get(chatId).n;
    assert.ok(turns(doomed.id) >= 1 && events(doomed.id) >= 1, "there is conversation to delete");
    assert.equal((await api("DELETE", `/v1/chats/${doomed.id}`, { token })).status, 200);
    assert.equal(turns(doomed.id), 0, "prompt and reply text are gone from the database");
    assert.equal(events(doomed.id), 0, "so is every streamed delta");
    assert.ok(turns(kept.id) >= 1 && events(kept.id) >= 1, "the other chat is untouched");
  } finally { db.close(); }
});

test("agent chats: invite people at the start or later, choosing how much history they see", async () => {
  const token = await pair("member", "Pat Tester");
  const jo = await pair("member", "Jo Park");
  const ana = await pair("member", "Ana Ruiz");
  const stranger = await pair("member", "Invite Stranger");
  const idOf = async who => (await api("GET", "/v1/people", { token: who })).json.me;
  const joId = await idOf(jo), anaId = await idOf(ana);
  const texts = async who => (await api("GET", `/v1/chats/${chat.id}/messages`, { token: who })).json.messages.map(m => m.text).join("\n");

  // At the start: invited people see the whole chat, read only, and it lists for them.
  const started = await api("POST", "/v1/chats", { token, body: { memberIds: [joId] } });
  assert.equal(started.status, 201);
  const chat = started.json.chat;
  assert.deepEqual(chat.members.map(m => m.id), [joId]);
  assert.equal(chat.members[0].since, 0, "invited at the start: everything");
  assert.equal(chat.shared, false, "inviting is not sharing with the server");
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "early question" } });
  await api("GET", `/v1/chats/${chat.id}/messages`, { token });
  assert.match(await texts(jo), /early question/);
  assert.ok((await api("GET", "/v1/chats?scope=org", { token: jo })).json.orgChats.some(c => c.id === chat.id), "listed for the person invited");
  assert.equal((await api("GET", "/v1/chats?scope=org", { token: stranger })).json.orgChats.some(c => c.id === chat.id), false, "not for anyone else");
  assert.equal((await api("GET", `/v1/chats/${chat.id}/messages`, { token: stranger })).status, 404);
  assert.equal((await api("POST", `/v1/chats/${chat.id}/messages`, { token: jo, body: { text: "hi" } })).status, 403, "invited people read; only the author writes");
  assert.equal((await api("POST", `/v1/chats/${chat.id}/members`, { token: jo, body: { userIds: [anaId] } })).status, 403, "only the author invites");

  // During the chat with no history: only what comes after.
  await new Promise(r => setTimeout(r, 15));
  const added = await api("POST", `/v1/chats/${chat.id}/members`, { token, body: { userIds: [anaId], history: "none" } });
  assert.equal(added.status, 200);
  const ana1 = added.json.chat.members.find(m => m.id === anaId);
  assert.equal(ana1.since, ana1.invitedAt);
  await new Promise(r => setTimeout(r, 15));
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "later question" } });
  await api("GET", `/v1/chats/${chat.id}/messages`, { token });
  const seen = await texts(ana);
  assert.match(seen, /later question/);
  assert.doesNotMatch(seen, /early question/, "earlier messages are hidden from her");
  assert.match(await texts(token), /early question/, "and still there for the author: hidden, never removed");
  assert.match(await texts(jo), /early question/);

  // The last day / week reaches back that far; all is everything.
  const day = (await api("POST", `/v1/chats/${chat.id}/members`, { token, body: { userIds: [anaId], history: "day" } })).json.chat.members.find(m => m.id === anaId);
  assert.equal(day.invitedAt - day.since, 86_400_000);
  assert.match(await texts(ana), /early question/);
  const week = (await api("POST", `/v1/chats/${chat.id}/members`, { token, body: { userIds: [anaId], history: "week" } })).json.chat.members.find(m => m.id === anaId);
  assert.equal(week.invitedAt - week.since, 7 * 86_400_000);
  assert.equal((await api("POST", `/v1/chats/${chat.id}/members`, { token, body: { userIds: [anaId], history: "month" } })).status, 400);
  assert.equal((await api("POST", `/v1/chats/${chat.id}/members`, { token, body: { userIds: ["usr_nobody"] } })).status, 404);
  assert.equal((await api("POST", "/v1/chats", { token, body: { memberIds: ["usr_nobody"] } })).status, 404);

  // Removing someone takes the chat away from them.
  const removed = await api("DELETE", `/v1/chats/${chat.id}/members/${anaId}`, { token });
  assert.deepEqual(removed.json.chat.members.map(m => m.id), [joId]);
  assert.equal((await api("GET", `/v1/chats/${chat.id}/messages`, { token: ana })).status, 404);
});

test("agent chats: swipe to archive, restore, and a new message un-archives; only the owner can", async () => {
  const token = await pair("member", "Arlo");
  const other = await pair("member", "Bea");
  const chat = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "start" } });
  assert.equal(chat.archived, false);
  assert.equal(chat.shared, false, "a new chat is private");
  assert.equal((await api("PATCH", `/v1/chats/${chat.id}`, { token, body: { shared: true } })).json.chat.shared, true, "the author can share it afterwards");
  assert.equal((await api("POST", `/v1/chats/${chat.id}/archive`, { token: other })).status, 403, "someone else's shared chat is read only");
  const archived = await api("POST", `/v1/chats/${chat.id}/archive`, { token });
  assert.equal(archived.status, 200);
  assert.equal(archived.json.chat.archived, true);
  assert.equal((await api("GET", "/v1/chats", { token })).json.chats.find((c) => c.id === chat.id).archived, true, "still listed, marked archived");
  const seenByOther = (await api("GET", "/v1/chats?scope=org", { token: other })).json.orgChats.find((c) => c.id === chat.id);
  assert.ok(seenByOther, "still shared with the org");
  assert.equal(seenByOther.archived, undefined, "archive is personal: others never see it");
  assert.equal((await api("POST", `/v1/chats/${chat.id}/restore`, { token })).json.chat.archived, false);
  await api("POST", `/v1/chats/${chat.id}/archive`, { token });
  assert.equal((await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "back again" } })).status, 200);
  assert.equal((await api("GET", "/v1/chats", { token })).json.chats.find((c) => c.id === chat.id).archived, false, "writing in it brings it back");
  assert.equal((await api("DELETE", `/v1/chats/${chat.id}`, { token })).status, 200);
  assert.equal((await api("GET", "/v1/chats", { token })).json.chats.some((c) => c.id === chat.id), false);
});

test("agent chat list shows the last message under each title, like DMs", async () => {
  const token = await pair("member", "Lastline Lou");
  const other = await pair("member", "Lastline Max");
  const chat = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  const sent = await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "**summarize** the repo" } });
  assert.equal(sent.status, 200);
  await api("GET", `/v1/chats/${chat.id}/messages`, { token });
  assert.equal((await api("PATCH", `/v1/chats/${chat.id}`, { token, body: { shared: true } })).status, 200, "shared afterwards, by choice");
  const mine = (await api("GET", "/v1/chats?scope=org", { token })).json.chats.find(c => c.id === chat.id);
  assert.ok(mine.lastMessage, "has a last message");
  assert.equal(mine.lastMessage.role, "assistant");
  assert.match(mine.lastMessage.text, /summarize the repo/, "flattened markdown, one line");
  assert.ok(!mine.lastMessage.text.includes("**"));
  assert.ok(mine.lastMessage.text.length <= 140);
  const theirs = (await api("GET", "/v1/chats?scope=org", { token: other })).json.orgChats.find(c => c.id === chat.id);
  assert.deepEqual(theirs.lastMessage, mine.lastMessage, "shared rows carry it too");
});

test("shared conversations show unread to other readers; opening one or Mark all as read clears it", async () => {
  const token = await pair("member", "Unread Una");
  const reader = await pair("member", "Unread Rex");
  const chat = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  await api("PATCH", `/v1/chats/${chat.id}`, { token, body: { shared: true } });
  const listed = async who => (await api("GET", "/v1/chats?scope=org", { token: who })).json.orgChats.find(c => c.id === chat.id);
  // The reader's first look starts the clock: nothing that already exists lights up.
  await api("GET", "/v1/chats?scope=org", { token: reader });
  await new Promise(r => setTimeout(r, 15));
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "first question" } });
  await api("GET", `/v1/chats/${chat.id}/messages`, { token });
  assert.equal((await listed(reader))?.unread, 1, "a new reply is unread for other readers");
  assert.equal((await api("GET", `/v1/chats/${chat.id}`, { token: reader })).status, 200);
  assert.equal((await listed(reader)).unread, 1, "fetching the chat record alone is not reading it");
  assert.equal((await api("GET", `/v1/chats/${chat.id}/messages`, { token: reader })).status, 200);
  assert.equal((await listed(reader)).unread, 0, "opening the conversation reads it");
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "another" } });
  await api("GET", `/v1/chats/${chat.id}/messages`, { token });
  assert.equal((await listed(reader)).unread, 1);
  assert.equal((await api("POST", "/v1/chats/read-all", { token: reader })).status, 200);
  assert.equal((await listed(reader)).unread, 0, "Mark all as read clears other people's conversations");
  const mineBefore = (await api("GET", "/v1/chats", { token })).json.chats.find(c => c.id === chat.id).unread;
  assert.ok(mineBefore >= 1, "the author still has their own unread");
  assert.equal((await api("POST", "/v1/chats/read-all", { token })).status, 200);
  assert.equal((await api("GET", "/v1/chats", { token })).json.chats.find(c => c.id === chat.id).unread, 0, "and Mark all as read clears it");
  assert.equal((await api("POST", "/v1/chats/read-all", {})).status, 401, "signed-out can't");
});

test("full access (default): a member's private chat uses the full agent and sees tool names", async () => {
  const token = await pair("member", "Fran");
  const created = await api("POST", "/v1/chats", { token, body: {} });
  assert.equal(created.status, 201);
  const ownerCalls = owner.calls.length;
  const memberCalls = member.calls.length;
  const sent = await api("POST", `/v1/chats/${created.json.chat.id}/messages`, { token, body: { text: "read the repo" } });
  assert.equal(sent.status, 200);
  const deltas = parseSse(sent.text).filter((e) => e.event === "delta").map((e) => e.data.text).join("");
  assert.equal(deltas, "owner-agent heard: read the repo");
  assert.ok(owner.calls.length > ownerCalls, "went to the full agent");
  assert.equal(member.calls.length, memberCalls, "never touched the limited agent");
});

test("researcher (tier 4): runs only on the researcher agent, never the full one, even with full agent access on", async () => {
  const boss = await pair("owner", "Research Owner");
  const token = await pair("member", "Rae Researcher");
  const me = (await api("GET", "/v1/people", { token: boss })).json.people.find((p) => p.name === "Rae Researcher");
  const set = await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { agentTier: 4 } });
  assert.equal(set.status, 200);
  assert.deepEqual([set.json.person.agentTier, !!set.json.person.vibeCoder], [4, false]);
  const created = await api("POST", "/v1/chats", { token, body: { project: "servant", mode: "vibe" } });
  assert.equal(created.status, 201);
  assert.equal(created.json.chat.mode, undefined, "never a vibe chat");
  assert.equal(created.json.chat.projectId, undefined, "never tied to a project's repo");
  const [o, m, r] = [owner.calls.length, member.calls.length, researcher.calls.length];
  const sent = await api("POST", `/v1/chats/${created.json.chat.id}/messages`, { token, body: { text: "find me recent research on call-center wait times" } });
  assert.equal(sent.status, 200, sent.text);
  const deltas = parseSse(sent.text).filter((e) => e.event === "delta").map((e) => e.data.text).join("");
  assert.equal(deltas, "researcher-agent heard: find me recent research on call-center wait times");
  assert.equal(owner.calls.length, o, "never touched the full agent");
  assert.equal(member.calls.length, m, "never touched the member agent");
  assert.ok(researcher.calls.length > r, "went to the researcher agent");
  // The agent is told the rules, and is never given a project's repo or GitHub workflow.
  const turn = researcher.calls.slice(r).find((c) => c.url.endsWith("/chat/stream"));
  const prompt = JSON.stringify(turn.body);
  assert.match(prompt, /GitHub/);
  assert.match(prompt, /no gh, no git/);
  assert.doesNotMatch(prompt, /slavingia\/servant|example-org\/prototypes/);
});

test("researcher (tier 4): a bridge that isn't the researcher bridge is refused, so the full agent can't stand in", async () => {
  const boss = await pair("owner", "Research Owner Two");
  const token = await pair("member", "Ray Researcher");
  const me = (await api("GET", "/v1/people", { token: boss })).json.people.find((p) => p.name === "Ray Researcher");
  await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { agentTier: 4 } });
  const cfgFile = path.join(dataDir, "config.json");
  const before = fs.readFileSync(cfgFile, "utf8");
  const cfg = JSON.parse(before);
  // Point the researcher lane at the FULL agent (which doesn't attest researcher isolation).
  cfg.upstreams.researcher = { url: cfg.upstreams.owner.url, key: "owner-key" };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  try {
    const [o, r] = [owner.calls.length, researcher.calls.length];
    const created = await api("POST", "/v1/chats", { token, body: {} });
    assert.notEqual(created.status, 201, "no chat on an unverified bridge");
    const toolCalls = owner.calls.slice(o).filter((c) => c.url.includes("/chat/stream"));
    assert.equal(toolCalls.length, 0, "nothing was ever sent to the full agent");
    assert.equal(researcher.calls.length, r);
  } finally { fs.writeFileSync(cfgFile, before); }
});

test("researcher (tier 4): an old chat on the full agent stops working once someone becomes a researcher", async () => {
  const boss = await pair("owner", "Research Owner Three");
  const token = await pair("member", "Rio Researcher");
  const me = (await api("GET", "/v1/people", { token: boss })).json.people.find((p) => p.name === "Rio Researcher");
  const old = await api("POST", "/v1/chats", { token, body: {} });
  assert.equal(old.status, 201);
  await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { agentTier: 4 } });
  const o = owner.calls.length;
  const sent = await api("POST", `/v1/chats/${old.json.chat.id}/messages`, { token, body: { text: "use gh to list issues" } });
  const sawOwner = owner.calls.slice(o).some((c) => c.url.endsWith("/chat/stream"));
  assert.equal(sawOwner, false, "the old full-agent chat can no longer run");
  assert.ok(!sent.text.includes("owner-agent heard"), sent.text.slice(0, 200));
});

test("each agent chat is its own session: a separate Hermes session and session key per chat", async () => {
  const token = await pair("member", "Sol Sessions");
  const a = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  const b = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  const before = owner.calls.length;
  await api("POST", `/v1/chats/${a.id}/messages`, { token, body: { text: "first chat" } });
  await api("POST", `/v1/chats/${b.id}/messages`, { token, body: { text: "second chat" } });
  const streams = owner.calls.slice(before).filter((c) => c.url.endsWith("/chat/stream"));
  assert.equal(streams.length, 2);
  const [sa, sb] = streams;
  assert.notEqual(sa.url, sb.url, "different Hermes sessions");
  assert.notEqual(sa.headers["x-hermes-session-key"], sb.headers["x-hermes-session-key"], "different session keys");
  assert.ok(sa.headers["x-hermes-session-key"].endsWith(a.id));
  assert.equal(sa.body.system_message, undefined, "no project, no extra instructions");
});

test("projects: the list comes from projects.json; a chat in one carries its repo, workflow, rules and what the asker may do", async () => {
  const pat = await pair("member", "Pat Projects");
  const ro = await pair("member", "Ro Reader");
  const listed = await api("GET", "/v1/projects", { token: pat });
  assert.equal(listed.status, 200);
  assert.deepEqual([listed.json.vibeCoder, listed.json.vibe], [false, true]);
  assert.deepEqual(listed.json.projects.map(p => p.id), ["servant"], "projects you aren't in don't exist for you");
  const servant = listed.json.projects[0];
  assert.deepEqual([servant.access, servant.canEdit, servant.canWrite, servant.workflow, servant.repo, servant.rules], ["write", false, true, "main", "slavingia/servant", ["Never rewrite pushed history"]]);
  // GitHub logins the people map knows become Servant people; unmapped ones stay logins.
  assert.deepEqual(servant.people.map(p => [p.name, p.level, p.owner, p.github ?? null, !!p.id]), [["bossgh", "merge", true, "bossgh", false], ["Pat Projects", "write", false, "patgh", true], ["Ro Reader", "read", false, "rogh", true]]);
  assert.equal((await api("GET", "/v1/projects/secret", { token: pat })).status, 404);
  assert.equal((await api("POST", "/v1/chats", { token: pat, body: { projectId: "secret" } })).status, 404);
  assert.equal((await api("POST", "/v1/chats", { token: pat, body: { projectId: "nope" } })).status, 404);
  // Old builds may still send project ids from the hard-coded days: they get a plain chat.
  assert.equal((await api("POST", "/v1/chats", { token: pat, body: { project: "mac" } })).json.chat.project, undefined);
  // Admins see and can edit every project, listed or not.
  const admin = await pair("owner", "Ada Admin");
  assert.deepEqual((await api("GET", "/v1/projects", { token: admin })).json.projects.map(p => [p.id, p.canEdit, p.access]), [["servant", true, null], ["prototypes", true, null], ["secret", true, null]]);
  // Writers change notes, not the rules; readers change nothing, but they can still chat in the project.
  assert.equal((await api("PATCH", "/v1/projects/servant", { token: pat, body: { notes: "Ship small." } })).status, 200);
  assert.equal((await api("PATCH", "/v1/projects/servant", { token: pat, body: { rules: ["Mine"] } })).status, 403);
  assert.equal((await api("PATCH", "/v1/projects/servant", { token: ro, body: { notes: "Mine" } })).status, 403);
  assert.equal((await api("POST", "/v1/projects/servant/files", { token: ro, body: { name: "a.txt", data: Buffer.from("x").toString("base64") } })).status, 403);
  for (const [token, name, line] of [[pat, "Pat Projects", /Pat Projects can write but not merge: push following the workflow above, but never merge on their behalf/], [ro, "Ro Reader", /Ro Reader can read only: don't push or merge on their behalf; propose changes or open a PR for someone with write\./]]) {
    const chat = (await api("POST", "/v1/chats", { token, body: { projectId: "servant" } })).json.chat;
    assert.deepEqual([chat.projectId, chat.project, chat.folderId], ["servant", { id: "servant", name: "Servant" }, "servant"]);
    await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: `ship it ${name}` } });
    const stream = await waitFor(() => [...owner.calls, ...member.calls].find(c => c.url.endsWith("/chat/stream") && c.body.message === `ship it ${name}`));
    const sys = stream.body.system_message;
    assert.match(sys, /project "Servant" \(The team app\)/);
    assert.match(sys, /\(GitHub: slavingia\/servant\)/);
    assert.match(sys, /How we work: push to main, no PRs\./);
    assert.match(sys, /\n- Never rewrite pushed history/);
    assert.match(sys, /Project notes from the team:\nShip small\./);
    assert.match(sys, line);
  }
  // The file is the source of truth: an edit by hand shows up on the next request.
  const file = path.join(dataDir, "projects.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.projects.find(p => p.id === "servant").workflow = "pr";
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n\n");
  assert.equal((await api("GET", "/v1/projects/servant", { token: pat })).json.project.workflow, "pr");
  raw.projects.find(p => p.id === "servant").workflow = "main";
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  assert.equal((await api("GET", "/v1/projects/servant", { token: pat })).json.project.workflow, "main");
});

test("projects made in the app: notes and files every chat in them sees; people can read, write or merge", async () => {
  const token = await pair("member", "Fran Founder");
  const other = await pair("member", "Olly Other");
  const ollyId = (await api("GET", "/v1/people", { token: other })).json.me;
  assert.equal((await api("POST", "/v1/projects", { token, body: { name: "  " } })).status, 400);
  const project = (await api("POST", "/v1/projects", { token, body: { name: "Refund tracker", notes: "Audience: customers. Plain words." } })).json.project;
  assert.deepEqual([project.id, project.name, project.chatCount, project.access, project.canEdit, project.workflow, project.rules, project.role], ["refund-tracker", "Refund tracker", 0, "merge", true, "main", [], "owner"]);
  assert.deepEqual(project.people.map(p => [p.name, p.level, p.owner]), [["Fran Founder", "merge", true]]);
  // Only people in a project see it.
  assert.ok(!(await api("GET", "/v1/projects", { token: other })).json.projects.some(p => p.id === project.id));
  assert.equal((await api("GET", `/v1/projects/${project.id}`, { token: other })).status, 404);
  assert.equal((await api("POST", "/v1/chats", { token: other, body: { projectId: project.id } })).status, 404);
  const added = await api("POST", `/v1/projects/${project.id}/files`, { token, body: { name: "brief.md", data: Buffer.from("The product shows refund status.").toString("base64") } });
  assert.equal(added.status, 200);
  assert.deepEqual(added.json.project.files.map(f => f.name), ["brief.md"]);
  const chatA = (await api("POST", "/v1/chats", { token, body: { projectId: project.id } })).json.chat;
  const chatB = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  assert.equal(chatA.projectId, project.id);
  assert.equal(chatB.projectId, undefined);
  // Move chat B in, then both carry the project's context on every turn.
  assert.equal((await api("PATCH", `/v1/chats/${chatB.id}`, { token, body: { projectId: project.id } })).json.chat.projectId, project.id);
  assert.equal((await api("GET", `/v1/projects/${project.id}`, { token })).json.project.chatCount, 2);
  for (const chat of [chatA, chatB]) {
    await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: `hello from ${chat.id}` } });
    const stream = await waitFor(() => [...owner.calls, ...member.calls].find(c => c.url.endsWith("/chat/stream") && c.body.message === `hello from ${chat.id}`));
    assert.match(stream.body.system_message, /project "Refund tracker"/);
    assert.match(stream.body.system_message, /Audience: customers/);
    assert.doesNotMatch(stream.body.system_message, /How we work/, "no repo, no workflow talk");
    // The full agent reads files from disk by path.
    assert.match(stream.body.system_message, /brief\.md.*project-files/);
  }
  // A limited agent never gets a path: small text files come inline instead.
  await withAgentAccess("limited", async () => {
    const limited = (await api("POST", "/v1/chats", { token, body: { projectId: project.id } })).json.chat;
    await api("POST", `/v1/chats/${limited.id}/messages`, { token, body: { text: "again, limited" } });
    const stream = await waitFor(() => [...owner.calls, ...member.calls].find(c => c.url.endsWith("/chat/stream") && c.body.message === "again, limited"));
    assert.match(stream.body.system_message, /The product shows refund status\./);
    assert.doesNotMatch(stream.body.system_message, /project-files/);
  });
  // Owners set how the team works and who's in: a Servant person with a level, or a GitHub login.
  const edited = (await api("PATCH", `/v1/projects/${project.id}`, { token, body: { name: "Refunds", description: "Where's my refund, explained", repo: "https://github.com/example/refunds", path: "~/refunds", workflow: "pr", rules: ["Plain words only"] } })).json.project;
  assert.deepEqual([edited.name, edited.description, edited.repo, edited.path, edited.workflow, edited.rules], ["Refunds", "Where's my refund, explained", "example/refunds", "~/refunds", "pr", ["Plain words only"]]);
  assert.equal((await api("PATCH", `/v1/projects/${project.id}`, { token, body: { workflow: "trunk" } })).status, 400);
  assert.equal((await api("POST", `/v1/projects/${project.id}/people`, { token, body: { userId: ollyId, level: "boss" } })).status, 400);
  assert.equal((await api("POST", `/v1/projects/${project.id}/people`, { token, body: { userId: "usr_nope", level: "read" } })).status, 404);
  assert.equal((await api("POST", `/v1/projects/${project.id}/people`, { token, body: { github: "not a login", level: "read" } })).status, 400);
  let people = (await api("POST", `/v1/projects/${project.id}/people`, { token, body: { userId: ollyId, level: "read" } })).json.project.people;
  assert.deepEqual(people.map(p => [p.name, p.level]), [["Fran Founder", "merge"], ["Olly Other", "read"]]);
  people = (await api("POST", `/v1/projects/${project.id}/people`, { token, body: { github: "@octocat", level: "merge" } })).json.project.people;
  assert.deepEqual(people.find(p => p.github === "octocat"), { key: "octocat", name: "octocat", github: "octocat", level: "merge", owner: false });
  // Olly can read: sees the project and chats in it, but can't change notes or files. With write, they can.
  const seen = (await api("GET", `/v1/projects/${project.id}`, { token: other })).json.project;
  assert.deepEqual([seen.access, seen.canWrite, seen.canEdit, seen.role], ["read", false, false, "member"]);
  assert.equal((await api("PATCH", `/v1/projects/${project.id}`, { token: other, body: { notes: "mine" } })).status, 403);
  assert.equal((await api("POST", "/v1/chats", { token: other, body: { projectId: project.id } })).json.chat.projectId, project.id);
  assert.equal((await api("POST", `/v1/projects/${project.id}/people`, { token, body: { key: "nobody", level: "write" } })).status, 404);
  const promoted = (await api("POST", `/v1/projects/${project.id}/people`, { token, body: { key: ollyId, level: "write" } })).json.project;
  assert.equal(promoted.people.find(p => p.id === ollyId).level, "write");
  assert.equal((await api("PATCH", `/v1/projects/${project.id}`, { token: other, body: { notes: "Olly adds: test on iPad." } })).status, 200);
  assert.equal((await api("PATCH", `/v1/projects/${project.id}`, { token: other, body: { name: "Mine now" } })).status, 403);
  assert.equal((await api("POST", `/v1/projects/${project.id}/people`, { token: other, body: { github: "friend", level: "read" } })).status, 403);
  assert.equal((await api("DELETE", `/v1/projects/${project.id}`, { token: other })).status, 403);
  // The only owner can't leave. A GitHub login is removed by its key; a person leaving takes their chats out.
  assert.equal((await api("DELETE", `/v1/projects/${project.id}/people/me`, { token })).status, 400);
  assert.equal((await api("DELETE", `/v1/projects/${project.id}/people/octocat`, { token })).json.project.people.some(p => p.github === "octocat"), false);
  assert.equal((await api("DELETE", `/v1/projects/${project.id}/people/${ollyId}`, { token: other })).status, 200);
  assert.equal((await api("GET", `/v1/projects/${project.id}`, { token: other })).status, 404);
  // Remove a file, take a chat out; deleting the project keeps everyone's chats.
  assert.equal((await api("DELETE", `/v1/projects/${project.id}/files/${added.json.project.files[0].id}`, { token })).json.project.files.length, 0);
  assert.equal((await api("PATCH", `/v1/chats/${chatB.id}`, { token, body: { projectId: null } })).json.chat.projectId, undefined);
  assert.equal((await api("DELETE", `/v1/projects/${project.id}`, { token })).status, 200);
  assert.equal((await api("GET", `/v1/chats/${chatA.id}`, { token })).json.chat.projectId, undefined);
  assert.ok(!(await api("GET", "/v1/projects", { token })).json.projects.some(p => p.id === project.id));
  assert.ok(!fs.existsSync(path.join(dataDir, "project-files", project.id)));
  // Let this test's agent turns finish so they don't land in the next test's window.
  for (let last = -1, n = owner.calls.length + member.calls.length; n !== last; await new Promise(r => setTimeout(r, 400))) { last = n; n = owner.calls.length + member.calls.length; }
});

test("shared projects: people in a project share its notes and files, never each other's chats unless one is shared", async () => {
  const ann = await pair("member", "Ann Author");
  const ben = await pair("member", "Ben Buddy");
  const cy = await pair("member", "Cy Outsider");
  const id = async token => (await api("GET", "/v1/people", { token })).json.me;
  const [benId, cyId] = [await id(ben), await id(cy)];
  const project = (await api("POST", "/v1/projects", { token: ann, body: { name: "Tax pro launch", notes: "Goal: ship the client switcher." } })).json.project;
  await api("POST", `/v1/projects/${project.id}/files`, { token: ann, body: { name: "spec.md", data: Buffer.from("Switcher lives in the header.").toString("base64") } });
  // Not in the project yet: no access at all.
  assert.equal((await api("GET", `/v1/projects/${project.id}`, { token: ben })).status, 404);
  assert.equal((await api("POST", "/v1/chats", { token: ben, body: { projectId: project.id } })).status, 404);
  // Only owners add people, and only real ones.
  assert.equal((await api("POST", `/v1/projects/${project.id}/people`, { token: ben, body: { userId: cyId, level: "read" } })).status, 404);
  assert.equal((await api("POST", `/v1/projects/${project.id}/people`, { token: ann, body: { userId: "usr_nope", level: "read" } })).status, 404);
  const withBen = (await api("POST", `/v1/projects/${project.id}/people`, { token: ann, body: { userId: benId, level: "write" } })).json.project;
  assert.deepEqual(withBen.people.map(p => p.name), ["Ann Author", "Ben Buddy"]);
  // Ben sees the project, its notes and files.
  const seen = (await api("GET", `/v1/projects/${project.id}`, { token: ben })).json.project;
  assert.deepEqual([seen.access, seen.canEdit, seen.owner.name], ["write", false, "Ann Author"]);
  assert.match(seen.notes, /client switcher/);
  assert.deepEqual(seen.files.map(f => f.name), ["spec.md"]);
  assert.ok((await api("GET", "/v1/projects", { token: ben })).json.projects.some(p => p.id === project.id));
  assert.ok(!(await api("GET", "/v1/projects", { token: cy })).json.projects.some(p => p.id === project.id));
  // Writers work on the shared context but can't rename, delete or add people.
  assert.equal((await api("PATCH", `/v1/projects/${project.id}`, { token: ben, body: { notes: "Goal: ship the client switcher. Ben adds: test on iPad." } })).status, 200);
  assert.equal((await api("PATCH", `/v1/projects/${project.id}`, { token: ben, body: { name: "Mine now" } })).status, 403);
  assert.equal((await api("DELETE", `/v1/projects/${project.id}`, { token: ben })).status, 403);
  assert.equal((await api("POST", `/v1/projects/${project.id}/people`, { token: ben, body: { userId: cyId, level: "read" } })).status, 403);
  // Each person starts their own chat; both carry the shared context. A new chat is private to its author unless they say otherwise.
  const annChat = (await api("POST", "/v1/chats", { token: ann, body: { projectId: project.id } })).json.chat;
  const benChat = (await api("POST", "/v1/chats", { token: ben, body: { projectId: project.id } })).json.chat;
  assert.equal(annChat.shared, false);
  assert.equal(benChat.shared, false);
  assert.equal((await api("POST", "/v1/chats", { token: ann, body: { projectId: project.id, shared: true } })).json.chat.shared, false, "asking for shared at creation is ignored: sharing is chosen afterwards");
  for (const [token, chat] of [[ann, annChat], [ben, benChat]]) {
    await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: `question from ${chat.id}` } });
    const stream = await waitFor(() => [...owner.calls, ...member.calls].find(c => c.url.endsWith("/chat/stream") && c.body.message === `question from ${chat.id}`));
    assert.match(stream.body.system_message, /project "Tax pro launch"/);
    assert.match(stream.body.system_message, /test on iPad/);
    assert.match(stream.body.system_message, /spec\.md/);
  }
  // Private by default: neither can read the other's chat, in the project or out of it.
  assert.equal((await api("GET", `/v1/chats/${annChat.id}`, { token: ben })).status, 404);
  assert.equal((await api("GET", `/v1/chats/${annChat.id}/messages`, { token: ben })).status, 404);
  assert.equal((await api("GET", `/v1/chats/${benChat.id}/messages`, { token: ann })).status, 404);
  let listed = (await api("GET", `/v1/projects/${project.id}`, { token: ben })).json;
  assert.deepEqual(listed.sharedChats, []);
  assert.equal(listed.project.chatCount, 1);
  assert.equal((await api("GET", "/v1/chats?scope=org", { token: ben })).json.orgChats.some(c => c.id === annChat.id), false);
  // Sharing with the project opens it, read only, to project people and nobody else.
  assert.equal((await api("PATCH", `/v1/chats/${annChat.id}`, { token: cy, body: { projectShared: true } })).status, 404);
  const shared = (await api("PATCH", `/v1/chats/${annChat.id}`, { token: ann, body: { projectShared: true } })).json.chat;
  assert.equal(shared.projectShared, true);
  assert.equal(shared.shared, false, "sharing with the project doesn't share with the whole server");
  listed = (await api("GET", `/v1/projects/${project.id}`, { token: ben })).json;
  assert.deepEqual(listed.sharedChats.map(c => c.id), [annChat.id]);
  assert.equal(listed.sharedChats[0].author.name, "Ann Author");
  assert.equal((await api("GET", `/v1/chats/${annChat.id}/messages`, { token: ben })).status, 200);
  assert.equal((await api("POST", `/v1/chats/${annChat.id}/messages`, { token: ben, body: { text: "hijack" } })).status, 403);
  assert.equal((await api("GET", `/v1/chats/${annChat.id}/messages`, { token: cy })).status, 404);
  assert.equal((await api("GET", `/v1/projects/${project.id}`, { token: cy })).status, 404);
  assert.equal((await api("GET", "/v1/chats?scope=org", { token: ben })).json.orgChats.some(c => c.id === annChat.id), false, "project sharing isn't server-wide sharing");
  // Taking it back, or moving it out of the project, closes it again.
  await api("PATCH", `/v1/chats/${annChat.id}`, { token: ann, body: { projectShared: false } });
  assert.equal((await api("GET", `/v1/chats/${annChat.id}/messages`, { token: ben })).status, 404);
  await api("PATCH", `/v1/chats/${annChat.id}`, { token: ann, body: { projectShared: true } });
  await api("PATCH", `/v1/chats/${annChat.id}`, { token: ann, body: { projectId: null } });
  assert.equal((await api("GET", `/v1/chats/${annChat.id}/messages`, { token: ben })).status, 404);
  assert.equal((await api("PATCH", `/v1/chats/${annChat.id}`, { token: ann, body: { projectShared: true } })).status, 400, "needs a project first");
  // Leaving: Ben's chat leaves the project with him and loses the shared context.
  await api("PATCH", `/v1/chats/${benChat.id}`, { token: ben, body: { projectShared: true } });
  assert.equal((await api("DELETE", `/v1/projects/${project.id}/people/me`, { token: ben })).status, 200);
  assert.equal((await api("GET", `/v1/projects/${project.id}`, { token: ben })).status, 404);
  const afterLeave = (await api("GET", `/v1/chats/${benChat.id}`, { token: ben })).json.chat;
  assert.equal(afterLeave.projectId, undefined);
  assert.equal(afterLeave.projectShared, undefined);
  assert.equal((await api("GET", `/v1/chats/${benChat.id}/messages`, { token: ann })).status, 404);
  // The only owner can't leave (delete instead); removing someone else is an owner's call.
  await api("POST", `/v1/projects/${project.id}/people`, { token: ann, body: { userId: benId, level: "write" } });
  assert.equal((await api("DELETE", `/v1/projects/${project.id}/people/me`, { token: ann })).status, 400);
  assert.equal((await api("DELETE", `/v1/projects/${project.id}/people/${benId}`, { token: cy })).status, 404);
  assert.equal((await api("DELETE", `/v1/projects/${project.id}/people/${benId}`, { token: ann })).json.project.people.length, 1);
  // A second owner can take over; then the first may leave, and the new owner's file add lands in the one shared project.
  await api("POST", `/v1/projects/${project.id}/people`, { token: ann, body: { userId: benId, level: "merge", owner: true } });
  const more = (await api("POST", `/v1/projects/${project.id}/files`, { token: ben, body: { name: "ben.txt", data: Buffer.from("hi").toString("base64") } })).json.project;
  assert.deepEqual(more.files.map(f => f.name), ["spec.md", "ben.txt"]);
  assert.equal((await api("DELETE", `/v1/projects/${project.id}/people/me`, { token: ann })).status, 200);
  // Deleting the project frees everyone's chats.
  assert.equal((await api("DELETE", `/v1/projects/${project.id}`, { token: ben })).status, 200);
  assert.equal((await api("GET", `/v1/projects/${project.id}`, { token: ben })).status, 404);
  for (let last = -1, n = owner.calls.length + member.calls.length; n !== last; await new Promise(r => setTimeout(r, 400))) { last = n; n = owner.calls.length + member.calls.length; }
});

test("releases: items move through the project's stages; writers plan, whoever owns a cell moves it along, the agent hears what's open", async () => {
  const lead = await pair("member", "Lee Lead");
  const dev = await pair("member", "Dev Doer");
  const ro = await pair("member", "Rae Reader");
  const out = await pair("member", "Out Sider");
  const idOf = async token => (await api("GET", "/v1/people", { token })).json.me;
  const [devId, roId, outId] = [await idOf(dev), await idOf(ro), await idOf(out)];
  // Dates relative to today, so "upcoming" stays upcoming whenever this runs.
  const inDays = n => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const stages = ["Build", "Design", "QA", "Accessibility", "Content"];
  const project = (await api("POST", "/v1/projects", { token: lead, body: { name: "Example app", repo: "example-org/example-app", path: "~/example-app", stages } })).json.project;
  assert.deepEqual([project.stages, project.releases], [stages, []]);
  const P = `/v1/projects/${project.id}`;
  await api("POST", `${P}/people`, { token: lead, body: { userId: devId, level: "write" } });
  await api("POST", `${P}/people`, { token: lead, body: { userId: roId, level: "read" } });
  // Stages are the owner's call, like the rules.
  assert.equal((await api("PATCH", P, { token: dev, body: { stages: ["Build"] } })).status, 403);
  assert.equal((await api("PATCH", P, { token: lead, body: { stages: ["Build", "build"] } })).status, 400);
  // Writers add releases and items; readers can't, and outsiders don't see the project at all.
  const nov = inDays(13);
  assert.equal((await api("POST", `${P}/releases`, { token: ro, body: { name: "November 17", date: nov } })).status, 403);
  assert.equal((await api("POST", `${P}/releases`, { token: out, body: { name: "November 17", date: nov } })).status, 404);
  assert.equal((await api("POST", `${P}/releases`, { token: dev, body: { name: "November 17", date: "17 Nov" } })).status, 400);
  assert.equal((await api("POST", `${P}/releases`, { token: dev, body: { name: "", date: nov } })).status, 400);
  let view = (await api("POST", `${P}/releases`, { token: dev, body: { name: "November 17", date: nov } })).json.project;
  const rel = view.releases[0];
  assert.deepEqual([rel.name, rel.date, rel.items], ["November 17", nov, []]);
  const R = `${P}/releases/${rel.id}`;
  assert.equal((await api("POST", `${R}/items`, { token: ro, body: { title: "Guest mode" } })).status, 403);
  assert.equal((await api("POST", `${R}/items`, { token: dev, body: { title: " " } })).status, 400);
  for (const title of ["Guest mode", "Dark mode", "Payments v2", "Accessibility pass"]) view = (await api("POST", `${R}/items`, { token: dev, body: { title } })).json.project;
  const items = view.releases[0].items;
  assert.deepEqual(items.map(i => i.title), ["Guest mode", "Dark mode", "Payments v2", "Accessibility pass"]);
  assert.deepEqual(items[0].stages, Object.fromEntries(stages.map(s => [s, { status: "todo", owner: null, ownerName: "" }])), "every stage starts as to do, nobody yet");
  const guest = `${R}/items/${items[0].id}`;
  // One cell: a known stage, a real status, an owner who is in the project.
  const cell = (token, body) => api("PATCH", `${guest}/stages`, { token, body });
  assert.equal((await cell(dev, { stage: "Legal", status: "doing" })).status, 400);
  assert.equal((await cell(dev, { stage: "QA", status: "soon" })).status, 400);
  assert.equal((await cell(dev, { stage: "QA", owner: outId })).status, 404);
  assert.equal((await cell(dev, { stage: "QA", owner: "usr_nobody" })).status, 404);
  assert.equal((await cell(ro, { stage: "QA", status: "doing" })).status, 403, "a reader who doesn't own the cell");
  view = (await cell(dev, { stage: "QA", owner: roId, status: "doing" })).json.project;
  assert.deepEqual(view.releases[0].items[0].stages.QA, { status: "doing", owner: roId, ownerName: "Rae Reader" });
  // Now it's Rae's to-do: she can move it along and note it, but still can't touch other cells.
  view = (await cell(ro, { stage: "QA", status: "blocked", note: "Waiting on test accounts" })).json.project;
  assert.deepEqual(view.releases[0].items[0].stages.QA, { status: "blocked", owner: roId, ownerName: "Rae Reader", note: "Waiting on test accounts" });
  assert.equal((await cell(ro, { stage: "Build", status: "done" })).status, 403);
  assert.equal((await api("GET", P, { token: ro })).json.project.releases[0].items[0].stages.QA.note, "Waiting on test accounts", "readers see release data");
  assert.equal((await api("GET", P, { token: out })).status, 404);
  // Reviewers: the owner names who signs off each stage; with no one assigned, those reviewers can tick it.
  assert.equal((await api("PATCH", P, { token: dev, body: { reviewers: { Content: ["dev-doer"] } } })).status, 403, "the owner's call");
  assert.equal((await api("PATCH", P, { token: lead, body: { reviewers: { Content: ["not a login"] } } })).status, 400);
  assert.equal((await api("PATCH", P, { token: lead, body: { reviewers: ["rae"] } })).status, 400);
  assert.equal((await cell(ro, { stage: "Content", status: "doing" })).status, 403, "not a reviewer yet");
  // People are matched by GitHub username through projects.json's "people"; here Rae is mapped by name.
  { const file = path.join(dataDir, "projects.json"); const raw = JSON.parse(fs.readFileSync(file, "utf8")); raw.people = { ...raw.people, "rae-reader": "Rae Reader" }; fs.writeFileSync(file, JSON.stringify(raw)); }
  view = (await api("PATCH", P, { token: lead, body: { reviewers: { Content: ["@rae-reader", "not-here-yet"] } } })).json.project;
  assert.deepEqual(view.reviewers, { Content: [{ key: "rae-reader", id: roId, name: "Rae Reader", github: "rae-reader" }, { key: "not-here-yet", name: "not-here-yet", github: "not-here-yet" }] });
  view = (await cell(ro, { stage: "Content", status: "done" })).json.project;
  assert.equal(view.releases[0].items[0].stages.Content.status, "done", "Rae reviews Content, so she ticks it");
  assert.equal((await cell(ro, { stage: "Content", status: "todo" })).status, 200);
  assert.equal((await cell(ro, { stage: "Accessibility", status: "done" })).status, 403, "only her stage");
  // Every chat in the project tells the agent what's coming, what's open and who owns it.
  const chat = (await api("POST", "/v1/chats", { token: dev, body: { projectId: project.id } })).json.chat;
  await api("POST", `/v1/chats/${chat.id}/messages`, { token: dev, body: { text: "what's left for the 17th?" } });
  const stream = await waitFor(() => [...owner.calls, ...member.calls].find(c => c.url.endsWith("/chat/stream") && c.body.message === "what's left for the 17th?"));
  assert.match(stream.body.system_message, new RegExp(`Upcoming releases \\(today is \\d{4}-\\d{2}-\\d{2}\\), with what isn't done yet and who owns it:\\n- November 17 \\(${nov}\\): Guest mode: Build to do \\(nobody yet\\), Design to do \\(nobody yet\\), QA blocked \\(Rae Reader: Waiting on test accounts\\), Accessibility to do \\(nobody yet\\), Content to do \\(Rae Reader and not-here-yet\\); Dark mode: Build to do`));
  // Taking a stage out hides its column; the cells are kept and come back with it.
  assert.deepEqual(Object.keys((await api("PATCH", P, { token: lead, body: { stages: ["Build", "QA"] } })).json.project.releases[0].items[0].stages), ["Build", "QA"]);
  assert.equal((await api("PATCH", P, { token: lead, body: { stages } })).json.project.releases[0].items[0].stages.QA.status, "blocked");
  // Rename or move a release or an item; take them out. Readers can't.
  assert.equal((await api("PATCH", R, { token: ro, body: { name: "Nov" } })).status, 403);
  view = (await api("PATCH", R, { token: dev, body: { name: "November 18", date: inDays(14) } })).json.project;
  assert.deepEqual([view.releases[0].name, view.releases[0].date], ["November 18", inDays(14)]);
  assert.equal((await api("PATCH", R, { token: dev, body: { date: "2026-02-30" } })).status, 400);
  assert.equal((await api("PATCH", guest, { token: dev, body: { title: "Guest Mode" } })).json.project.releases[0].items[0].title, "Guest Mode");
  assert.equal((await api("DELETE", guest, { token: ro })).status, 403);
  assert.deepEqual((await api("DELETE", `${R}/items/${items[3].id}`, { token: dev })).json.project.releases[0].items.map(i => i.title), ["Guest Mode", "Dark mode", "Payments v2"]);
  assert.equal((await api("DELETE", `${R}/items/itm_nope`, { token: dev })).status, 404);
  assert.equal((await api("PATCH", `${P}/releases/rel_nope`, { token: dev, body: { name: "x" } })).status, 404);
  // The server lists releases by date; the app splits upcoming from past.
  view = (await api("POST", `${P}/releases`, { token: lead, body: { name: "Last month", date: inDays(-30) } })).json.project;
  assert.deepEqual(view.releases.map(r => r.name), ["Last month", "November 18"]);
  assert.equal((await api("DELETE", R, { token: ro })).status, 403);
  assert.deepEqual((await api("DELETE", R, { token: dev })).json.project.releases.map(r => r.name), ["Last month"]);
  // A checklist release: features with parts, and a final box that stays locked until every feature is checked.
  const last = view.releases[0];
  const L = `${P}/releases/${last.id}`;
  assert.deepEqual([last.ready, last.shipped], [false, null], "an empty release can't ship");
  assert.equal((await api("PATCH", L, { token: dev, body: { shipped: true } })).status, 409);
  view = (await api("POST", `${L}/items`, { token: dev, body: { title: "Refund tracker" } })).json.project;
  const F = `${L}/items/${view.releases[0].items[0].id}`;
  assert.equal((await api("POST", `${F}/parts`, { token: ro, body: { title: "Copy" } })).status, 403);
  assert.equal((await api("POST", `${F}/parts`, { token: dev, body: { title: " " } })).status, 400);
  for (const title of ["Copy", "Spanish", "VoiceOver"]) view = (await api("POST", `${F}/parts`, { token: dev, body: { title } })).json.project;
  let feature = view.releases[0].items[0];
  assert.deepEqual([feature.done, feature.parts.map(x => [x.title, x.done])], [false, [["Copy", false], ["Spanish", false], ["VoiceOver", false]]]);
  const part = id => `${F}/parts/${id}`;
  view = (await api("PATCH", part(feature.parts[0].id), { token: dev, body: { done: true } })).json.project;
  assert.deepEqual([view.releases[0].items[0].parts[0].done, view.releases[0].items[0].done, view.releases[0].ready], [true, false, false]);
  assert.equal((await api("PATCH", part("prt_nope"), { token: dev, body: { done: true } })).status, 404);
  view = (await api("DELETE", part(feature.parts[2].id), { token: dev })).json.project;
  assert.deepEqual(view.releases[0].items[0].parts.map(x => x.title), ["Copy", "Spanish"]);
  // Ticking the feature ticks its stages and parts; then the final box opens.
  view = (await api("PATCH", F, { token: dev, body: { done: true } })).json.project;
  feature = view.releases[0].items[0];
  assert.deepEqual([feature.done, feature.parts.every(x => x.done), Object.values(feature.stages).every(c => c.status === "done"), view.releases[0].ready], [true, true, true, true]);
  assert.equal((await api("PATCH", L, { token: ro, body: { shipped: true } })).status, 403);
  view = (await api("PATCH", L, { token: dev, body: { shipped: true } })).json.project;
  assert.deepEqual([!!view.releases[0].shipped.at, view.releases[0].shipped.byName], [true, "Dev Doer"]);
  // Unticking a part closes the box again for the next one; unshipping is always allowed.
  view = (await api("PATCH", part(feature.parts[1].id), { token: dev, body: { done: false } })).json.project;
  assert.deepEqual([view.releases[0].items[0].done, view.releases[0].ready], [false, false]);
  assert.equal((await api("PATCH", L, { token: dev, body: { shipped: false } })).json.project.releases[0].shipped, null);
  assert.equal((await api("PATCH", L, { token: dev, body: { shipped: true } })).status, 409);
  // Let this test's agent turn finish so it doesn't land in the next test's window.
  for (let last = -1, n = owner.calls.length + member.calls.length; n !== last; await new Promise(r => setTimeout(r, 400))) { last = n; n = owner.calls.length + member.calls.length; }
});

test("old builds: /v1/folders is projects under another name", async () => {
  const token = await pair("member", "Old Phone");
  const mate = await pair("member", "Old Mate");
  const mateId = (await api("GET", "/v1/people", { token: mate })).json.me;
  const made = await api("POST", "/v1/folders", { token, body: { name: "Legacy", notes: "From an old build" } });
  assert.equal(made.status, 200);
  const folder = made.json.folder;
  assert.deepEqual([folder.role, folder.owner.name, folder.members, folder.notes], ["owner", "Old Phone", [], "From an old build"]);
  assert.ok((await api("GET", "/v1/folders", { token })).json.folders.some(f => f.id === folder.id));
  // Adding a member the old way lets them write.
  const withMate = (await api("POST", `/v1/folders/${folder.id}/members`, { token, body: { userId: mateId } })).json.folder;
  assert.deepEqual(withMate.members, [{ id: mateId, name: "Old Mate" }]);
  assert.equal((await api("GET", `/v1/projects/${folder.id}`, { token: mate })).json.project.access, "write");
  // Chats speak both dialects.
  const chat = (await api("POST", "/v1/chats", { token, body: { folderId: folder.id } })).json.chat;
  assert.deepEqual([chat.folderId, chat.projectId], [folder.id, folder.id]);
  const shared = (await api("PATCH", `/v1/chats/${chat.id}`, { token, body: { folderShared: true } })).json.chat;
  assert.deepEqual([shared.folderShared, shared.projectShared], [true, true]);
  const detail = (await api("GET", `/v1/folders/${folder.id}`, { token: mate })).json;
  assert.deepEqual([detail.folder.role, detail.sharedChats.map(c => c.id)], ["member", [chat.id]]);
  assert.equal((await api("PATCH", `/v1/chats/${chat.id}`, { token, body: { folderId: null } })).json.chat.folderId, undefined);
  assert.equal((await api("DELETE", `/v1/folders/${folder.id}/members/me`, { token: mate })).status, 200);
  assert.equal((await api("DELETE", `/v1/folders/${folder.id}`, { token })).status, 200);
});

test("vibe coding is an option for everyone: any member can pick it and gets a preview link", async () => {
  const token = await pair("member", "Remy Regular");
  const offered = (await api("GET", "/v1/projects", { token })).json;
  assert.deepEqual([offered.vibeCoder, offered.vibe], [false, true]);
  const chat = (await api("POST", "/v1/chats", { token, body: { mode: "vibe" } })).json.chat;
  assert.equal(chat.mode, "vibe");
  assert.equal(chat.project.id, "prototypes");
  assert.match(chat.previewUrl, /^https:\/\/team\.example\.test\/p\/proto-[0-9a-f]{18}\/$/);
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "a page about refunds" } });
  const stream = await waitFor(() => [...owner.calls, ...member.calls].find((c) => c.url.endsWith("/chat/stream") && c.body.message === "a page about refunds"));
  assert.ok(stream.body.system_message.includes(`PREVIEW: ${chat.previewUrl}`));
  assert.match(stream.body.system_message, /nothing to commit, push or publish|There is nothing to commit, push or publish/, "no git or GitHub in the loop");
  // The full agent (on by default here) also copies it to GitHub Pages: the backup link sits above the preview line, which stays last for the button.
  assert.match(stream.body.system_message, /preview line stays last\), exactly: BACKUP: https:\/\/[^\s]*github\.io\/[^\s]*proto-[0-9a-f]{18}\//);
  assert.match(stream.body.system_message, /- Public information and made-up sample data only/, "the project's rules come along");
  assert.doesNotMatch(stream.body.system_message, /on their behalf/, "vibe coders build in their own folder whatever their repo access");
  // Not asking for it still gives a plain chat.
  assert.equal((await api("POST", "/v1/chats", { token, body: {} })).json.chat.mode, undefined);
});

test("vibe coders: owners mark them; their chats build a prototype and show a preview link", async () => {
  const boss = await pair("owner", "Vi Owner");
  const token = await pair("member", "Val Vibes");
  const val = (await api("GET", "/v1/people", { token })).json.me;
  // Only owners can mark people.
  assert.equal((await api("PATCH", `/v1/people/${val}`, { token, body: { vibeCoder: true } })).status, 403);
  const marked = await api("PATCH", `/v1/people/${val}`, { token: boss, body: { vibeCoder: true } });
  assert.deepEqual([marked.status, marked.json.person.vibeCoder], [200, true]);
  assert.equal((await api("GET", "/v1/people", { token: boss })).json.people.find((p) => p.id === val).vibeCoder, true);
  assert.equal((await api("GET", "/v1/projects", { token })).json.vibeCoder, true);
  // Owners lift (and restore) someone's daily agent token limit the same way; members can't.
  assert.equal((await api("PATCH", `/v1/people/${val}`, { token, body: { unlimitedTokens: true } })).status, 403);
  const lifted = await api("PATCH", `/v1/people/${val}`, { token: boss, body: { unlimitedTokens: true } });
  assert.deepEqual([lifted.status, lifted.json.person.unlimitedTokens, lifted.json.person.vibeCoder], [200, true, true], "vibe coder untouched");
  assert.equal((await api("GET", "/v1/people", { token: boss })).json.people.find((p) => p.id === val).unlimitedTokens, true);
  assert.equal((await api("PATCH", `/v1/people/${val}`, { token: boss, body: { unlimitedTokens: "yes" } })).status, 400);
  assert.equal((await api("PATCH", `/v1/people/${val}`, { token: boss, body: { unlimitedTokens: false } })).json.person.unlimitedTokens, false);
  // Owners fix a misspelled name; members can't, and names stay unique.
  assert.equal((await api("PATCH", `/v1/people/${val}`, { token, body: { name: "Val Vibez" } })).status, 403);
  assert.equal((await api("PATCH", `/v1/people/${val}`, { token: boss, body: { name: "  Val   Vibez " } })).json.person.name, "Val Vibez");
  assert.equal((await api("PATCH", `/v1/people/${val}`, { token: boss, body: { name: "Vi Owner" } })).status, 409);
  assert.equal((await api("GET", "/v1/me", { token })).json.user.name, "Val Vibez");
  // Their chats ignore a requested project and always vibe-code the prototypes repo.
  const chat = (await api("POST", "/v1/chats", { token, body: { projectId: "servant" } })).json.chat;
  assert.equal(chat.mode, "vibe");
  assert.equal(chat.project.id, "prototypes");
  assert.match(chat.previewUrl, /^https:\/\/team\.example\.test\/p\/proto-[0-9a-f]{18}\/$/);
  const before = owner.calls.length;
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "a page about refunds" } });
  const stream = owner.calls.slice(before).find((c) => c.url.endsWith("/chat/stream"));
  assert.match(stream.body.system_message, /prototyping session/);
  assert.ok(stream.body.system_message.includes(`PREVIEW: ${chat.previewUrl}`));
  // Edit mode saves through the chat: its own person only, its own pages only.
  const editDir = path.join(dataDir, "prototypes", chat.previewUrl.split("/p/")[1].replace(/\/$/, ""));
  fs.mkdirSync(editDir, { recursive: true }); fs.writeFileSync(path.join(editDir, "index.html"), "<h1>Old</h1>");
  const edited = await api("POST", `/v1/chats/${chat.id}/prototype`, { token, body: { path: new URL(chat.previewUrl).pathname, edits: [{ from: "Old", to: "New" }], styles: [] } });
  assert.deepEqual([edited.status, edited.json.path, edited.json.missed], [200, "index.html", []]);
  assert.equal(fs.readFileSync(path.join(editDir, "index.html"), "utf8"), "<h1>New</h1>");
  assert.equal((await api("POST", `/v1/chats/${chat.id}/prototype`, { token, body: { path: "/p/x/../../config.json", edits: [{ from: "a", to: "b" }] } })).status, 400);
  assert.equal((await api("POST", `/v1/chats/${chat.id}/prototype`, { token: boss, body: { path: "/", edits: [{ from: "New", to: "x" }] } })).status, 403, "others only read");
  // Deleting the chat deletes its prototype files too.
  const gone = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  const goneDir = path.join(dataDir, "prototypes", gone.previewUrl.split("/p/")[1].replace(/\/$/, ""));
  fs.mkdirSync(goneDir, { recursive: true }); fs.writeFileSync(path.join(goneDir, "index.html"), "x");
  assert.equal((await api("DELETE", `/v1/chats/${gone.id}`, { token })).status, 200);
  assert.equal(fs.existsSync(goneDir), false);
  // Unmarking stops new vibe chats; the old one keeps its mode.
  await api("PATCH", `/v1/people/${val}`, { token: boss, body: { vibeCoder: false } });
  assert.equal((await api("POST", "/v1/chats", { token, body: {} })).json.chat.mode, undefined);
  assert.equal((await api("GET", `/v1/chats/${chat.id}`, { token })).json.chat.mode, "vibe");
});

test("full access (default): @agent in a channel answers with the full agent", async () => {
  const gil = await pair("member", "Gil");
  const general = (await api("GET", "/v1/conversations", { token: gil })).json.conversations.find((c) => c.name === "general");
  const ownerCalls = owner.calls.length;
  const memberCalls = member.calls.length;
  const ask = await api("POST", `/v1/conversations/${general.id}/messages`, { token: gil, body: { text: "@agent check the source" } });
  assert.ok(ask.status < 300, ask.text);
  await waitFor(() => owner.calls.slice(ownerCalls).some((c) => /chat\/stream/.test(c.path || c.url || "")));
  assert.equal(member.calls.length, memberCalls, "never touched the limited agent");
});

test("a channel thread started on the limited agent keeps working after switching to full access", async () => {
  const hal = await pair("member", "Hal");
  const general = (await api("GET", "/v1/conversations", { token: hal })).json.conversations.find((c) => c.name === "general");
  const agentReplies = async (rootId) => {
    const t = (await api("GET", `/v1/conversations/${general.id}/threads/${rootId}`, { token: hal })).json;
    return (t?.messages || t?.replies || []).filter((m) => m.user?.id === "agent" && !m.pending && m.text);
  };
  const poll = async (check, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      const v = await check();
      if (v) return v;
    }
    throw new Error("timed out");
  };
  let rootId;
  await withAgentAccess("limited", async () => {
    const ask = await api("POST", `/v1/conversations/${general.id}/messages`, { token: hal, body: { text: "@agent first question" } });
    rootId = ask.json.message.id;
    const first = await poll(async () => (await agentReplies(rootId))[0]);
    assert.match(first.text, /^member-agent heard:/);
  });
  // Full access now: this thread's session only exists on the member agent.
  await api("POST", `/v1/conversations/${general.id}/messages`, { token: hal, body: { text: "@agent try again", threadRoot: rootId } });
  const last = await poll(async () => (await agentReplies(rootId)).find((m) => /owner-agent heard|hit a problem/.test(m.text)));
  assert.doesNotMatch(last.text, /hit a problem/);
  // It got the whole thread, including the earlier question.
  assert.match(last.text, /first question/);
  assert.match(last.text, /try again/);
});

test("#general notes when someone leaves Servant (last device signed out or removed)", async () => {
  const owner = await pair("owner", "Owner Ivy");
  const generalOf = async (token) => (await api("GET", "/v1/conversations", { token })).json.conversations.find((c) => c.name === "general");
  const general = await generalOf(owner);
  const notes = async () => ((await api("GET", `/v1/conversations/${general.id}/messages`, { token: owner })).json.messages || [])
    .filter((m) => m.activity && /left Servant$/.test(m.text)).map((m) => m.text);

  // Signing out of the only device = left.
  const jo = await pair("member", "Jo Leaves");
  await api("POST", "/v1/signout", { token: jo });
  assert.ok((await notes()).includes("Jo Leaves left Servant"));

  // Owner removing someone's only device = left, once.
  const kim = await pair("member", "Kim Removed");
  const kimDevice = (await api("GET", "/v1/devices", { token: owner })).json.devices.find((d) => d.user?.name === "Kim Removed");
  assert.equal((await api("DELETE", `/v1/devices/${kimDevice.id}`, { token: owner })).status, 200);
  await api("DELETE", `/v1/devices/${kimDevice.id}`, { token: owner });
  assert.equal((await notes()).filter((t) => t === "Kim Removed left Servant").length, 1);
  void kim;
});

test("limited mode: member chat streams from the member agent and hides tool details", async () => {
  await withAgentAccess("limited", async () => {
  const ownerStreamsBefore = owner.calls.filter((c) => c.url.endsWith("/chat/stream")).length;
  const token = await pair("member", "Ben");
  const created = await api("POST", "/v1/chats", { token, body: {} });
  assert.equal(created.status, 201);
  const chatId = created.json.chat.id;

  const sent = await api("POST", `/v1/chats/${chatId}/messages`, { token, body: { text: "hello there" } });
  assert.equal(sent.status, 200);
  const events = parseSse(sent.text);
  const deltas = events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
  assert.equal(deltas, "member-agent heard: hello there");
  // Members see progress, never which tool ran.
  assert.deepEqual(events.filter((e) => e.event === "status").map((e) => e.data.text), ["Thinking", "Working on it", "Writing"]);
  assert.equal(events.at(-1).event, "done");
  assert.ok(!sent.text.includes("id_rsa"), "tool args must never reach a member");

  // Went to the member upstream, scoped to this person's memory.
  const streamCall = member.calls.findLast((c) => c.url.endsWith("/chat/stream"));
  assert.equal(streamCall.headers["x-hermes-session-key"].startsWith("servant:usr_"), true);
  assert.equal(owner.calls.filter((c) => c.url.endsWith("/chat/stream")).length, ownerStreamsBefore);

  const history = await api("GET", `/v1/chats/${chatId}/messages`, { token });
  assert.deepEqual(history.json.messages.map((m) => m.role), ["user", "assistant"]);
  assert.ok(!history.text.includes("secret tool output"));

  const list = await api("GET", "/v1/chats", { token });
  assert.equal(list.json.chats[0].title, "hello there");
  });
});

test("agent list times come from the latest turn, so a reply still streaming stays on top", async () => {
  const token = await pair("member", "Lia");
  const older = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  await api("POST", `/v1/chats/${older.id}/messages`, { token, body: { text: "first question" } });
  const newer = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  await api("POST", `/v1/chats/${newer.id}/messages`, { token, body: { text: "second question" } });
  // The older chat's reply keeps streaming after the newer chat was touched.
  const later = Date.now() + 60_000;
  const db = new DatabaseSync(path.join(dataDir, "agent-turns.db"));
  db.prepare("UPDATE private_turns SET updated_at=? WHERE chat_id=?").run(later, older.id);
  db.close();
  const list = (await api("GET", "/v1/chats?scope=org", { token })).json.chats;
  assert.deepEqual(list.slice(0, 2).map(c => c.id), [older.id, newer.id]);
  assert.equal(list[0].updatedAt, later);
});

test("agent list time is never earlier than the chat's newest message", async () => {
  const token = await pair("member", "Rowena");
  const chat = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "first question" } });
  // A message steered into a running reply reaches the history without
  // moving the turn or the chat record.
  const later = Date.now() + 120_000;
  const db = new DatabaseSync(path.join(dataDir, "chat-media.db"));
  db.prepare("INSERT INTO chat_messages(id,chat_id,role,text,at,signature) VALUES(?,?,?,?,?,?)")
    .run(`msg_rowtime_${chat.id}`, chat.id, "user", "one more thing", later, "test");
  db.close();
  const row = (await api("GET", "/v1/chats?scope=org", { token })).json.chats.find(c => c.id === chat.id);
  assert.equal(row.updatedAt, later);
});

test("a finished reply says how long the agent worked; its steps are fetched one turn at a time, by its author only", async () => {
  const token = await pair("member", "Nell");
  const other = await pair("member", "Odo");
  const ask = async text => {
    const chat = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
    await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text } });
    return { chat, turn: (await api("GET", `/v1/chats/${chat.id}/turns`, { token })).json.turns[0] };
  };
  const { chat, turn } = await ask("tidy the notes");
  // The list every device polls: when it started and finished, how many steps, and which message is the reply.
  assert.equal(turn.status, "completed");
  assert.deepEqual(turn.steps, []);
  assert.equal(turn.stepCount, 2, "it ran something, then wrote");
  assert.ok(turn.finishedAt >= turn.startedAt);
  assert.equal(turn.canSteer, false, "a finished reply takes nothing");
  const history = (await api("GET", `/v1/chats/${chat.id}/messages`, { token })).json.messages;
  assert.equal(history.find(m => m.role === "assistant").id, turn.messageId);
  // Opening the summary asks for that one turn.
  const detail = await api("GET", `/v1/chats/${chat.id}/turns/${turn.id}`, { token });
  assert.equal(detail.status, 200, detail.text);
  assert.deepEqual(detail.json.turn.steps.map(s => s.label), ["Running a command", "Writing"]);
  assert.ok(!detail.text.includes("id_rsa"), "what the tool was given stays on the Mac");
  assert.equal((await api("GET", `/v1/chats/${chat.id}/turns/turn_missing`, { token })).status, 404);
  // Nobody else can ask, shared or not.
  assert.equal((await api("GET", `/v1/chats/${chat.id}/turns/${turn.id}`, { token: other })).status, 404);
  await api("PATCH", `/v1/chats/${chat.id}`, { token, body: { shared: true } });
  assert.equal((await api("GET", `/v1/chats/${chat.id}/turns/${turn.id}`, { token: other })).status, 403);
  // On the restricted member agent the steps never say which tool ran.
  await withAgentAccess("limited", async () => {
    const limited = await ask("tidy them again");
    const steps = (await api("GET", `/v1/chats/${limited.chat.id}/turns/${limited.turn.id}`, { token })).json.turn.steps;
    assert.deepEqual(steps.map(s => [s.label, s.detail]), [["Working on it", undefined], ["Writing", undefined]]);
  });
});

test("a new agent chat stays out of every list until something is sent in it", async () => {
  const token = await pair("member", "Fay");
  const other = await pair("owner", "Gus");
  const chat = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  const inMine = async () => (await api("GET", "/v1/chats?scope=org", { token })).json.chats.some(c => c.id === chat.id);
  const inOrg = async () => (await api("GET", "/v1/chats?scope=org", { token: other })).json.orgChats.some(c => c.id === chat.id);
  assert.equal(await inMine(), false, "empty chat hidden from its author");
  assert.equal(await inOrg(), false, "empty chat hidden from the org");
  assert.equal((await api("GET", `/v1/chats/${chat.id}`, { token })).status, 200, "still opens directly");
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "hello" } });
  assert.equal(await inMine(), true);
  assert.equal(await inOrg(), true);
});

test("a chat the author chooses to share: others read, only the author writes", async () => {
  const a = await pair("member", "Cy");
  const b = await pair("member", "Di");
  const chat = (await api("POST", "/v1/chats", { token: a, body: {} })).json.chat;
  assert.equal(chat.shared, false, "private to start");
  const sent = await api("POST", `/v1/chats/${chat.id}/messages`, { token: a, body: { text: "draft a memo" } });
  assert.equal(sent.status, 200);
  // Nobody else can see it yet, not even in the org list.
  assert.equal((await api("GET", `/v1/chats/${chat.id}/messages`, { token: b })).status, 404);
  assert.ok(!(await api("GET", "/v1/chats?scope=org", { token: b })).json.orgChats.some(c => c.id === chat.id));
  // The author shares it afterwards.
  const on = await api("PATCH", `/v1/chats/${chat.id}`, { token: a, body: { shared: true } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.chat.shared, true);

  // Not mixed into someone else's own list; listed under the org scope with the author.
  assert.equal((await api("GET", "/v1/chats", { token: b })).json.chats.length, 0);
  const org = (await api("GET", "/v1/chats?scope=org", { token: b })).json.orgChats;
  const listed = org.find(c => c.id === chat.id);
  assert.ok(listed, "shared chat listed for the org");
  assert.equal(listed.author.name, "Cy");
  assert.equal(listed.readOnly, true);

  const read = await api("GET", `/v1/chats/${chat.id}/messages`, { token: b });
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(read.json.messages.map(m => m.role), ["user", "assistant"]);
  assert.equal(read.json.messages[0].text, "draft a memo");
  assert.equal(read.json.chat.author.name, "Cy");

  // Read only for everyone else.
  assert.equal((await api("POST", `/v1/chats/${chat.id}/messages`, { token: b, body: { text: "hi" } })).status, 403);
  assert.equal((await api("PATCH", `/v1/chats/${chat.id}`, { token: b, body: { shared: false } })).status, 403);
  assert.equal((await api("DELETE", `/v1/chats/${chat.id}`, { token: b })).status, 403);
  assert.equal((await api("GET", `/v1/chats/${chat.id}/turns`, { token: b })).status, 403);
});

test("people can't see chats the author made private", async () => {
  const a = await pair("member", "Ed");
  const b = await pair("member", "Flo");
  const chat = (await api("POST", "/v1/chats", { token: a, body: {} })).json.chat;
  await api("POST", `/v1/chats/${chat.id}/messages`, { token: a, body: { text: "start" } });
  const off = await api("PATCH", `/v1/chats/${chat.id}`, { token: a, body: { shared: false } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.chat.shared, false);
  assert.equal((await api("GET", `/v1/chats/${chat.id}/messages`, { token: b })).status, 404);
  assert.equal((await api("POST", `/v1/chats/${chat.id}/messages`, { token: b, body: { text: "hi" } })).status, 404);
  assert.ok(!(await api("GET", "/v1/chats?scope=org", { token: b })).json.orgChats.some(c => c.id === chat.id));
  // The author's own list shows the setting, and it can be turned back on.
  assert.equal((await api("GET", "/v1/chats", { token: a })).json.chats.find(c => c.id === chat.id).shared, false);
  assert.equal((await api("PATCH", `/v1/chats/${chat.id}`, { token: a, body: { shared: "yes" } })).status, 400);
  assert.equal((await api("PATCH", `/v1/chats/${chat.id}`, { token: a, body: { shared: true } })).json.chat.shared, true);
  assert.equal((await api("GET", `/v1/chats/${chat.id}/messages`, { token: b })).status, 200);
  // A chat can also start private.
  const quiet = (await api("POST", "/v1/chats", { token: a, body: { shared: false } })).json.chat;
  assert.equal(quiet.shared, false);
  assert.equal((await api("GET", `/v1/chats/${quiet.id}/messages`, { token: b })).status, 404);
});

test("chats from before sharing existed stay private", async () => {
  const a = await pair("member", "Hal");
  const b = await pair("member", "Ivy");
  const chat = (await api("POST", "/v1/chats", { token: a, body: {} })).json.chat;
  await api("POST", `/v1/chats/${chat.id}/messages`, { token: a, body: { text: "start" } });
  // Simulate a chat saved by an older release: no "shared" field at all.
  mod.mutateStateForTest(state => { delete state.chats[chat.id].shared; });
  assert.equal((await api("GET", `/v1/chats/${chat.id}/messages`, { token: b })).status, 404);
  assert.equal((await api("GET", "/v1/chats", { token: a })).json.chats.find(c => c.id === chat.id).shared, false);
});

test("the owner (admin) can always read every chat, private ones too, but not write", async () => {
  const a = await pair("member", "Gus");
  const admin = await pair("owner", "Admin");
  const chat = (await api("POST", "/v1/chats", { token: a, body: { shared: false } })).json.chat;
  await api("POST", `/v1/chats/${chat.id}/messages`, { token: a, body: { text: "private question" } });
  const org = (await api("GET", "/v1/chats?scope=org", { token: admin })).json.orgChats;
  const listed = org.find(c => c.id === chat.id);
  assert.ok(listed, "admin sees private chats");
  assert.equal(listed.shared, false);
  const read = await api("GET", `/v1/chats/${chat.id}/messages`, { token: admin });
  assert.equal(read.status, 200);
  assert.equal(read.json.messages[0].text, "private question");
  assert.equal((await api("POST", `/v1/chats/${chat.id}/messages`, { token: admin, body: { text: "hi" } })).status, 403);
  assert.equal((await api("PATCH", `/v1/chats/${chat.id}`, { token: admin, body: { shared: true } })).status, 403);
});

test("leaderboard counts agent tokens in total and by person, across chats and channels", async () => {
  const before = (await api("GET", "/v1/leaderboard?period=all", { token: await pair("member", "Board viewer") })).json;
  const zed = await pair("member", "Zed Tokens");
  const yan = await pair("member", "Yan Tokens");
  // Zed: two private-chat turns. Yan: one private turn and one channel mention.
  const zchat = (await api("POST", "/v1/chats", { token: zed, body: {} })).json.chat;
  await api("POST", `/v1/chats/${zchat.id}/messages`, { token: zed, body: { text: "first question" } });
  await api("POST", `/v1/chats/${zchat.id}/messages`, { token: zed, body: { text: "a much longer second question for the agent" } });
  const ychat = (await api("POST", "/v1/chats", { token: yan, body: {} })).json.chat;
  await api("POST", `/v1/chats/${ychat.id}/messages`, { token: yan, body: { text: "hi" } });
  const general = (await api("GET", "/v1/conversations", { token: yan })).json.conversations.find(c => c.name === "general");
  await api("POST", `/v1/conversations/${general.id}/messages`, { token: yan, body: { text: "@agent summarize the week" } });
  let board;
  for (let i = 0; i < 100; i++) {
    board = (await api("GET", "/v1/leaderboard?period=all", { token: yan })).json;
    if (board.people.find(p => p.user.name === "Yan Tokens")?.channel > 0) break;
    await new Promise(r => setTimeout(r, 30));
  }
  const z = board.people.find(p => p.user.name === "Zed Tokens");
  const y = board.people.find(p => p.user.name === "Yan Tokens");
  assert.equal(z.turns, 2);
  assert.equal(z.channel, 0);
  assert.equal(z.total, z.input + z.output);
  assert.ok(z.total > y.chat, "longer prompts, more tokens");
  assert.equal(y.turns, 2);
  assert.ok(y.chat > 0 && y.channel > 0, "chat and channel both counted");
  assert.equal(y.total, y.chat + y.channel);
  // Sorted by total, ranked, and the org total adds up.
  assert.deepEqual(board.people.map(p => p.rank), board.people.map((_, i) => i + 1));
  assert.ok(board.people.every((p, i, all) => i === 0 || all[i - 1].total >= p.total));
  assert.equal(board.totals.total - before.totals.total, z.total + y.total);
  assert.equal(board.totals.turns - before.totals.turns, 4);
  // Periods: default is the last week; unknown values fall back to it.
  assert.equal((await api("GET", "/v1/leaderboard", { token: yan })).json.period, "week");
  assert.equal((await api("GET", "/v1/leaderboard?period=bogus", { token: yan })).json.period, "week");
  assert.equal((await api("GET", "/v1/leaderboard?period=day", { token: yan })).json.people.find(p => p.user.name === "Zed Tokens").total, z.total);
  // Needs a paired device; never includes prompt text.
  assert.equal((await api("GET", "/v1/leaderboard")).status, 401);
  assert.ok(!JSON.stringify(board).includes("first question"));
});

test("the team link won't make a second person with a name that's already here (#41)", async () => {
  const code = (await mod.joinLink({ fresh: true })).code;
  const first = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code, name: "Joshua Twice" } });
  assert.equal(first.status, 201, first.text);
  const again = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code, name: "  joshua twice " } });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.error.code, "name_taken");
  assert.match(again.json.error.message, /Link a computer/);
  const spaced = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code, name: "Joshua   Twice" } });
  assert.equal(spaced.status, 409, "extra spaces inside the name don't make a different person");
  const other = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code, name: "Joshua Once" } });
  assert.equal(other.status, 201, other.text);
});

test("a second-device invite pairs as the same person", async () => {
  const first = await pair("member", "Two Devices");
  const me = (await api("GET", "/v1/me", { token: first })).json;
  const code = mod.createInvite({ userId: me.user.id });
  const r = await api("POST", "/v1/pair", { body: { terms: ACCEPT, code, device: "iPad" } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.user.id, me.user.id);
  assert.notEqual(r.json.token, first);
  const again = (await api("GET", "/v1/me", { token: r.json.token })).json;
  assert.equal(again.user.name, "Two Devices");
});

test("owner gets the owner agent and can invite and revoke", async () => {
  const ownerToken = await pair("owner", "Pat");
  const chat = (await api("POST", "/v1/chats", { token: ownerToken, body: {} })).json.chat;
  const sent = await api("POST", `/v1/chats/${chat.id}/messages`, { token: ownerToken, body: { text: "status?" } });
  assert.match(sent.text, /owner-agent heard: status\?/);
  assert.match(sent.text, /Running a command/);

  const memberToken = await pair("member", "Eve");
  assert.equal((await api("POST", "/v1/invites", { token: memberToken, body: { name: "x" } })).status, 403);

  const inv = await api("POST", "/v1/invites", { token: ownerToken, body: {} });
  assert.equal(inv.status, 200);
  assert.match(inv.json.link, /^servant:\/\/pair\?code=/);
  assert.equal((await api("POST", "/v1/invites", { token: ownerToken, body: {} })).json.code, inv.json.code);
  assert.notEqual((await api("POST", "/v1/invites", { token: ownerToken, body: { fresh: true } })).json.code, inv.json.code);

  const devices = (await api("GET", "/v1/devices", { token: ownerToken })).json.devices;
  const eve = devices.find((d) => d.user.name === "Eve");
  assert.equal((await api("DELETE", `/v1/devices/${eve.id}`, { token: ownerToken })).status, 200);
  assert.equal((await api("GET", "/v1/me", { token: memberToken })).status, 401);
});

test("state on disk holds only token hashes", () => {
  const store = createStateStore({ directory: dataDir });
  let raw;
  try { raw = JSON.stringify(store.read()); } finally { store.close(); }
  const mode = fs.statSync(path.join(dataDir, "state.db")).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.ok(!/[A-Za-z0-9_-]{43}/.test(raw.replace(/"[0-9a-f]{64}"/g, "")), "no raw device tokens on disk");
});

// ---------- channels, direct messages, threads ----------

test("the invite page offers web continuation and optional native downloads without sign-in", async () => {
  const r = await fetch(base + "/join?code=ZFB5W-UKJ68");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const html = await r.text();
  assert.match(html, /Continue in browser/);
  assert.match(html, /servant:\/\/pair\?/);
  assert.match(html, /Copy invite link/);
  const { joinPage } = await import("./join-page.mjs");
  assert.match(joinPage({}), /Download for Mac/);
  assert.doesNotMatch(joinPage({}), /Download for iPhone|Download for Android/);
  assert.match(joinPage({ ios: "https://testflight.apple.com/join/x", android: "https://play.google.com/x" }), /Download for iPhone[\s\S]*Download for Android/);
  assert.doesNotMatch(joinPage({ ios: "javascript:alert(1)" }), /javascript:/);
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
});

test("invite entry points offer a prefilled form and web continuation without sign-in", async () => {
  for (const route of ["/", "/join", "/join/", "/welcome"]) {
    const r = await fetch(base + route + "?code=ZFB5W-UKJ68");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    const html = await r.text();
    assert.match(html, /<textarea id="invite"/);
    assert.match(html, /Continue in browser/);
    assert.match(html, /action="https:\/\/servant.com\/pair"/);
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
});

async function events(token) {
  const ctrl = new AbortController();
  const res = await testFetch(dataDir, base + "/v1/events", { method: "POST", body: "{}", headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  const got = [];
  const decoder = createLiveEventDecoder(frame => got.push(frame));
  (async () => {
    try {
      for await (const chunk of res.body) {
        decoder.push(chunk);
      }
    } catch {}
  })();
  return { got, close: () => ctrl.abort() };
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

test("profile photos: you set or remove yours, everyone on the server sees it live", async () => {
  const pia = await pair("member", "Pia Photo");
  const quinn = await pair("member", "Quinn Viewer");
  const me = async (token) => (await api("GET", "/v1/people", { token })).json;
  const piaId = (await me(pia)).me;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString("base64");
  const live = await events(quinn);
  await waitFor(() => live.got.some((e) => e.event === "ready"));
  // No photo yet: initials.
  assert.equal((await me(quinn)).people.find((p) => p.id === piaId).photo, undefined);
  assert.equal((await api("GET", `/v1/people/${piaId}/photo`, { token: quinn })).status, 404);
  // Pia sets one; Quinn gets a person.updated with the new version and can fetch it.
  const set = await api("PUT", "/v1/people/me/photo", { token: pia, body: { data: jpeg } });
  assert.equal(set.status, 200, set.text);
  const version = set.json.person.photo;
  assert.ok(version);
  const update = await waitFor(() => live.got.find((e) => e.event === "person.updated" && e.data.id === piaId));
  assert.equal(update.data.photo, version);
  assert.equal((await me(quinn)).people.find((p) => p.id === piaId).photo, version);
  const photo = await api("GET", `/v1/people/${piaId}/photo`, { token: quinn });
  assert.deepEqual([photo.status, photo.json.mime, photo.json.data, photo.json.version], [200, "image/jpeg", jpeg, version]);
  // A new photo gets a new version, so cached copies are replaced.
  const again = await api("PUT", "/v1/people/me/photo", { token: pia, body: { data: jpeg } });
  assert.notEqual(again.json.person.photo, version);
  // Only images; not too big; nobody can change someone else's.
  assert.equal((await api("PUT", "/v1/people/me/photo", { token: pia, body: { data: Buffer.from("<svg/>").toString("base64") } })).status, 400);
  assert.equal((await api("PUT", "/v1/people/me/photo", { token: pia, body: { data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1100 * 1024)]).toString("base64") } })).status, 413);
  assert.equal((await api("PUT", `/v1/people/${piaId}/photo`, { token: quinn, body: { data: jpeg } })).status, 404);
  assert.equal((await api("GET", `/v1/people/${piaId}/photo`)).status, 401);
  // Names: change your own, unique, shown to everyone live.
  const renamed = await api("PATCH", "/v1/people/me", { token: pia, body: { name: "  Pia   Ray " } });
  assert.deepEqual([renamed.status, renamed.json.user.name], [200, "Pia Ray"]);
  const nameUpdate = await waitFor(() => live.got.find((e) => e.event === "person.updated" && e.data.id === piaId && e.data.name === "Pia Ray"));
  assert.ok(nameUpdate);
  assert.equal((await api("PATCH", "/v1/people/me", { token: pia, body: { name: "  " } })).status, 400);
  const quinnName = (await me(quinn)).people.find((p) => p.id !== piaId && p.name !== "Agent" && p.name !== "Pia Ray").name;
  assert.equal((await api("PATCH", "/v1/people/me", { token: pia, body: { name: quinnName.toUpperCase() } })).status, 409);
  // Removing goes back to initials for everyone.
  assert.equal((await api("DELETE", "/v1/people/me/photo", { token: pia })).json.person.photo, undefined);
  await waitFor(() => live.got.some((e) => e.event === "person.updated" && e.data.id === piaId && !e.data.photo));
  assert.equal((await api("GET", `/v1/people/${piaId}/photo`, { token: quinn })).status, 404);
  live.close();
});

test("everyone lands in #general and can make channels, DMs and threads", async () => {
  const ana = await pair("member", "Ana Ruiz");
  const ben = await pair("member", "Ben Okafor");
  const cy = await pair("member", "Cy Park");

  const list = await api("GET", "/v1/conversations", { token: ana });
  assert.equal(list.status, 200);
  assert.ok(list.json.conversations.some((c) => c.name === "general"));

  const people = (await api("GET", "/v1/people", { token: ana })).json;
  const benId = people.people.find((p) => p.name === "Ben Okafor").id;
  const cyId = people.people.find((p) => p.name === "Cy Park").id;
  assert.equal(people.agent.agent, true);

  // Public channel; name is normalised; duplicate names are refused.
  const made = await api("POST", "/v1/conversations", { token: ana, body: { name: "#Refund Backlog!", topic: "Q4 cases" } });
  assert.equal(made.status, 201, made.text);
  const ch = made.json.conversation;
  assert.equal(ch.name, "refund-backlog");
  assert.equal((await api("POST", "/v1/conversations", { token: ben, body: { name: "refund backlog" } })).status, 409);

  // Everyone starts in a new public channel. After leaving, Ben finds it in browse,
  // can read but not post until he joins again.
  await api("POST", `/v1/conversations/${ch.id}/leave`, { token: ben });
  const browse = await api("GET", "/v1/channels/browse", { token: ben });
  assert.ok(browse.json.channels.some((c) => c.id === ch.id));
  assert.equal((await api("POST", `/v1/conversations/${ch.id}/messages`, { token: ben, body: { text: "hi" } })).status, 403);
  assert.equal((await api("POST", `/v1/conversations/${ch.id}/join`, { token: ben })).status, 200);

  const benLive = await events(ben);
  await waitFor(() => benLive.got.some((e) => e.event === "ready"));

  const root = await api("POST", `/v1/conversations/${ch.id}/messages`, { token: ana, body: { text: "Who has the Kim file?" } });
  assert.equal(root.status, 201);
  const rootId = root.json.message.id;
  await waitFor(() => benLive.got.find((e) => e.event === "message.created" && e.data.id === rootId));

  // Unread for Ben, not for Ana.
  const benConv = (await api("GET", "/v1/conversations", { token: ben })).json.conversations.find((c) => c.id === ch.id);
  assert.equal(benConv.unread, 1);
  assert.equal((await api("GET", "/v1/conversations", { token: ana })).json.conversations.find((c) => c.id === ch.id).unread, 0);
  await api("POST", `/v1/conversations/${ch.id}/read`, { token: ben, body: {} });
  assert.equal((await api("GET", "/v1/conversations", { token: ben })).json.conversations.find((c) => c.id === ch.id).unread, 0);

  // Thread reply: shows on the root as a count, not in the channel list.
  const reply = await api("POST", `/v1/conversations/${ch.id}/messages`, { token: ben, body: { text: "I do", threadRoot: rootId } });
  assert.equal(reply.status, 201);
  // Replying to a reply still lands in the same thread.
  const nested = await api("POST", `/v1/conversations/${ch.id}/messages`, { token: ana, body: { text: "Thanks", threadRoot: reply.json.message.id } });
  assert.equal(nested.json.message.threadRoot, rootId);
  const page = (await api("GET", `/v1/conversations/${ch.id}/messages`, { token: ana })).json.messages;
  assert.deepEqual(page.filter(m => !m.activity).map((m) => m.text), ["Who has the Kim file?"]);
  assert.equal(page.find(m => m.id === rootId).replyCount, 2);
  const thread = (await api("GET", `/v1/conversations/${ch.id}/threads/${rootId}`, { token: cy })).json;
  assert.deepEqual(thread.replies.map((m) => [m.user.name, m.text]), [["Ben Okafor", "I do"], ["Ana Ruiz", "Thanks"]]);

  // Edit and delete: only your own.
  assert.equal((await api("PATCH", `/v1/messages/${rootId}`, { token: ben, body: { text: "x" } })).status, 403);
  assert.equal((await api("PATCH", `/v1/messages/${rootId}`, { token: ana, body: { text: "Who has the Kim case?" } })).json.message.editedAt > 0, true);
  assert.equal((await api("DELETE", `/v1/messages/${reply.json.message.id}`, { token: ana })).status, 403);
  assert.equal((await api("DELETE", `/v1/messages/${reply.json.message.id}`, { token: ben })).status, 200);

  // Private channel is invisible to people who weren't added.
  const priv = (await api("POST", "/v1/conversations", { token: ana, body: { name: "leads", private: true, memberIds: [benId] } })).json.conversation;
  assert.equal((await api("GET", `/v1/conversations/${priv.id}/messages`, { token: cy })).status, 404);
  assert.equal((await api("GET", `/v1/conversations/${priv.id}/messages`, { token: ben })).status, 200);
  assert.ok(!(await api("GET", "/v1/channels/browse", { token: cy })).json.channels.some((c) => c.id === priv.id));

  // DMs: opening the same people twice returns the same conversation; outsiders can't read it.
  const dm1 = (await api("POST", "/v1/conversations", { token: ana, body: { kind: "dm", userIds: [benId] } })).json.conversation;
  const dm2 = (await api("POST", "/v1/conversations", { token: ben, body: { kind: "dm", userIds: [people.me] } })).json.conversation;
  assert.equal(dm1.id, dm2.id);
  assert.equal(dm1.title, "Ben Okafor");
  assert.equal(dm2.title, "Ana Ruiz");
  await api("POST", `/v1/conversations/${dm1.id}/messages`, { token: ana, body: { text: "private note" } });
  assert.equal((await api("GET", `/v1/conversations/${dm1.id}/messages`, { token: cy })).status, 404);
  const group = (await api("POST", "/v1/conversations", { token: ana, body: { kind: "dm", userIds: [benId, cyId] } })).json.conversation;
  assert.notEqual(group.id, dm1.id);
  assert.equal(group.memberCount, 3);

  benLive.close();
});

test("typing is relayed live to the others, not the typist, and throttled", async () => {
  const eve = await pair("member", "Eve Typist");
  const fay = await pair("member", "Fay Reader");
  const general = (await api("GET", "/v1/conversations", { token: eve })).json.conversations.find((c) => c.name === "general");
  const fayLive = await events(fay);
  const eveLive = await events(eve);
  await waitFor(() => fayLive.got.some((e) => e.event === "ready") && eveLive.got.some((e) => e.event === "ready"));

  assert.equal((await api("POST", `/v1/conversations/${general.id}/typing`, { token: eve, body: {} })).status, 200);
  const seen = await waitFor(() => fayLive.got.find((e) => e.event === "typing"));
  assert.equal(seen.data.conversationId, general.id);
  assert.equal(seen.data.user.name, "Eve Typist");
  assert.equal(seen.data.threadRoot, null);

  // A second ping right away is accepted but not relayed again; the typist never hears themself.
  await api("POST", `/v1/conversations/${general.id}/typing`, { token: eve, body: { threadRoot: "5" } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(fayLive.got.filter((e) => e.event === "typing").length, 1);
  assert.equal(eveLive.got.some((e) => e.event === "typing"), false);

  // Nothing is stored: the conversation has no new message.
  const before = (await api("GET", `/v1/conversations/${general.id}/messages`, { token: fay })).json.messages.length;
  assert.equal((await api("GET", `/v1/conversations/${general.id}/messages`, { token: fay })).json.messages.length, before);
  fayLive.close();
  eveLive.close();
});

test("limited mode: @agent in a channel replies in a thread, as the member agent, with live updates", async () => {
  await withAgentAccess("limited", async () => {
  const ana = await pair("owner", "Owner Ana");
  const dee = await pair("member", "Dee");
  const general = (await api("GET", "/v1/conversations", { token: dee })).json.conversations.find((c) => c.name === "general");
  const live = await events(ana);
  await waitFor(() => live.got.some((e) => e.event === "ready"));

  const ownerCalls = owner.calls.length;
  await api("POST", `/v1/conversations/${general.id}/messages`, { token: dee, body: { text: "Morning all" } });
  const ask = await api("POST", `/v1/conversations/${general.id}/messages`, { token: dee, body: { text: "@agent what's the filing deadline?" } });
  const rootId = ask.json.message.id;

  const done = await waitFor(() =>
    live.got.find((e) => e.event === "message.updated" && e.data.user.agent && !e.data.pending && e.data.text),
  );
  assert.equal(done.data.threadRoot, rootId);
  assert.match(done.data.text, /^member-agent heard:/);
  // The agent saw who said what, including the earlier message it missed.
  assert.match(done.data.text, /Dee: Morning all/);
  assert.match(done.data.text, /Dee: @agent what's the filing deadline\?/);
  // Even with the owner in the channel, the owner's agent is never used.
  assert.equal(owner.calls.length, ownerCalls);
  // Tool details never reach the channel.
  assert.ok(!JSON.stringify(live.got).includes("id_rsa"));

  const thread = (await api("GET", `/v1/conversations/${general.id}/threads/${rootId}`, { token: ana })).json;
  assert.equal(thread.replies.length, 1);
  assert.equal(thread.replies[0].user.agent, true);

  // A follow-up in the thread reuses the same agent session.
  const sessionsBefore = member.calls.filter((c) => c.url === "/api/sessions").length;
  await api("POST", `/v1/conversations/${general.id}/messages`, { token: ana, body: { text: "@agent and for extensions?", threadRoot: rootId } });
  await waitFor(() => {
    const t = live.got.filter((e) => e.event === "message.updated" && e.data.user.agent && !e.data.pending && e.data.threadRoot === rootId);
    return t.length >= 2 && t.at(-1).data.text.includes("extensions");
  });
  assert.equal(member.calls.filter((c) => c.url === "/api/sessions").length, sessionsBefore);
  live.close();
  });
});

test("channel archive is personal, persistent, reversible, and still receives messages", async () => {
  const a = await pair("member", "Archive A");
  const b = await pair("member", "Archive B");
  const outsider = await pair("member", "Archive outsider");
  const ch = (await api("POST", "/v1/conversations", { token: a, body: { name: "archive-personal" } })).json.conversation;
  const route = `/v1/conversations/${ch.id}`;
  await api("POST", route + "/leave", { token: outsider }); // everyone starts in; this person left
  await api("POST", route + "/join", { token: b });
  assert.equal((await api("POST", route + "/archive", { token: outsider })).status, 403);
  const liveA = await events(a);
  const liveB = await events(b);
  try {
    await waitFor(() => liveA.got.some(e => e.event === "ready") && liveB.got.some(e => e.event === "ready"));
    assert.equal((await api("POST", route + "/archive", { token: a })).status, 200);
    await waitFor(() => liveA.got.some(e => e.event === "conversation.updated" && e.data.id === ch.id));
    assert.equal(liveB.got.filter(e => e.event === "conversation.updated" && e.data.id === ch.id).length, 0);
    assert.ok(!(await api("GET", "/v1/conversations", { token: a })).json.conversations.some(c => c.id === ch.id));
    assert.ok((await api("GET", "/v1/conversations", { token: b })).json.conversations.some(c => c.id === ch.id));
    const archived = (await api("GET", "/v1/conversations?includeArchived=1", { token: a })).json.conversations.find(c => c.id === ch.id);
    assert.equal(archived.archived, true);
    assert.equal((await api("GET", route, { token: b })).json.conversation.archived, false);
    assert.equal((await api("POST", route + "/messages", { token: b, body: { text: "Still here" } })).status, 201);
    assert.equal((await api("GET", route + "/messages", { token: a })).json.messages.find(m => !m.activity).text, "Still here");
    assert.equal((await api("GET", route, { token: a })).json.conversation.archived, true);
    assert.equal((await api("POST", route + "/restore", { token: a })).status, 200);
    assert.ok((await api("GET", "/v1/conversations", { token: a })).json.conversations.some(c => c.id === ch.id));
    const general = (await api("GET", "/v1/conversations", { token: a })).json.conversations.find(c => c.name === "general");
    assert.equal((await api("POST", `/v1/conversations/${general.id}/archive`, { token: a })).status, 200);
    assert.equal((await api("POST", `/v1/conversations/${general.id}/restore`, { token: a })).status, 200);
  } finally { liveA.close(); liveB.close(); }
});

test("channel order is personal, follows the person, and skips channels they aren't in", async () => {
  const a = await pair("member", "Order A");
  const b = await pair("member", "Order B");
  const one = (await api("POST", "/v1/conversations", { token: a, body: { name: "order-one" } })).json.conversation;
  const two = (await api("POST", "/v1/conversations", { token: a, body: { name: "order-two" } })).json.conversation;
  const theirs = (await api("POST", "/v1/conversations", { token: b, body: { name: "order-theirs", private: true } })).json.conversation;
  await api("POST", `/v1/conversations/${two.id}/join`, { token: b });
  const position = async (token, id) => (await api("GET", "/v1/conversations", { token })).json.conversations.find(c => c.id === id)?.position;
  assert.equal(await position(a, one.id), null, "no place until they sort by hand");
  assert.equal((await api("POST", "/v1/conversations/order", { token: a, body: { ids: "nope" } })).status, 400);
  const live = await events(a);
  try {
    await waitFor(() => live.got.some(e => e.event === "ready"));
    const saved = await api("POST", "/v1/conversations/order", { token: a, body: { ids: [two.id, theirs.id, one.id, two.id] } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.ids, [two.id, one.id], "drops repeats and channels they aren't in");
    await waitFor(() => live.got.some(e => e.event === "conversation.updated"));
  } finally { live.close(); }
  assert.equal(await position(a, two.id), 0);
  assert.equal(await position(a, one.id), 1);
  assert.equal(await position(b, two.id), null, "someone else's order never changes yours");
  assert.equal(await position(b, theirs.id), null);
});

test("channel deletion enforces permissions, protects general, and removes threads for all members", async () => {
  const creator = await pair("member", "Delete creator");
  const other = await pair("member", "Delete member");
  const ownerToken = await pair("owner", "Delete owner");
  const ch = (await api("POST", "/v1/conversations", { token: creator, body: { name: "delete-test" } })).json.conversation;
  const route = `/v1/conversations/${ch.id}`;
  await api("POST", route + "/join", { token: other });
  const root = (await api("POST", route + "/messages", { token: creator, body: { text: "Root" } })).json.message;
  await api("POST", route + "/messages", { token: other, body: { text: "Reply", threadRoot: root.id } });
  assert.equal((await api("DELETE", route, { token: other })).status, 403);
  await api("POST", route + "/archive", { token: creator });
  const live = await events(other);
  try {
    await waitFor(() => live.got.some(e => e.event === "ready"));
    assert.equal((await api("DELETE", route, { token: creator })).status, 200);
    await waitFor(() => live.got.some(e => e.event === "conversation.updated" && e.data.id === ch.id));
    assert.equal((await api("GET", route, { token: other })).status, 404);
    assert.equal((await api("GET", route + `/threads/${root.id}`, { token: other })).status, 404);
    assert.equal((await api("PATCH", `/v1/messages/${root.id}`, { token: creator, body: { text: "No" } })).status, 404);
    assert.ok(!(await api("GET", "/v1/conversations?includeArchived=1", { token: other })).json.conversations.some(c => c.id === ch.id));
  } finally { live.close(); }
  // Name can be reused after deletion; the server owner can delete a member-created channel.
  const again = await api("POST", "/v1/conversations", { token: creator, body: { name: "delete-test" } });
  assert.equal(again.status, 201);
  assert.equal((await api("DELETE", `/v1/conversations/${again.json.conversation.id}`, { token: ownerToken })).status, 200);
  const general = (await api("GET", "/v1/conversations", { token: ownerToken })).json.conversations.find(c => c.name === "general");
  assert.equal((await api("DELETE", `/v1/conversations/${general.id}`, { token: ownerToken })).status, 400);
  assert.equal((await api("PATCH", `/v1/conversations/${general.id}`, { token: ownerToken, body: { name: "renamed-general" } })).status, 400);
  const otherId = (await api("GET", "/v1/me", { token: other })).json.user.id;
  const dm = (await api("POST", "/v1/conversations", { token: creator, body: { kind: "dm", userIds: [otherId] } })).json.conversation;
  assert.equal((await api("DELETE", `/v1/conversations/${dm.id}`, { token: ownerToken })).status, 404, "people outside a direct conversation can't delete it");
});

test("direct conversations swipe to archive, come back on a new message, and delete for everyone in them", async () => {
  const a = await pair("member", "DM swipe A");
  const b = await pair("member", "DM swipe B");
  const outsider = await pair("member", "DM swipe outsider");
  const bid = (await api("GET", "/v1/me", { token: b })).json.user.id;
  const dm = (await api("POST", "/v1/conversations", { token: a, body: { kind: "dm", userIds: [bid] } })).json.conversation;
  const route = `/v1/conversations/${dm.id}`;
  const listed = async (t, all = false) => (await api("GET", `/v1/conversations${all ? "?includeArchived=1" : ""}`, { token: t })).json.conversations.find(c => c.id === dm.id);
  assert.equal((await api("POST", route + "/archive", { token: outsider })).status, 404);
  // Archive is personal and reversible.
  assert.equal((await api("POST", route + "/archive", { token: a })).status, 200);
  assert.equal(await listed(a), undefined);
  assert.equal((await listed(a, true)).archived, true);
  assert.equal((await listed(b)).archived, false);
  assert.equal((await api("POST", route + "/restore", { token: a })).status, 200);
  assert.equal((await listed(a)).archived, false);
  // A new message brings it back; so does opening it again from New message.
  await api("POST", route + "/archive", { token: a });
  assert.equal((await api("POST", route + "/messages", { token: b, body: { text: "Are you there?" } })).status, 201);
  assert.equal((await listed(a)).archived, false);
  await api("POST", route + "/archive", { token: a });
  await api("POST", route + "/archive", { token: b });
  assert.equal((await api("POST", "/v1/conversations", { token: a, body: { kind: "dm", userIds: [bid] } })).json.conversation.archived, false);
  assert.equal((await listed(b, true)).archived, true, "reopening only restores it for the person who reopened it");
  // Anyone in it can delete it, for everyone in it.
  const live = await events(b);
  try {
    await waitFor(() => live.got.some(e => e.event === "ready"));
    assert.equal((await api("DELETE", route, { token: outsider })).status, 404);
    assert.equal((await api("DELETE", route, { token: a })).status, 200);
    await waitFor(() => live.got.some(e => e.event === "conversation.updated" && e.data.id === dm.id));
  } finally { live.close(); }
  assert.equal((await api("GET", route, { token: b })).status, 404);
  assert.equal(await listed(b, true), undefined);
  // Starting a new message afterwards opens a fresh, empty conversation.
  const fresh = (await api("POST", "/v1/conversations", { token: b, body: { kind: "dm", userIds: [(await api("GET", "/v1/me", { token: a })).json.user.id] } })).json.conversation;
  assert.notEqual(fresh.id, dm.id);
  assert.equal(fresh.lastMessage, null);
});

test("legacy membership migration preserves history and personal archive survives reopen", () => {
  const file = path.join(dataDir, "legacy.db");
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE members (conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL, last_read_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (conversation_id, user_id))");
  legacy.close();
  const options = { file, users: () => ({ a: { id: "a", name: "A" } }), agentName: () => "Agent", askAgent: async () => "Done" };
  let m = createMessaging(options);
  const ch = m.createChannel({ id: "a" }, { name: "persist" });
  m.post(ch, "a", "Keep this history");
  m.joinDefaults("a");
  const before = m.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE activity IS NOT NULL").get().n;
  m.joinDefaults("a");
  assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE activity IS NOT NULL").get().n, before, "startup and second-device pairing must not repeat joins");
  m.db.prepare("UPDATE members SET archived_at = 123 WHERE user_id = 'a'").run();
  m.close();
  m = createMessaging(options);
  assert.equal(m.db.prepare("SELECT archived_at FROM members WHERE user_id = 'a'").get().archived_at, 123);
  assert.equal(m.db.prepare("SELECT text FROM messages WHERE activity IS NULL").get().text, "Keep this history");
  m.close();
});

test("channel membership activity is durable, quiet, immutable and emitted once per change", async () => {
  const a = await pair("member", "Activity Creator"), b = await pair("member", "Activity Member");
  const bid = (await api("GET", "/v1/me", { token: b })).json.user.id;
  const ch = (await api("POST", "/v1/conversations", { token: a, body: { name: "activity-check" } })).json.conversation;
  const route = `/v1/conversations/${ch.id}`;
  // Everyone starts in a public channel, quietly (no note). b leaves first, then the test runs.
  await api("POST", route + "/leave", { token: b });
  const live = await events(a);
  try {
    await waitFor(() => live.got.some(e => e.event === "ready"));
    await api("POST", route + "/join", { token: b });
    await api("POST", route + "/join", { token: b });
    await api("POST", route + "/leave", { token: b });
    await api("POST", route + "/leave", { token: b });
    assert.equal((await api("POST", route + "/members", { token: a, body: { userIds: [bid, bid] } })).json.added, 1);
    assert.equal((await api("POST", route + "/members", { token: a, body: { userIds: [bid] } })).json.added, 0);
    await api("POST", route + "/archive", { token: b });
    await api("POST", route + "/restore", { token: b });
    const messages = (await api("GET", route + "/messages", { token: a })).json.messages;
    assert.deepEqual(messages.map(m => [m.activity, m.text]), [
      ["joined", "Activity Creator joined the channel"],
      ["left", "Activity Member left the channel"],
      ["joined", "Activity Member joined the channel"],
      ["left", "Activity Member left the channel"],
      ["joined", "Activity Member joined the channel"],
    ]);
    await waitFor(() => live.got.filter(e => e.event === "message.created" && e.data.activity).length === 3);
    assert.equal((await api("GET", "/v1/conversations", { token: a })).json.conversations.find(c => c.id === ch.id).unread, 0);
    const activity = messages[0].id;
    assert.equal((await api("PATCH", `/v1/messages/${activity}`, { token: a, body: { text: "forged" } })).status, 403);
    assert.equal((await api("DELETE", `/v1/messages/${activity}`, { token: a })).status, 403);
    assert.equal((await api("POST", route + "/messages", { token: a, body: { text: "reply", threadRoot: activity } })).status, 400);
  } finally { live.close(); }
});

test("notification settings and push registration are scoped to the authenticated device", async () => {
  const token = await pair("member", "Notification settings test");
  assert.equal((await api("PUT", "/v1/notifications", { body: { token: "x".repeat(30), platform: "android" } })).status, 401);
  assert.equal((await api("PUT", "/v1/notifications", { token, body: { token: "bad", platform: "ios" } })).status, 400);
  const registration = await api("PUT", "/v1/notifications", { token, body: { token: "x".repeat(30), platform: "android" } });
  assert.equal(registration.status, 200);
  assert.equal(registration.json.registered, true);
  assert.equal(registration.json.preferences.mode, "mentions");
  const prefs = await api("PATCH", "/v1/notifications", { token, body: { mode: "none", contentPreviews: false } });
  assert.equal(prefs.status, 200);assert.equal(prefs.json.preferences.contentPreviews, false);assert.equal(prefs.json.preferences.previews, false);
  assert.equal((await api("POST", "/v1/notifications/presence", { token, body: { active: true, conversation: "ch_test" } })).status, 200);
  assert.equal((await api("POST", "/v1/signout", { token })).status, 200);
  assert.equal((await api("GET", "/v1/notifications", { token })).status, 401);
  const store = createStateStore({ directory: dataDir });
  let saved;
  try { saved = store.read(); } finally { store.close(); }
  assert.equal(Object.values(saved.devices).find(d => d.id === registration.json.deviceId).push, undefined);
});

test("build notes: one #whats-new post per build, everyone notified, tap opens its thread", () => {
  const people = { o: { id: "o", name: "Owner", role: "owner" }, t: { id: "t", name: "Tester", role: "member" } };
  const m = createMessaging({ file: path.join(dataDir, "releases.db"), users: () => people, agentName: () => "Agent", askAgent: async () => "" });
  assert.equal(m.latestRelease(), null);
  assert.throws(() => m.postRelease({ build: "5", notes: " ", authorId: "o" }), /notes/);
  const first = m.postRelease({ build: "5", notes: "Keyboard no longer covers the composer", authorId: "o" });
  assert.equal(first.updated, false);
  assert.match(first.text, /^Build 5 is out\n\nKeyboard no longer covers the composer/);
  // Android and iOS scripts both post the same build: it updates, never duplicates.
  const again = m.postRelease({ build: "5", notes: "Keyboard fix. Try typing in a thread", authorId: "o" });
  assert.equal(again.updated, true);
  assert.equal(again.messageId, first.messageId);
  assert.equal(m.latestRelease().messageId, first.messageId);
  const ch = m.db.prepare("SELECT * FROM conversations WHERE name = 'whats-new'").get();
  assert.ok(m.db.prepare("SELECT 1 FROM members WHERE conversation_id = ? AND user_id = 't'").get(ch.id), "everyone is in #whats-new");
  const n = m.notificationFor(first.messageId, people.t);
  assert.equal(n.title, "Build 5 is out");
  assert.equal(n.mentioned, true, "reaches people on mentions-only");
  assert.equal(String(n.threadRoot), first.messageId, "tapping opens the discussion thread");
  const reply = m.post(ch, "t", "Works on my phone", Number(first.messageId));
  assert.equal(m.notificationFor(String(reply.seq), people.o).title, "Tester in #whats-new");
  assert.equal(m.postRelease({ build: "6", notes: "Next", authorId: "o" }).build, "6");
  // Two builds can be recorded in the same millisecond; latest must be stable.
  m.db.prepare("UPDATE releases SET created_at = ?").run(first.createdAt);
  assert.equal(m.latestRelease().build, "6");
  m.close();
});

test("release notes can only be posted from this Mac with the admin key", async () => {
  const r = await fetch(`${base}/admin/releases`, { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4", "X-Servant-Admin": "x" }, body: JSON.stringify({ build: "1", notes: "n" }) });
  assert.equal(r.status, 403);
  const r2 = await fetch(`${base}/admin/releases`, { method: "POST", headers: { "Content-Type": "application/json", "X-Servant-Admin": "" }, body: JSON.stringify({ build: "1", notes: "n" }) });
  assert.equal(r2.status, 403);
});

test("agent notices can only be posted from this Mac with the admin key", async () => {
  const r = await fetch(`${base}/admin/notify`, { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4", "X-Servant-Admin": "x" }, body: JSON.stringify({ text: "n" }) });
  assert.equal(r.status, 403);
  const r2 = await fetch(`${base}/admin/notify`, { method: "POST", headers: { "Content-Type": "application/json", "X-Servant-Admin": "" }, body: JSON.stringify({ text: "n" }) });
  assert.equal(r2.status, 403);
});

test("feedback accepts paired reports once and never leaks another user's history", async () => {
  const a = await pair("member", "Reporter");
  const b = await pair("member", "Other reporter");
  assert.equal((await api("POST", "/v1/feedback", { body: {} })).status, 401);
  const body = { requestId: "feedback-request-1", text: "The keyboard covers Send", context: { build: "14", token: "secret" } };
  const first = await api("POST", "/v1/feedback", { token: a, body });
  assert.equal(first.status, 202);
  assert.equal(first.json.report.status, "queued");
  assert.equal(first.json.report.context.token, undefined);
  assert.equal((await api("POST", "/v1/feedback", { token: a, body })).json.report.id, first.json.report.id);
  assert.equal((await api("GET", "/v1/feedback", { token: a })).json.reports.length, 1);
  assert.equal((await api("GET", "/v1/feedback", { token: b })).json.reports.length, 0);
});

test("channel discovery pages without duplicates or skipping after a join, excluding private and joined channels", async () => {
  const author = await pair("member", "Discovery author");
  const reader = await pair("member", "Discovery reader");
  const created = [];
  for (let i = 0; i < 45; i++) {
    const r = await api("POST", "/v1/conversations", { token: author, body: { name: `discovery-${String(i).padStart(2, "0")}` } });
    assert.equal(r.status, 201); created.push(r.json.conversation.id);
  }
  const privateChannel = await api("POST", "/v1/conversations", { token: author, body: { name: "discovery-private", private: true } });
  // Everyone starts in public channels; discovery lists the ones this person left.
  for (const id of created) await api("POST", `/v1/conversations/${id}/leave`, { token: reader });
  const seen = []; let cursor = null; let pages = 0;
  do {
    const r = await api("GET", `/v1/channels/browse?limit=20${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`, { token: reader });
    assert.equal(r.status, 200); assert.ok(r.json.channels.length <= 20);
    seen.push(...r.json.channels.map(c => c.id)); cursor = r.json.nextCursor; pages++;
    if (pages === 1) await api("POST", `/v1/conversations/${created[0]}/join`, { token: reader });
    assert.ok(pages < 10);
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(created.every(id => seen.includes(id)));
  assert.ok(!seen.includes(privateChannel.json.conversation.id));
  const fresh = await api("GET", "/v1/channels/browse?limit=100", { token: reader });
  assert.ok(!fresh.json.channels.some(c => c.id === created[0]));
  assert.equal((await api("GET", "/v1/channels/browse?limit=-1", { token: reader })).status, 400);
  assert.equal((await api("GET", "/v1/channels/browse?limit=20&after=invalid", { token: reader })).status, 400);
});

test("attachments round trip privately, survive edits, render metadata in threads, and disappear on deletion", async () => {
  const sender = await pair("member", "Attachment sender");
  const outsider = await pair("member", "Attachment outsider");
  const ch = (await api("POST", "/v1/conversations", { token: sender, body: { name: "attachment-private", private: true } })).json.conversation;
  const route = `/v1/conversations/${ch.id}/messages`;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
  const sent = await api("POST", route, { token: sender, body: { attachments: [{ name: "image.png", data: png }] } });
  assert.equal(sent.status, 201, sent.text);
  const post = sent.json.message;
  const file = post.attachments[0];
  assert.equal(file.mime, "image/png");
  assert.equal(file.size, Buffer.from(png, "base64").length);
  assert.equal(file.data, undefined, "history and live events contain only metadata");
  const download = `/v1/attachments/${file.id}`;
  assert.equal((await api("GET", download)).status, 401);
  assert.equal((await api("GET", download, { token: outsider })).status, 404);
  assert.equal((await api("GET", download, { token: sender })).json.data, png);
  const edited = await api("PATCH", `/v1/messages/${post.id}`, { token: sender, body: { text: "Caption" } });
  assert.deepEqual(edited.json.message.attachments, post.attachments);
  const reply = await api("POST", route, { token: sender, body: { threadRoot: post.id, attachments: [{ name: "../note.txt", data: Buffer.from("hello").toString("base64") }] } });
  assert.equal(reply.status, 201);
  assert.equal(reply.json.message.attachments[0].name, ".._note.txt");
  assert.equal(reply.json.message.attachments[0].mime, "application/octet-stream");
  const thread = await api("GET", `/v1/conversations/${ch.id}/threads/${post.id}`, { token: sender });
  assert.equal(thread.json.replies[0].attachments.length, 1);
  assert.equal((await api("POST", route, { token: sender, body: { attachments: [{ name: "bad", data: "%%%=" }] } })).status, 400);
  assert.equal((await api("POST", route, { token: sender, body: { attachments: Array(5).fill({ name: "x", data: png }) } })).status, 400);
  assert.equal((await api("POST", route, { token: sender, body: { attachments: [{ name: "big", data: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64") }] } })).status, 413);
  assert.equal((await api("POST", route, { token: sender, body: {} })).status, 400);
  await api("DELETE", `/v1/messages/${post.id}`, { token: sender });
  assert.equal((await api("GET", download, { token: sender })).status, 404);
  const history = await api("GET", route, { token: sender });
  assert.deepEqual(history.json.messages.find(m => m.id === post.id).attachments, []);
});

test("reactions persist, sync live, are idempotent and require membership", async () => {
  const a = await pair("member", "Reaction author");
  const b = await pair("member", "Reaction reader");
  const ch = (await api("POST", "/v1/conversations", { token: a, body: { name: "reaction-check" } })).json.conversation;
  const route = `/v1/conversations/${ch.id}`;
  await api("POST", route + "/leave", { token: b }); // everyone starts in; b left
  const root = (await api("POST", route + "/messages", { token: a, body: { text: "React here" } })).json.message;
  const endpoint = `/v1/messages/${root.id}/reactions`;
  const react = (token, emoji, active) => api("POST", endpoint, { token, body: { emoji, active } });
  assert.equal((await react(b, "👍", true)).status, 403);
  await api("POST", route + "/join", { token: b });
  const live = await events(b);
  try {
    await waitFor(() => live.got.some(e => e.event === "ready"));
    assert.equal((await react(a, "👍", true)).status, 200);
    assert.equal((await react(a, "👍", true)).json.message.reactions[0].userIds.length, 1);
    assert.equal((await react(b, "👍", true)).json.message.reactions[0].userIds.length, 2);
    await waitFor(() => live.got.some(e => e.event === "message.updated" && e.data.id === root.id && e.data.reactions[0]?.userIds.length === 2));
    const saved = (await api("GET", route + "/messages", { token: b })).json.messages.find(p => p.id === root.id);
    assert.equal(saved.reactions[0].userIds.length, 2);
    assert.equal((await react(a, "👍", false)).json.message.reactions[0].userIds.length, 1);
    assert.equal((await react(a, "👍", false)).json.message.reactions[0].userIds.length, 1);
    assert.equal((await react(a, "invalid", true)).status, 400);
    assert.equal((await react(a, "❤️", "yes")).status, 400);
    const reply = (await api("POST", route + "/messages", { token: b, body: { text: "Reply", threadRoot: root.id } })).json.message;
    assert.equal((await api("POST", `/v1/messages/${reply.id}/reactions`, { token: a, body: { emoji: "❤️", active: true } })).status, 200);
    const thread = (await api("GET", route + `/threads/${root.id}`, { token: a })).json;
    assert.equal(thread.replies[0].reactions[0].emoji, "❤️");
    await api("DELETE", `/v1/messages/${root.id}`, { token: a });
    assert.equal((await react(b, "👍", true)).status, 404);
    const gone = (await api("GET", route + `/threads/${root.id}`, { token: a })).json.root;
    assert.deepEqual(gone.reactions, []);
  } finally { live.close(); }
});

test("the owner removes someone who left the team: signed out everywhere, gone from the server, history kept", async () => {
  const owner = await pair("owner", "Remover Rae");
  const stay = await pair("member", "Staying Sam");
  const leaver = await pair("member", "Leaving Lee");
  const people = async token => (await api("GET", "/v1/people", { token })).json.people;
  const lee = (await people(owner)).find(p => p.name === "Leaving Lee");
  const secondInvite = mod.createInvite({ userId: lee.id });   // Lee's iPad, paired before they left
  const second = (await api("POST", "/v1/pair", { body: { terms: ACCEPT, code: secondInvite, device: "Second phone" } })).json.token;
  assert.equal((await api("GET", "/v1/chats", { token: second })).status, 200);
  const staleInvite = mod.createInvite({ userId: lee.id });   // a link nobody used yet
  const sam = (await people(owner)).find(p => p.name === "Staying Sam");
  // Lee has history: a channel post, a DM with Sam, an agent chat.
  const general = (await api("GET", "/v1/conversations", { token: leaver })).json.conversations.find(c => c.name === "general");
  assert.equal((await api("POST", `/v1/conversations/${general.id}/messages`, { token: leaver, body: { text: "Before I go" } })).status, 201);
  const dm = (await api("POST", "/v1/conversations", { token: stay, body: { kind: "dm", userIds: [lee.id] } })).json.conversation;
  assert.equal((await api("POST", "/v1/chats", { token: leaver, body: {} })).status, 201);

  // Only the owner can do it, never to the owner or themselves.
  assert.equal((await api("DELETE", `/v1/people/${lee.id}`, { token: stay })).status, 403);
  const rae = (await people(owner)).find(p => p.name === "Remover Rae");
  assert.equal((await api("DELETE", `/v1/people/${rae.id}`, { token: owner })).status, 400, "can't remove yourself");
  assert.equal((await api("DELETE", "/v1/people/usr_nobody", { token: owner })).status, 404);
  assert.equal((await api("GET", "/v1/chats", { token: leaver })).status, 200, "still signed in until removed");

  const removed = await api("DELETE", `/v1/people/${lee.id}`, { token: owner });
  assert.equal(removed.status, 200, removed.text);
  assert.equal((await api("DELETE", `/v1/people/${lee.id}`, { token: owner })).status, 200, "removing twice is harmless");

  // Every device is signed out at once.
  for (const token of [leaver, second]) {
    assert.equal((await api("GET", "/v1/chats", { token })).status, 401);
    assert.equal((await api("GET", "/v1/conversations", { token })).status, 401);
    assert.equal((await api("GET", "/v1/people", { token })).status, 401);
  }
  // Gone from the people list, from search, and from new conversations; nobody else is affected.
  assert.ok(!(await people(stay)).some(p => p.id === lee.id));
  assert.ok(!(await api("GET", "/v1/search?q=Leaving", { token: stay })).json.people.some(p => p.id === lee.id));
  assert.equal((await api("GET", "/v1/chats", { token: stay })).status, 200);
  assert.ok((await people(stay)).some(p => p.id === sam.id));
  // Their old words stay, and #general says they left.
  const history = (await api("GET", `/v1/conversations/${general.id}/messages`, { token: stay })).json.messages;
  assert.ok(history.some(m => m.text === "Before I go"), "history kept");
  assert.ok(history.some(m => m.activity === "left" && /Leaving Lee left Servant/.test(m.text)), "#general says they left");
  assert.equal((await api("GET", `/v1/conversations/${dm.id}`, { token: stay })).status, 200, "Sam keeps the DM history");
  // A link made for them before they left can't bring them back, and a project can't take them.
  assert.equal((await api("POST", "/v1/pair", { body: { terms: ACCEPT, code: staleInvite, device: "New phone" } })).status, 403);
  const project = (await api("POST", "/v1/projects", { token: owner, body: { name: "Team" } })).json.project;
  assert.equal((await api("POST", `/v1/projects/${project.id}/people`, { token: owner, body: { userId: lee.id, level: "read" } })).status, 404, "can't add a removed person to a project");
});

test("agent tiers: new people have no agent; 1 tester, 2 business owner, 3 software engineer", async () => {
  const cfgFile = path.join(dataDir, "config.json");
  const before = fs.readFileSync(cfgFile, "utf8");
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(before), defaultAgentTier: 0 }));
  try {
    const boss = await pair("owner", "Tier Owner");
    const token = await pair("member", "Tess Tier");
    const me = (await api("GET", "/v1/people", { token: boss })).json.people.find((p) => p.name === "Tess Tier");
    assert.equal(me.agentTier, 0);
    const none = await api("POST", "/v1/chats", { token, body: {} });
    assert.deepEqual([none.status, none.json.error?.code ?? none.json.code], [403, "no_agent"]);
    assert.equal((await api("PATCH", `/v1/people/${me.id}`, { token, body: { agentTier: 1 } })).status, 403);
    assert.equal((await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { agentTier: 9 } })).status, 400);
    assert.equal((await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { agentTier: 1 } })).json.person.agentTier, 1);
    assert.equal((await api("POST", "/v1/chats", { token, body: {} })).status, 201);
    const t2 = await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { agentTier: 2 } });
    assert.deepEqual([t2.json.person.agentTier, t2.json.person.vibeCoder], [2, true]);
    assert.equal((await api("POST", "/v1/chats", { token, body: {} })).json.chat.mode, "vibe");
    // 5 = product manager; a personal daily limit is one of a few steps, owners only, and null returns to the tier's.
    const t5 = await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { agentTier: 5 } });
    assert.deepEqual([t5.status, t5.json.person.agentTier, t5.json.person.vibeCoder], [200, 5, false]);
    assert.equal((await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { agentTier: 6 } })).status, 400);
    assert.equal((await api("PATCH", `/v1/people/${me.id}`, { token, body: { tokenLimit: 20000000 } })).status, 403);
    assert.equal((await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { tokenLimit: 123 } })).status, 400);
    const lim = await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { tokenLimit: 20000000 } });
    assert.deepEqual([lim.status, lim.json.person.tokenLimit, lim.json.person.agentTier], [200, 20000000, 5]);
    assert.equal((await api("GET", "/v1/people", { token: boss })).json.people.find((p) => p.id === me.id).tokenLimit, 20000000);
    assert.equal((await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { tokenLimit: null } })).json.person.tokenLimit, null);
    // Only a raise gets a note from the agent, in their own conversation with it: 20M was a raise; back to the tier's (5M) is not.
    const agentNotes = async () => { const dm = (await api("GET", "/v1/conversations", { token })).json.conversations.find((c) => c.agentDm); return dm ? (await api("GET", `/v1/conversations/${dm.id}/messages`, { token })).json.messages.filter((x) => /^Congratulations/.test(x.text)) : []; };
    // Earlier raises counted too: no agent to tester (one million), tester to business owner (five million).
    const notes = await agentNotes();
    assert.deepEqual(notes.map((x) => x.text.match(/up to (.+?) tokens/)[1]), ["one million", "five million", "20 million"]);
    await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { tokenLimit: 5000000 } });
    await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { tokenLimit: 1000000 } });
    assert.equal((await agentNotes()).length, 3, "the same or lower: nothing");
    await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { tokenLimit: null } });
    assert.equal((await agentNotes()).length, 4, "back up to the tier's five million");
    // The app offers "no limit" and the steps as one choice, so one request turns no limit off and sets the step.
    const lifted = await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { unlimitedTokens: true } });
    assert.deepEqual([lifted.json.person.unlimitedTokens, lifted.json.person.tokenLimit], [true, null]);
    const both = await api("PATCH", `/v1/people/${me.id}`, { token: boss, body: { unlimitedTokens: false, tokenLimit: 5000000 } });
    assert.deepEqual([both.status, both.json.person.unlimitedTokens, both.json.person.tokenLimit], [200, false, 5000000]);
    const listed = (await api("GET", "/v1/people", { token: boss })).json.people.find((p) => p.id === me.id);
    assert.deepEqual([listed.unlimitedTokens, listed.tokenLimit], [undefined, 5000000]);
    // The owner's list says what each role's own limit is, so the app can explain "Role default". Members are not told.
    const forOwner = (await api("GET", "/v1/people", { token: boss })).json;
    assert.deepEqual(forOwner.tierTokenLimits, { 0: 0, 1: 1000000, 2: 5000000, 3: 20000000, 4: 5000000, 5: 5000000 });
    assert.equal((await api("GET", "/v1/people", { token })).json.tierTokenLimits, undefined);
    // Beside each limit the owner's sheet says about what it costs. With nothing set, every role is priced as
    // Claude Sonnet 5.5. Members are not told.
    assert.deepEqual(Object.keys(forOwner.tierCosts), ["1", "2", "3", "4", "5"]);
    const estimate = forOwner.tierCosts[2];
    assert.deepEqual([estimate.model, estimate.input, estimate.output, estimate.priced], ["Claude Sonnet 5.5", 2, 10, true]);
    assert.ok(estimate.perMillion >= 2 && estimate.perMillion <= 10, `a blend of the two prices: ${estimate.perMillion}`);
    assert.equal((await api("GET", "/v1/people", { token })).json.tierCosts, undefined);
    // With the agent's model and prices in config.json, the roles that run on that agent are priced by it; the
    // researcher's agent, which has none, keeps the default.
    const config = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    fs.writeFileSync(cfgFile, JSON.stringify({ ...config, upstreams: { ...config.upstreams, owner: { ...config.upstreams.owner, model: "example-model", usdPerMillion: { input: 1, output: 5 } } } }));
    const priced = (await api("GET", "/v1/people", { token: boss })).json.tierCosts;
    assert.deepEqual([priced[3].model, priced[3].input, priced[3].output, priced[3].priced], ["example-model", 1, 5, true]);
    const share = (estimate.perMillion - 2) / 8;
    assert.ok(Math.abs(priced[3].perMillion - (1 + 4 * share)) < 0.002, `the same mix at the agent's own prices: ${priced[3].perMillion}`);
    assert.deepEqual([priced[4].model, priced[4].priced, priced[4].perMillion], ["Claude Sonnet 5.5", true, estimate.perMillion]);
    assert.deepEqual(priced[1], priced[3], "with full agent access every role but the researcher runs on the owner's agent");
  } finally { fs.writeFileSync(cfgFile, before); }
});

test("people list: owners see work email and whether it was verified, only on servers that check email", async () => {
  const cfgFile = path.join(dataDir, "config.json");
  const before = fs.readFileSync(cfgFile, "utf8");
  const boss = await pair("owner", "Email Owner");
  const token = await pair("member", "Eve Email");
  try {
    const listed = async (t) => (await api("GET", "/v1/people", { token: t })).json;
    const off = await listed(boss);
    assert.equal(off.emailChecks, undefined);
    assert.ok(off.people.every((p) => !("email" in p) && !("emailVerified" in p)), "nothing when email checks are off");
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(before), emailVerification: { enabled: true, domains: ["example.gov"] } }));
    const state = createStateStore({ directory: dataDir });
    state.mutate((st) => {
      const u = Object.values(st.users).find((x) => x.name === "Eve Email");
      u.email = "eve@example.gov";
    });
    const on = await listed(boss);
    assert.equal(on.emailChecks, true);
    const eve = on.people.find((p) => p.name === "Eve Email");
    assert.deepEqual([eve.email, eve.emailVerified], ["eve@example.gov", false], "an address with no code behind it is unverified");
    state.mutate((st) => { Object.values(st.users).find((x) => x.name === "Eve Email").emailVerifiedAt = Date.now(); });
    assert.equal((await listed(boss)).people.find((p) => p.name === "Eve Email").emailVerified, true);
    const none = (await listed(boss)).people.find((p) => p.name === "Email Owner");
    assert.deepEqual([none.email, none.emailVerified], [null, false], "no address at all");
    const seen = await listed(token);
    assert.equal(seen.emailChecks, undefined);
    assert.ok(seen.people.every((p) => !("email" in p)), "members never see anyone's email");
  } finally { fs.writeFileSync(cfgFile, before); }
});

test("ten wrong codes lock out pairing from that address; good pairings don't count", async () => {
  // Earlier tests already used one wrong code from this address.
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await api("POST", "/v1/pair", { body: { terms: ACCEPT, code: "WRONG-CODE" + i } })).status);
  assert.equal(statuses[0], 403);
  assert.equal(statuses.at(-1), 429);
  const code = mod.createInvite({ name: "Late" });
  assert.equal((await api("POST", "/v1/pair", { body: { terms: ACCEPT, code } })).status, 429);
});


test("prototypes are served by the server itself: sandboxed, public by link, nothing escapes the folder", async () => {
  const dir = path.join(dataDir, "prototypes", "proto-abcdef012345678901");
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Refunds</h1>");
  fs.writeFileSync(path.join(dir, "sub", "page.css"), "body{}");
  fs.writeFileSync(path.join(dataDir, "secret.txt"), "top secret");
  fs.symlinkSync(path.join(dataDir, "secret.txt"), path.join(dir, "link.txt"));
  const get = async (p, opts) => fetch(base + p, { redirect: "manual", ...opts });
  const page = await get("/p/proto-abcdef012345678901/");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.startsWith("<h1>Refunds</h1>") && html.includes("data-servant-hmr"), "pages carry the live-reload script");
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /^sandbox /, "the page can't reach this server's API or storage");
  assert.equal((await get("/p/proto-abcdef012345678901/sub/page.css")).headers.get("content-type"), "text/css; charset=utf-8");
  const slash = await get("/p/proto-abcdef012345678901");
  assert.equal(slash.status, 301);
  assert.equal(slash.headers.get("location"), "/p/proto-abcdef012345678901/");
  for (const bad of ["/p/proto-abcdef012345678901/link.txt", "/p/proto-abcdef012345678901/../secret.txt", "/p/proto-abcdef012345678901/%2e%2e/secret.txt", "/p/proto-abcdef012345678901/.hidden", "/p/", "/p/proto-nope-nope-nope/", "/p/..%2f/", "/p/UPPER/"]) assert.equal((await get(bad)).status, 404, bad);
  assert.equal((await get("/p/proto-abcdef012345678901/", { method: "POST" })).status, 405);
  assert.equal((await get("/p/proto-abcdef012345678901/", { method: "HEAD" })).status, 200);
});

test("prototype security: no indexing, no framing tricks, rate limit per visitor, files removed with the chat", async () => {
  const folder = "proto-fedcba987654321012";
  fs.mkdirSync(path.join(dataDir, "prototypes", folder), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "prototypes", folder, "index.html"), "<p>x</p>");
  const ok = await fetch(`${base}/p/${folder}/`);
  assert.equal(ok.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.match(ok.headers.get("content-security-policy"), /form-action 'self'; base-uri 'self'/);
  assert.equal(await (await fetch(`${base}/robots.txt`)).text(), "User-agent: *\nDisallow: /p/\nDisallow: /m/\nDisallow: /g/\n");
  // 600 a minute per visitor, then a polite wait; another visitor is unaffected.
  const { servePrototype, _resetLimits } = await import("./prototypes.mjs");
  _resetLimits();
  const run = (ip) => { let status; servePrototype({ method: "GET" }, { writeHead: (s) => { status = s; }, end() {} }, new URL(`http://x/p/${folder}/`), { dir: path.join(dataDir, "prototypes"), ip }); return status; };
  for (let i = 0; i < 600; i++) assert.equal(run("1.1.1.1"), 200);
  assert.equal(run("1.1.1.1"), 429);
  assert.equal(run("2.2.2.2"), 200);
  _resetLimits();
});

test("security: the email-code endpoint counts every request per visitor, and the MCP/ffmpeg inputs are constrained", async () => {
  const src = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(src, /emailStartAllowed\(ip\)/, "every code request is counted");
  assert.match(fs.readFileSync(new URL("./meetings.mjs", import.meta.url), "utf8"), /"-protocol_whitelist", "file", "-i"/, "ffmpeg reads local files only");
  assert.match(fs.readFileSync(new URL("./join-page.mjs", import.meta.url), "utf8"), /name="referrer" content="no-referrer"/);
});
