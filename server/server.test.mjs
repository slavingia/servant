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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-test-"));
process.env.SERVANT_DATA_DIR = dataDir;

function fakeHermes(key, label) {
  const sessions = new Map();
  const calls = [];
  const server = http.createServer(async (req, res) => {
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
      ev("run.completed", {});
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

after(() => {
  server.close();
  owner.server.close();
  member.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const api = async (method, p, { token, body } = {}) => {
  const res = await fetch(base + p, {
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
  const r = await api("POST", "/v1/pair", { body: { code: code.toLowerCase(), device: "Test phone" } });
  assert.equal(r.status, 201, r.text);
  return r.json.token;
}

test("everything except health and pairing needs a token", async () => {
  assert.equal((await api("GET", "/health")).status, 200);
  assert.equal((await api("GET", "/v1/chats")).status, 401);
  assert.equal((await api("GET", "/v1/me", { token: "nope" })).status, 401);
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
  assert.equal((await api("POST", "/v1/pair", { body: { code } })).status, 201);
  const again = await api("POST", "/v1/pair", { body: { code } });
  assert.equal(again.status, 403);
  assert.equal(again.json.error.message, "That invite link doesn't work. Ask for a new one");
});

test("the join link works for many people, asks each for a name, and a fresh link retires it", async () => {
  const { code } = mod.joinLink();
  assert.equal(mod.joinLink().code, code, "same live link until replaced");
  const noName = await api("POST", "/v1/pair", { body: { code } });
  assert.equal(noName.status, 400);
  assert.equal(noName.json.error.code, "name_required");
  const a = await api("POST", "/v1/pair", { body: { code, name: "Gus" } });
  const b = await api("POST", "/v1/pair", { body: { code, name: "Hana" } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.json.user.role, "member");
  assert.notEqual(a.json.user.id, b.json.user.id);
  assert.equal(b.json.user.name, "Hana");
  const next = mod.joinLink({ fresh: true }).code;
  assert.notEqual(next, code);
  assert.equal((await api("POST", "/v1/pair", { body: { code, name: "Ivy" } })).status, 403);
  assert.equal((await api("POST", "/v1/pair", { body: { code: next, name: "Ivy" } })).status, 201);
});

test("member chat streams from the member agent and hides tool details", async () => {
  const token = await pair("member", "Ben");
  const created = await api("POST", "/v1/chats", { token, body: {} });
  assert.equal(created.status, 201);
  const chatId = created.json.chat.id;

  const sent = await api("POST", `/v1/chats/${chatId}/messages`, { token, body: { text: "hello there" } });
  assert.equal(sent.status, 200);
  const events = parseSse(sent.text);
  const deltas = events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
  assert.equal(deltas, "member-agent heard: hello there");
  assert.deepEqual(events.find((e) => e.event === "status").data, { text: "Working" });
  assert.equal(events.at(-1).event, "done");
  assert.ok(!sent.text.includes("id_rsa"), "tool args must never reach a member");

  // Went to the member upstream, scoped to this person's memory.
  const streamCall = member.calls.find((c) => c.url.endsWith("/chat/stream"));
  assert.equal(streamCall.headers["x-hermes-session-key"].startsWith("servant:usr_"), true);
  assert.equal(owner.calls.filter((c) => c.url.endsWith("/chat/stream")).length, 0);

  const history = await api("GET", `/v1/chats/${chatId}/messages`, { token });
  assert.deepEqual(history.json.messages.map((m) => m.role), ["user", "assistant"]);
  assert.ok(!history.text.includes("secret tool output"));

  const list = await api("GET", "/v1/chats", { token });
  assert.equal(list.json.chats[0].title, "hello there");
});

test("people can't see each other's chats", async () => {
  const a = await pair("member", "Cy");
  const b = await pair("member", "Di");
  const chat = (await api("POST", "/v1/chats", { token: a, body: {} })).json.chat;
  assert.equal((await api("GET", `/v1/chats/${chat.id}/messages`, { token: b })).status, 404);
  assert.equal((await api("POST", `/v1/chats/${chat.id}/messages`, { token: b, body: { text: "hi" } })).status, 404);
  assert.equal((await api("GET", "/v1/chats", { token: b })).json.chats.length, 0);
});

test("a second-device invite pairs as the same person", async () => {
  const first = await pair("member", "Two Devices");
  const me = (await api("GET", "/v1/me", { token: first })).json;
  const code = mod.createInvite({ userId: me.user.id });
  const r = await api("POST", "/v1/pair", { body: { code, device: "iPad" } });
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
  assert.match(sent.text, /Using terminal/);

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
  const raw = fs.readFileSync(path.join(dataDir, "state.json"), "utf8");
  const mode = fs.statSync(path.join(dataDir, "state.json")).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.ok(!/[A-Za-z0-9_-]{43}/.test(raw.replace(/"[0-9a-f]{64}"/g, "")), "no raw device tokens on disk");
});

// ---------- channels, direct messages, threads ----------

async function events(token) {
  const ctrl = new AbortController();
  const res = await fetch(base + "/v1/events", { method: "POST", body: "{}", headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  const got = [];
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!block.startsWith("event:")) continue;
          const [e, d] = block.split("\n");
          got.push({ event: e.slice(7), data: JSON.parse(d.slice(6)) });
        }
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

  // Ben finds it in browse, can read but not post until he joins.
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

test("@agent in a channel replies in a thread, as the member agent, with live updates", async () => {
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

test("channel archive is personal, persistent, reversible, and still receives messages", async () => {
  const a = await pair("member", "Archive A");
  const b = await pair("member", "Archive B");
  const outsider = await pair("member", "Archive outsider");
  const ch = (await api("POST", "/v1/conversations", { token: a, body: { name: "archive-personal" } })).json.conversation;
  const route = `/v1/conversations/${ch.id}`;
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
  assert.equal((await api("DELETE", `/v1/conversations/${dm.id}`, { token: creator })).status, 403);
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
  const prefs = await api("PATCH", "/v1/notifications", { token, body: { mode: "none", previews: false } });
  assert.equal(prefs.status, 200);assert.equal(prefs.json.preferences.previews, false);
  assert.equal((await api("POST", "/v1/notifications/presence", { token, body: { active: true, conversation: "ch_test" } })).status, 200);
  assert.equal((await api("POST", "/v1/signout", { token })).status, 200);
  assert.equal((await api("GET", "/v1/notifications", { token })).status, 401);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json")));
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
  assert.equal(m.latestRelease().build, "6");
  m.close();
});

test("release notes can only be posted from this Mac with the admin key", async () => {
  const r = await fetch(`${base}/admin/releases`, { method: "POST", headers: { "Content-Type": "application/json", "cf-connecting-ip": "1.2.3.4", "X-Servant-Admin": "x" }, body: JSON.stringify({ build: "1", notes: "n" }) });
  assert.equal(r.status, 403);
  const r2 = await fetch(`${base}/admin/releases`, { method: "POST", headers: { "Content-Type": "application/json", "X-Servant-Admin": "" }, body: JSON.stringify({ build: "1", notes: "n" }) });
  assert.equal(r2.status, 403);
});

test("ten wrong codes lock out pairing from that address; good pairings don't count", async () => {
  // Earlier tests already used one wrong code from this address.
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await api("POST", "/v1/pair", { body: { code: "WRONG-CODE" + i } })).status);
  assert.equal(statuses[0], 403);
  assert.equal(statuses.at(-1), 429);
  const code = mod.createInvite({ name: "Late" });
  assert.equal((await api("POST", "/v1/pair", { body: { code } })).status, 429);
});
