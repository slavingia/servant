import { restrictedTestCapabilities } from "./test-hermes-capabilities.mjs";
// Exercise the encrypted API, real SQLite stores, and Hermes multimodal/SSE
// contract together. The fake upstream deliberately returns unresolved MEDIA
// paths in history, matching Hermes's current history endpoint.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";
import { createStateStore } from "./state-store.mjs";
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";
const ACCEPT = { version: TERMS_VERSION, items: TERMS_ITEMS };

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const uri = `data:image/png;base64,${png}`;
const upload = { name: "photo.png", data: png };
const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432000000086d646174", "hex").toString("base64");
const videoUri = `data:video/mp4;base64,${mp4}`;
const videoUpload = { name: "Trip.mp4", data: mp4 };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-media-api-"));
process.env.SERVANT_DATA_DIR = dataDir;
const sessions = new Map();
const turns = [];
let mode = "normal", historyGate;
const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/capabilities") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(restrictedTestCapabilities));
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  if (req.headers.authorization !== "Bearer test-key") return res.writeHead(401).end();
  if (req.method === "POST" && req.url === "/api/sessions") {
    sessions.set(body.id, []);
    return res.writeHead(201, { "Content-Type": "application/json" }).end("{}");
  }
  const route = req.url.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
  const messages = sessions.get(route?.[1]);
  if (!messages) return res.writeHead(404).end();
  if (req.method === "DELETE") {
    sessions.delete(route[1]);
    return res.writeHead(200).end("{}");
  }
  if (req.method === "GET" && route[2] === "/messages") {
    if (historyGate) { const gate = historyGate; historyGate = null; gate.started(); await gate.promise; }
    if (mode === "bad-history") return res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ messages }));
  }
  if (req.method === "POST" && route[2] === "/chat/stream") {
    turns.push(body.message);
    if (mode === "reject") return res.writeHead(422).end("rejected");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit("run.started", {});
    if (mode === "truncated") {
      emit("assistant.delta", { delta: `Partial text ![Broken](data:image/png;base64,${png.slice(0, 12)}` });
      return res.end();
    }
    if (mode === "fail-after-accept") {
      emit("error", { message: "private upstream details" });
      return res.end();
    }
    const content = Array.isArray(body.message) && body.message.every(p => p.type === "text") ? body.message.map(p => p.text).join("\n") : body.message;
    messages.push({ id: `m${messages.length}`, role: "user", content });
    if (mode === "video") {
      messages.push({ id: `m${messages.length}`, role: "assistant", content: "A clip for you.\n\nMEDIA: /private/generated/clip.mp4" });
      for (const delta of ["A clip for you.\n\n[Clip](data:vi", "deo/mp4;base64,", mp4, ")"]) emit("assistant.delta", { delta });
      emit("assistant.completed", { content: [{ type: "text", text: "A clip for you." }, { type: "video_url", video_url: { url: videoUri }, name: "Clip.mp4" }] });
      emit("run.completed", { messages: [messages.at(-1)] });
      emit("done", {});
      return res.end();
    }
    messages.push({ id: `m${messages.length}`, role: "assistant", content: "Here you go.\n\nMEDIA: /private/generated/picture.png" });
    for (const delta of ["Here you go.\n\n!", "[Picture](data:", `image/png;base64,${png}`, ")"]) emit("assistant.delta", { delta });
    emit("assistant.completed", { content: `Here you go.\n\n![Picture](${uri})` });
    emit("run.completed", { messages: [messages.at(-1)] });
    emit("done", {});
    return res.end();
  }
  res.writeHead(404).end();
});
let server, base, mod;
before(async () => {
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const cfg = { port: 0, name: "Media test", agentName: "Hermes", upstreams: {
    owner: { url: `http://127.0.0.1:${upstream.address().port}`, key: "test-key" },
    member: { url: `http://127.0.0.1:${upstream.address().port}`, key: "test-key" },
  } };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg));
  mod = await import("./server.mjs");
  server = await mod.startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await server.shutdown();
  upstream.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
async function api(method, route, token, body) {
  const res = await testFetch(dataDir, base + route, { method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}
async function pair(name) {
  const response = await api("POST", "/v1/pair", undefined, { terms: ACCEPT, code: mod.createInvite({ name, role: "member" }), device: "Media test" });
  assert.equal(response.status, 201, response.text);
  return response.json.token;
}
const events = text => text.split("\n\n").filter(block => block.startsWith("event:")).map(block => {
  const [event, data] = block.split("\n");
  return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
});
// Private chats: these tests check that outsiders can't reach the media.
// Shared chats (the default) are covered in server.test.mjs.
const chat = async token => (await api("POST", "/v1/chats", token, { shared: false })).json.chat;

test("image-only private sends acknowledge stable media and Hermes images survive history reload securely", async () => {
  const token = await pair("Image author"), outsider = await pair("Image outsider");
  const c = await chat(token), route = `/v1/chats/${c.id}`;
  const response = await api("POST", route + "/messages", token, { attachments: [upload] });
  assert.equal(response.status, 200, response.text);
  const streamed = events(response.text);
  const accepted = streamed.find(e => e.event === "sent").data.message;
  const assistant = streamed.find(e => e.event === "message").data;
  assert.ok(streamed.findIndex(e => e.event === "sent") < streamed.findIndex(e => e.event === "message"));
  assert.equal(accepted.text, "");
  assert.equal(accepted.role, "user");
  assert.equal(assistant.text, "Here you go.");
  assert.equal(assistant.role, "assistant");
  const deltas = streamed.filter(e => e.event === "delta").map(e => e.data.text).join("");
  assert.equal(deltas, "Here you go.\n\n");
  assert.ok(Number.isFinite(accepted.at));
  assert.deepEqual(turns.at(-1), [{ type: "image_url", image_url: { url: uri } }]);
  for (const message of [accepted, assistant]) {
    assert.equal(message.attachments.length, 1);
    const a = message.attachments[0];
    assert.equal(a.mime, "image/png");
    assert.equal(a.data, undefined);
    assert.equal((await api("GET", `/v1/attachments/${a.id}`, token)).json.data, png);
    assert.equal((await api("GET", `/v1/attachments/${a.id}`, outsider)).status, 404);
    assert.equal((await api("GET", `/v1/attachments/${a.id}`)).status, 401);
  }
  for (let i = 0; i < 2; i++) {
    const history = await api("GET", route + "/messages", token);
    assert.deepEqual(history.json.messages, [accepted, assistant]);
    assert.ok(!history.text.includes("/private/"));
    assert.ok(!history.text.includes(png));
  }
  const first = await api("GET", route + "/media?limit=1", token);
  assert.equal(first.json.items[0].messageId, accepted.id);
  assert.equal(first.json.items[0].sender.name, "Image author");
  const second = await api("GET", route + `/media?limit=1&after=${first.json.nextCursor}`, token);
  assert.equal(second.json.items[0].messageId, assistant.id);
  assert.equal(second.json.items[0].sender.name, "Hermes");
  assert.equal(second.json.items[0].sender.agent, true);
  assert.equal(second.json.nextCursor, null);
  assert.equal((await api("GET", route + "/media", outsider)).status, 404);
  assert.equal((await api("GET", route + "/media?after=missing", token)).status, 400);
  await api("DELETE", route, token);
  assert.equal((await api("GET", route + "/media", token)).status, 404);
  assert.equal((await api("GET", `/v1/attachments/${accepted.attachments[0].id}`, token)).status, 404);
});

test("rejected uploads never acknowledge; accepted images remain durable if Hermes subsequently fails", async () => {
  const token = await pair("Delivery states"), c = await chat(token), route = `/v1/chats/${c.id}`;
  const before = turns.length;
  assert.equal((await api("POST", route + "/messages", token, { attachments: [{ name: "pretend.png", data: "not base64!" }] })).status, 400);
  assert.equal(turns.length, before);
  try {
    mode = "reject";
    const rejected = events((await api("POST", route + "/messages", token, { attachments: [upload] })).text);
    assert.ok(rejected.some(e => e.event === "error"));
    assert.ok(!rejected.some(e => e.event === "sent"));
    assert.deepEqual((await api("GET", route + "/messages", token)).json.messages, []);
    mode = "fail-after-accept";
    const failed = events((await api("POST", route + "/messages", token, { attachments: [upload] })).text);
    const accepted = failed.find(e => e.event === "sent").data.message;
    assert.ok(failed.some(e => e.event === "error"));
    assert.deepEqual((await api("GET", route + "/messages", token)).json.messages, [accepted]);
    assert.equal((await api("GET", `/v1/attachments/${accepted.attachments[0].id}`, token)).json.data, png);
  } finally { mode = "normal"; }
});

test("gallery includes all threaded files in order and excludes deleted messages and unauthorized viewers", async () => {
  const token = await pair("Channel author"), outsider = await pair("Channel outsider");
  const c = (await api("POST", "/v1/conversations", token, { name: "media-gallery", private: true })).json.conversation;
  const route = `/v1/conversations/${c.id}`;
  const root = (await api("POST", route + "/messages", token, { text: "Root", attachments: [upload] })).json.message;
  const threaded = (await api("POST", route + "/messages", token, { threadRoot: root.id, attachments: [{ name: "notes.txt", data: "aGVsbG8=" }] })).json.message;
  const last = (await api("POST", route + "/messages", token, { text: "Last", attachments: [upload] })).json.message;
  const ids = [], messageIds = []; let after;
  do {
    const page = await api("GET", route + `/media?limit=1${after ? `&after=${after}` : ""}`, token);
    assert.equal(page.status, 200, page.text);
    ids.push(...page.json.items.map(a => a.id));
    messageIds.push(...page.json.items.map(a => a.messageId));
    after = page.json.nextCursor;
  } while (after);
  assert.deepEqual(messageIds, [root.id, threaded.id, last.id]);
  assert.equal(new Set(ids).size, 3);
  assert.equal((await api("GET", route + "/media", outsider)).status, 404);
  await api("DELETE", `/v1/messages/${threaded.id}`, token);
  const remaining = (await api("GET", route + "/media", token)).json.items;
  assert.deepEqual(remaining.map(a => a.messageId), [root.id, last.id]);
  assert.equal((await api("GET", `/v1/attachments/${threaded.attachments[0].id}`, token)).status, 404);
});

test("truncated assistant streams never become completed messages or expose partial image payloads", async () => {
  const token = await pair("Interrupted image"), c = await chat(token), route = `/v1/chats/${c.id}`;
  try {
    mode = "truncated";
    const response = await api("POST", route + "/messages", token, { attachments: [upload] });
    const stream = events(response.text);
    const accepted = stream.find(e => e.event === "sent").data.message;
    assert.ok(stream.some(e => e.event === "error"));
    assert.ok(!stream.some(e => e.event === "message"));
    assert.ok(!response.text.includes("data:image"));
    mode = "normal";
    const history = (await api("GET", route + "/messages", token)).json.messages;
    assert.deepEqual(history[0], accepted);
    assert.equal(history[1].text, "Partial text ");
    assert.equal(history[1].interrupted, true);
    assert.equal(history[1].pending, false);
    assert.deepEqual(history[1].attachments, []);
  } finally { mode = "normal"; }
});

test("malformed upstream history cannot purge previously confirmed media", async () => {
  const token = await pair("Bad upstream history"), c = await chat(token), route = `/v1/chats/${c.id}`;
  await api("POST", route + "/messages", token, { attachments: [upload] });
  const history = (await api("GET", route + "/messages", token)).json.messages;
  try {
    mode = "bad-history";
    assert.equal((await api("GET", route + "/media", token)).status, 502);
    assert.equal((await api("GET", `/v1/attachments/${history[0].attachments[0].id}`, token)).json.data, png);
  } finally { mode = "normal"; }
  assert.deepEqual((await api("GET", route + "/messages", token)).json.messages, history);
});

test("private history/gallery rechecks revoked authorization after upstream awaits", async () => {
  const token = await pair("Revoked during history"), c = await chat(token);
  await api("POST", `/v1/chats/${c.id}/messages`, token, { attachments: [upload] });
  let release, started;
  const promise = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  historyGate = { promise, started };
  const response = api("GET", `/v1/chats/${c.id}/media`, token);
  await waiting;
  const state = createStateStore({ directory: dataDir });
  try {
    state.mutate(s => {
      const user = Object.values(s.users).find(u => u.name === "Revoked during history");
      for (const d of Object.values(s.devices)) if (d.userId === user.id) d.revokedAt = Date.now();
    });
  } finally { state.close(); release(); }
  assert.equal((await response).status, 401);
});

test("private video-only sends and inline agent videos retain bytes, ownership, gallery order and stable reload IDs", async () => {
  const token = await pair("Video author"), outsider = await pair("Video outsider");
  const c = await chat(token), route = `/v1/chats/${c.id}`;
  try {
    mode = "video";
    const response = await api("POST", route + "/messages", token, { attachments: [videoUpload] });
    assert.equal(response.status, 200, response.text);
    const stream = events(response.text);
    const accepted = stream.find(e => e.event === "sent").data.message;
    const assistant = stream.find(e => e.event === "message").data;
    assert.equal(accepted.text, "");
    assert.equal(assistant.text, "A clip for you.");
    assert.match(turns.at(-1)[0].text, /have not received the video bytes/);
    assert.ok(!JSON.stringify(turns.at(-1)).includes(mp4));
    assert.equal(stream.filter(e => e.event === "delta").map(e => e.data.text).join(""), "A clip for you.\n\n");
    for (const message of [accepted, assistant]) {
      const file = message.attachments[0];
      assert.equal(file.mime, "video/mp4");
      assert.equal((await api("GET", `/v1/attachments/${file.id}`, token)).json.data, mp4);
      assert.equal((await api("GET", `/v1/attachments/${file.id}`, outsider)).status, 404);
    }
    for (let i = 0; i < 2; i++) assert.deepEqual((await api("GET", route + "/messages", token)).json.messages, [accepted, assistant]);
    const media = (await api("GET", route + "/media", token)).json.items;
    assert.deepEqual(media.map(file => file.messageId), [accepted.id, assistant.id]);
    assert.deepEqual(media.map(file => file.sender.agent || false), [false, true]);
    await api("DELETE", route, token);
    assert.equal((await api("GET", `/v1/attachments/${assistant.attachments[0].id}`, token)).status, 404);
  } finally { mode = "normal"; }
});

test("mixed photo/video channel and thread media keeps authenticated downloads and deletion behavior", async () => {
  const token = await pair("Mixed media author"), outsider = await pair("Mixed media outsider");
  const c = (await api("POST", "/v1/conversations", token, { name: "mixed-gallery", private: true })).json.conversation;
  const route = `/v1/conversations/${c.id}`;
  const root = (await api("POST", route + "/messages", token, { attachments: [upload, videoUpload] })).json.message;
  const reply = (await api("POST", route + "/messages", token, { threadRoot: root.id, attachments: [videoUpload] })).json.message;
  const media = (await api("GET", route + "/media", token)).json.items;
  assert.deepEqual(media.map(file => file.mime), ["image/png", "video/mp4", "video/mp4"]);
  assert.equal((await api("GET", `/v1/attachments/${reply.attachments[0].id}`, token)).json.data, mp4);
  assert.equal((await api("GET", `/v1/attachments/${reply.attachments[0].id}`, outsider)).status, 404);
  await api("DELETE", `/v1/messages/${reply.id}`, token);
  assert.equal((await api("GET", route + "/media", token)).json.items.length, 2);
  assert.equal((await api("GET", `/v1/attachments/${reply.attachments[0].id}`, token)).status, 404);
});
