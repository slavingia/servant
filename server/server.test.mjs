import { restrictedTestCapabilities } from "./test-hermes-capabilities.mjs";
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

function fakeHermes(key, label) {
  const sessions = new Map();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/capabilities") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(restrictedTestCapabilities));
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
      const reply = `${label} heard: ${body.message}`;
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
let server;
let base;
let mod;

before(async () => {
  await new Promise((r) => owner.server.listen(0, "127.0.0.1", r));
  await new Promise((r) => member.server.listen(0, "127.0.0.1", r));
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      port: 0,
      name: "Test server",
      discoveryUrl: "https://example.test/hub.json",
      upstreams: {
        owner: { url: `http://127.0.0.1:${owner.server.address().port}`, key: "owner-key" },
        member: { url: `http://127.0.0.1:${member.server.address().port}`, key: "member-key" },
      },
    }),
  );
  mod = await import("./server.mjs");
  server = await mod.startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await server.shutdown();
  owner.server.close();
  member.server.close();
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

test("everything except health and pairing needs a token", async () => {
  assert.equal((await api("GET", "/health")).status, 200);
  assert.equal((await api("GET", "/v1/chats")).status, 401);
  assert.equal((await api("GET", "/v1/me", { token: "nope" })).status, 401);
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
  assert.equal(again.json.error.message, "That invite link doesn't work. Ask for a new one");
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

test("projects: technical people pick one; the chat's turns carry its instructions", async () => {
  const token = await pair("member", "Pat Projects");
  const listed = await api("GET", "/v1/projects", { token });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.vibeCoder, false);
  assert.ok(listed.json.projects.some((p) => p.id === "mac"));
  assert.equal((await api("POST", "/v1/chats", { token, body: { project: "nope" } })).status, 400);
  const chat = (await api("POST", "/v1/chats", { token, body: { project: "mac" } })).json.chat;
  assert.deepEqual(chat.project, { id: "mac", name: "Mac" });
  assert.equal(chat.mode, undefined);
});

test("folders: group your own chats and share notes and files with every chat in them", async () => {
  const token = await pair("member", "Fran Folders");
  const other = await pair("member", "Olly Other");
  assert.equal((await api("POST", "/v1/folders", { token, body: { name: "  " } })).status, 400);
  const folder = (await api("POST", "/v1/folders", { token, body: { name: "Refund tracker", notes: "Audience: taxpayers. Plain words." } })).json.folder;
  assert.equal(folder.name, "Refund tracker");
  assert.equal(folder.chatCount, 0);
  assert.equal(folder.role, "owner");
  // Only you see your folders.
  assert.deepEqual((await api("GET", "/v1/folders", { token: other })).json.folders, []);
  assert.equal((await api("GET", `/v1/folders/${folder.id}`, { token: other })).status, 404);
  assert.equal((await api("POST", "/v1/chats", { token: other, body: { folderId: folder.id } })).status, 404);
  const added = await api("POST", `/v1/folders/${folder.id}/files`, { token, body: { name: "brief.md", data: Buffer.from("The product shows refund status.").toString("base64") } });
  assert.equal(added.status, 200);
  assert.deepEqual(added.json.folder.files.map(f => f.name), ["brief.md"]);
  const chatA = (await api("POST", "/v1/chats", { token, body: { folderId: folder.id } })).json.chat;
  const chatB = (await api("POST", "/v1/chats", { token, body: {} })).json.chat;
  assert.equal(chatA.folderId, folder.id);
  assert.equal(chatB.folderId, undefined);
  // Move chat B in, then both carry the folder's context on every turn.
  assert.equal((await api("PATCH", `/v1/chats/${chatB.id}`, { token, body: { folderId: folder.id } })).json.chat.folderId, folder.id);
  assert.equal((await api("GET", `/v1/folders/${folder.id}`, { token })).json.folder.chatCount, 2);
  for (const chat of [chatA, chatB]) {
    const before = owner.calls.length + member.calls.length;
    await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "hello" } });
    const stream = [...owner.calls, ...member.calls].slice(before).find((c) => c.url.endsWith("/chat/stream"));
    assert.match(stream.body.system_message, /folder "Refund tracker"/);
    assert.match(stream.body.system_message, /Audience: taxpayers/);
    // The full agent reads files from disk by path.
    assert.match(stream.body.system_message, /brief\.md.*folder-files/);
  }
  // A limited agent never gets a path: small text files come inline instead.
  await withAgentAccess("limited", async () => {
    const limited = (await api("POST", "/v1/chats", { token, body: { folderId: folder.id } })).json.chat;
    const before = owner.calls.length + member.calls.length;
    await api("POST", `/v1/chats/${limited.id}/messages`, { token, body: { text: "again" } });
    const stream = await waitFor(() => [...owner.calls, ...member.calls].slice(before).find((c) => c.url.endsWith("/chat/stream")));
    assert.match(stream.body.system_message, /The product shows refund status\./);
    assert.doesNotMatch(stream.body.system_message, /folder-files/);
  });
  // Rename, edit notes, remove a file.
  const edited = (await api("PATCH", `/v1/folders/${folder.id}`, { token, body: { name: "Refunds", notes: "" } })).json.folder;
  assert.equal(edited.name, "Refunds");
  assert.equal((await api("DELETE", `/v1/folders/${folder.id}/files/${added.json.folder.files[0].id}`, { token })).json.folder.files.length, 0);
  // Taking a chat out, and deleting the folder keeps the chats.
  assert.equal((await api("PATCH", `/v1/chats/${chatB.id}`, { token, body: { folderId: null } })).json.chat.folderId, undefined);
  assert.equal((await api("DELETE", `/v1/folders/${folder.id}`, { token })).status, 200);
  assert.equal((await api("GET", `/v1/chats/${chatA.id}`, { token })).json.chat.folderId, undefined);
  assert.deepEqual((await api("GET", "/v1/folders", { token })).json.folders, []);
  // Let this test's agent turns finish so they don't land in the next test's window.
  for (let last = -1, n = owner.calls.length + member.calls.length; n !== last; await new Promise(r => setTimeout(r, 400))) { last = n; n = owner.calls.length + member.calls.length; }
});

test("shared folders: people in a folder share its notes and files, never each other's chats unless one is shared", async () => {
  const ann = await pair("member", "Ann Author");
  const ben = await pair("member", "Ben Buddy");
  const cy = await pair("member", "Cy Outsider");
  const id = async token => (await api("GET", "/v1/people", { token })).json.me;
  const [benId, cyId] = [await id(ben), await id(cy)];
  const folder = (await api("POST", "/v1/folders", { token: ann, body: { name: "Tax pro launch", notes: "Goal: ship the client switcher." } })).json.folder;
  await api("POST", `/v1/folders/${folder.id}/files`, { token: ann, body: { name: "spec.md", data: Buffer.from("Switcher lives in the header.").toString("base64") } });
  // Not in the folder yet: no access at all.
  assert.equal((await api("GET", `/v1/folders/${folder.id}`, { token: ben })).status, 404);
  assert.equal((await api("POST", "/v1/chats", { token: ben, body: { folderId: folder.id } })).status, 404);
  // Only the owner adds people, and only real ones.
  assert.equal((await api("POST", `/v1/folders/${folder.id}/members`, { token: ben, body: { userId: cyId } })).status, 404);
  assert.equal((await api("POST", `/v1/folders/${folder.id}/members`, { token: ann, body: { userId: "usr_nope" } })).status, 404);
  const withBen = (await api("POST", `/v1/folders/${folder.id}/members`, { token: ann, body: { userId: benId } })).json.folder;
  assert.deepEqual(withBen.members.map(m => m.name), ["Ben Buddy"]);
  // Ben sees the folder, its notes and files, as a member.
  const seen = (await api("GET", `/v1/folders/${folder.id}`, { token: ben })).json.folder;
  assert.equal(seen.role, "member");
  assert.equal(seen.owner.name, "Ann Author");
  assert.match(seen.notes, /client switcher/);
  assert.deepEqual(seen.files.map(f => f.name), ["spec.md"]);
  assert.equal((await api("GET", "/v1/folders", { token: ben })).json.folders.length, 1);
  assert.deepEqual((await api("GET", "/v1/folders", { token: cy })).json.folders, []);
  // Members work on the shared context but can't rename, delete or add people.
  assert.equal((await api("PATCH", `/v1/folders/${folder.id}`, { token: ben, body: { notes: "Goal: ship the client switcher. Ben adds: test on iPad." } })).status, 200);
  assert.equal((await api("PATCH", `/v1/folders/${folder.id}`, { token: ben, body: { name: "Mine now" } })).status, 403);
  assert.equal((await api("DELETE", `/v1/folders/${folder.id}`, { token: ben })).status, 403);
  assert.equal((await api("POST", `/v1/folders/${folder.id}/members`, { token: ben, body: { userId: cyId } })).status, 403);
  // Each person starts their own chat; both carry the shared context. In a folder with
  // other people a new chat is private to its author unless they say otherwise.
  const annChat = (await api("POST", "/v1/chats", { token: ann, body: { folderId: folder.id } })).json.chat;
  const benChat = (await api("POST", "/v1/chats", { token: ben, body: { folderId: folder.id } })).json.chat;
  assert.equal(annChat.shared, false);
  assert.equal(benChat.shared, false);
  assert.equal((await api("POST", "/v1/chats", { token: ann, body: { folderId: folder.id, shared: true } })).json.chat.shared, false, "asking for shared at creation is ignored: sharing is chosen afterwards");
  assert.equal((await api("POST", "/v1/chats", { token: ann, body: {} })).json.chat.shared, false, "chats outside folders are private too");
  const solo = (await api("POST", "/v1/folders", { token: cy, body: { name: "Just me" } })).json.folder;
  assert.equal((await api("POST", "/v1/chats", { token: cy, body: { folderId: solo.id } })).json.chat.shared, false, "a folder with only you is private as well");
  for (const [token, chat] of [[ann, annChat], [ben, benChat]]) {
    await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: `question from ${chat.id}` } });
    const stream = await waitFor(() => [...owner.calls, ...member.calls].find(c => c.url.endsWith("/chat/stream") && c.body.message === `question from ${chat.id}`));
    assert.match(stream.body.system_message, /folder "Tax pro launch"/);
    assert.match(stream.body.system_message, /test on iPad/);
    assert.match(stream.body.system_message, /spec\.md/);
    assert.match(stream.body.system_message, /Several people work in this folder/);
  }
  // Private by default: neither can read the other's chat, in the folder or out of it.
  assert.equal((await api("GET", `/v1/chats/${annChat.id}`, { token: ben })).status, 404);
  assert.equal((await api("GET", `/v1/chats/${annChat.id}/messages`, { token: ben })).status, 404);
  assert.equal((await api("GET", `/v1/chats/${benChat.id}/messages`, { token: ann })).status, 404);
  let listed = (await api("GET", `/v1/folders/${folder.id}`, { token: ben })).json;
  assert.deepEqual(listed.sharedChats, []);
  assert.equal(listed.folder.chatCount, 1);
  assert.equal((await api("GET", "/v1/chats?scope=org", { token: ben })).json.orgChats.some(c => c.id === annChat.id), false);
  // Sharing with the folder opens it, read only, to folder people and nobody else.
  assert.equal((await api("PATCH", `/v1/chats/${annChat.id}`, { token: cy, body: { folderShared: true } })).status, 404);
  const shared = (await api("PATCH", `/v1/chats/${annChat.id}`, { token: ann, body: { folderShared: true } })).json.chat;
  assert.equal(shared.folderShared, true);
  assert.equal(shared.shared, false, "sharing with the folder doesn't share with the whole server");
  listed = (await api("GET", `/v1/folders/${folder.id}`, { token: ben })).json;
  assert.deepEqual(listed.sharedChats.map(c => c.id), [annChat.id]);
  assert.equal(listed.sharedChats[0].author.name, "Ann Author");
  assert.equal((await api("GET", `/v1/chats/${annChat.id}/messages`, { token: ben })).status, 200);
  assert.equal((await api("POST", `/v1/chats/${annChat.id}/messages`, { token: ben, body: { text: "hijack" } })).status, 403);
  assert.equal((await api("GET", `/v1/chats/${annChat.id}/messages`, { token: cy })).status, 404);
  assert.equal((await api("GET", `/v1/folders/${folder.id}`, { token: cy })).status, 404);
  assert.equal((await api("GET", "/v1/chats?scope=org", { token: ben })).json.orgChats.some(c => c.id === annChat.id), false, "folder sharing isn't server-wide sharing");
  // Taking it back, or moving it out of the folder, closes it again.
  await api("PATCH", `/v1/chats/${annChat.id}`, { token: ann, body: { folderShared: false } });
  assert.equal((await api("GET", `/v1/chats/${annChat.id}/messages`, { token: ben })).status, 404);
  await api("PATCH", `/v1/chats/${annChat.id}`, { token: ann, body: { folderShared: true } });
  await api("PATCH", `/v1/chats/${annChat.id}`, { token: ann, body: { folderId: null } });
  assert.equal((await api("GET", `/v1/chats/${annChat.id}/messages`, { token: ben })).status, 404);
  assert.equal((await api("PATCH", `/v1/chats/${annChat.id}`, { token: ann, body: { folderShared: true } })).status, 400, "needs a folder first");
  // Leaving: Ben's chat leaves the folder with him and loses the shared context.
  await api("PATCH", `/v1/chats/${benChat.id}`, { token: ben, body: { folderShared: true } });
  assert.equal((await api("DELETE", `/v1/folders/${folder.id}/members/me`, { token: ben })).status, 200);
  assert.equal((await api("GET", `/v1/folders/${folder.id}`, { token: ben })).status, 404);
  const afterLeave = (await api("GET", `/v1/chats/${benChat.id}`, { token: ben })).json.chat;
  assert.equal(afterLeave.folderId, undefined);
  assert.equal(afterLeave.folderShared, undefined);
  assert.equal((await api("GET", `/v1/chats/${benChat.id}/messages`, { token: ann })).status, 404);
  // The owner can't leave (delete instead); removing someone else is the owner's call.
  await api("POST", `/v1/folders/${folder.id}/members`, { token: ann, body: { userId: benId } });
  assert.equal((await api("DELETE", `/v1/folders/${folder.id}/members/me`, { token: ann })).status, 400);
  assert.equal((await api("DELETE", `/v1/folders/${folder.id}/members/${benId}`, { token: cy })).status, 404);
  assert.equal((await api("DELETE", `/v1/folders/${folder.id}/members/${benId}`, { token: ann })).json.folder.members.length, 0);
  // A teammate's file add and remove land in the one shared folder.
  await api("POST", `/v1/folders/${folder.id}/members`, { token: ann, body: { userId: benId } });
  const more = (await api("POST", `/v1/folders/${folder.id}/files`, { token: ben, body: { name: "ben.txt", data: Buffer.from("hi").toString("base64") } })).json.folder;
  assert.deepEqual(more.files.map(f => f.name), ["spec.md", "ben.txt"]);
  // Deleting the folder frees everyone's chats.
  assert.equal((await api("DELETE", `/v1/folders/${folder.id}`, { token: ann })).status, 200);
  assert.equal((await api("GET", `/v1/folders/${folder.id}`, { token: ben })).status, 404);
  for (let last = -1, n = owner.calls.length + member.calls.length; n !== last; await new Promise(r => setTimeout(r, 400))) { last = n; n = owner.calls.length + member.calls.length; }
});

test("vibe coding is an option for everyone: any member can pick it and gets a preview link", async () => {
  const token = await pair("member", "Remy Regular");
  assert.equal((await api("GET", "/v1/projects", { token })).json.vibeCoder, false);
  const chat = (await api("POST", "/v1/chats", { token, body: { mode: "vibe" } })).json.chat;
  assert.equal(chat.mode, "vibe");
  assert.equal(chat.project.id, "design-prototypes");
  assert.match(chat.previewUrl, /^https:\/\/taxpayer-services-and-online-accounts\.github\.io\/design-prototypes\/vibe-[a-z0-9]+\/$/);
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "a page about refunds" } });
  const stream = await waitFor(() => [...owner.calls, ...member.calls].find((c) => c.url.endsWith("/chat/stream") && c.body.message === "a page about refunds"));
  assert.ok(stream.body.system_message.includes(`PREVIEW: ${chat.previewUrl}`));
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
  // Their chats ignore a requested project and always vibe-code the prototypes repo.
  const chat = (await api("POST", "/v1/chats", { token, body: { project: "mac" } })).json.chat;
  assert.equal(chat.mode, "vibe");
  assert.equal(chat.project.id, "design-prototypes");
  assert.match(chat.previewUrl, /^https:\/\/taxpayer-services-and-online-accounts\.github\.io\/design-prototypes\/vibe-[a-z0-9]+\/$/);
  const before = owner.calls.length;
  await api("POST", `/v1/chats/${chat.id}/messages`, { token, body: { text: "a page about refunds" } });
  const stream = owner.calls.slice(before).find((c) => c.url.endsWith("/chat/stream"));
  assert.match(stream.body.system_message, /vibe-coding session/);
  assert.ok(stream.body.system_message.includes(`PREVIEW: ${chat.previewUrl}`));
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
  const ownerToken = await pair("owner", "Sahil");
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
  // A link made for them before they left can't bring them back, and a folder can't take them.
  assert.equal((await api("POST", "/v1/pair", { body: { terms: ACCEPT, code: staleInvite, device: "New phone" } })).status, 403);
  const folder = (await api("POST", "/v1/folders", { token: owner, body: { name: "Team" } })).json.folder;
  assert.equal((await api("POST", `/v1/folders/${folder.id}/members`, { token: owner, body: { userId: lee.id } })).status, 404, "can't add a removed person to a folder");
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
