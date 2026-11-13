// Full encrypted API + the separate agent worker, using synthetic local services.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { testFetch } from "./encrypted-test-client.mjs";
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-work-log-api-"));
Object.assign(process.env, { SERVANT_DATA_DIR: dir, SERVANT_PORT: "0", SERVANT_HOST: "127.0.0.1", SERVANT_WORKER_MODE: "external", SERVANT_PUSH_CONFIG: path.join(dir, "push.json") });
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
let server, worker, base, owner, member, mod;
let workerOutput = "";
const sessions = new Map();
const hermes = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const json = (status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  if (req.method === "POST" && req.url === "/api/sessions") {
    sessions.set(body.id, []);
    return json(201, { session: { id: body.id } });
  }
  const match = req.url.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
  const id = match && decodeURIComponent(match[1]);
  if (!sessions.has(id)) return json(404, {});
  if (req.method === "GET") return json(200, match[2] === "/messages" ? { data: sessions.get(id) } : { session: { id } });
  if (req.method !== "POST" || match[2] !== "/chat/stream") return json(404, {});
  const reply = /leave-open/.test(body.message) ? "I still need the example file." : "Finished the example follow-up.\n<servant-todo-done/>";
  sessions.get(id).push({ role: "user", content: body.message }, { role: "assistant", content: reply });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("run.started", {});
  emit("assistant.completed", { content: reply });
  // A final-looking message followed by a failed run must not count as completed work.
  if (/fail-after-reply/.test(body.message)) emit("error", { message: "Synthetic failed run" });
  else emit("run.completed", { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  emit("done", {}); res.end();
});
const config = { port: 0, name: "Example server", discovery: "off", defaultAgentTier: 3, upstreams: {} };
const saveConfig = () => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
async function api(method, route, person, body) {
  const response = await testFetch(dir, base + route, { method,
    headers: { "Content-Type": "application/json", ...(person ? { Authorization: `Bearer ${person.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function pair(role, name) {
  const result = await api("POST", "/v1/pair", null, { terms: { version: TERMS_VERSION, items: TERMS_ITEMS }, code: mod.createInvite({ name, role }), device: "Test browser" });
  assert.equal(result.status, 201);
  return result.body;
}
async function waitFor(check) {
  for (let n = 0; n < 200; n++) { const value = await check(); if (value) return value; await delay(50); }
  assert.fail(`Timed out waiting for worker: ${workerOutput.slice(-1000)}`);
}
const log = async person => (await api("GET", "/v1/work-log", person)).body.items;
before(async () => {
  await new Promise(resolve => hermes.listen(0, "127.0.0.1", resolve));
  config.upstreams.owner = { url: `http://127.0.0.1:${hermes.address().port}`, key: "test-key" };
  saveConfig();
  mod = await import("./server.mjs");
  server = await mod.startServer();
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await pair("owner", "Pat Tester");
  member = await pair("member", "Jo Park");
  worker = spawn(process.execPath, [fileURLToPath(new URL("./worker.mjs", import.meta.url))], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [worker.stdout, worker.stderr]) stream.on("data", chunk => { workerOutput = (workerOutput + chunk).slice(-4000); });
  await waitFor(() => workerOutput.includes("durable worker ready"));
});
after(async () => {
  if (worker?.exitCode === null) {
    worker.kill("SIGTERM");
    await Promise.race([new Promise(resolve => worker.once("exit", resolve)), delay(5000)]);
    if (worker.exitCode === null) worker.kill("SIGKILL");
  }
  await server?.shutdown();
  await new Promise(resolve => hermes.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("work log requires encrypted authentication and is private even from the server owner", async () => {
  assert.equal((await fetch(base + "/v1/work-log")).status, 426);
  assert.equal((await api("GET", "/v1/work-log")).status, 401);
  const made = await api("POST", "/v1/todos", member, { text: "Review the example notes" });
  assert.equal(made.status, 201);
  const done = await api("PATCH", `/v1/todos/${made.body.todo.id}`, member, { status: "done" });
  assert.equal(done.status, 200);
  const response = await api("GET", "/v1/work-log?userId=ignored", member);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.body.items[0].source.text, "Review the example notes");
  assert.deepEqual(response.body.items[0].completedBy, { kind: "person", id: member.user.id, name: member.user.name });
  assert.deepEqual(await log(owner), []);
  await api("PATCH", `/v1/todos/${made.body.todo.id}`, member, { status: "open" });
  await api("DELETE", `/v1/todos/${made.body.todo.id}`, member);
  const retained = (await log(member))[0];
  assert.ok(retained.reopenedAt !== null);
  assert.equal(retained.at, done.body.todo.doneAt);
  assert.equal(retained.source, null);
});

test("a separate Agent worker completes linked todos and records explicit provenance once", async () => {
  const made = (await api("POST", "/v1/todos", owner, { text: "Complete the example follow-up" })).body.todo;
  const sent = await api("POST", `/v1/todos/${made.id}/agent`, owner, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((await api("GET", `/v1/chats/${sent.body.chatId}`, member)).status, 404, "sending personal work to Agent keeps its chat private");
  const finished = await waitFor(async () => (await log(owner)).find(entry => entry.todoId === made.id));
  assert.deepEqual(finished.completedBy, { kind: "agent" });
  assert.equal(finished.source.text, made.text);
  assert.ok(finished.at >= made.createdAt);
  assert.equal((await log(member)).some(entry => entry.todoId === made.id), false);
  const todo = (await api("GET", `/v1/todos/${made.id}`, owner)).body.todo;
  assert.equal(todo.doneBy, "agent");
  await api("PATCH", `/v1/todos/${made.id}`, owner, { status: "done" });
  assert.equal((await log(owner)).filter(entry => entry.todoId === made.id).length, 1);
});

test("a response asking for more information leaves the todo open", async () => {
  const made = (await api("POST", "/v1/todos", owner, { text: "leave-open: wait for the example file" })).body.todo;
  const sent = (await api("POST", `/v1/todos/${made.id}/agent`, owner, {})).body;
  await waitFor(async () => (await api("GET", `/v1/chats/${sent.chatId}/turns`, owner)).body.turns?.some(turn => turn.status === "completed"));
  assert.equal((await log(owner)).some(entry => entry.todoId === made.id), false);
  assert.equal((await api("GET", `/v1/todos/${made.id}`, owner)).body.todo.status, "open");
});

test("a final-looking Agent reply followed by a failed run does not complete its todo", async () => {
  const made = (await api("POST", "/v1/todos", owner, { text: "fail-after-reply: example follow-up" })).body.todo;
  const sent = (await api("POST", `/v1/todos/${made.id}/agent`, owner, {})).body;
  await waitFor(async () => (await api("GET", `/v1/chats/${sent.chatId}/turns`, owner)).body.turns?.some(turn => turn.status === "failed"));
  assert.equal((await log(owner)).some(entry => entry.todoId === made.id), false);
  assert.equal((await api("GET", `/v1/todos/${made.id}`, owner)).body.todo.status, "open");
});

test("an uploaded recording joins the work log automatically, survives removal, and follows feature visibility", async () => {
  const created = await api("POST", "/v1/recordings", member, { size: 1, durationMs: 60000, ext: "webm" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id;
  await api("POST", `/v1/recordings/${id}/chunk`, member, { offset: 0, data: Buffer.from("x").toString("base64") });
  const finished = await api("POST", `/v1/recordings/${id}/finish`, member, { title: "Example planning meeting" });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  const event = (await log(member)).find(entry => entry.meetingId === id);
  assert.equal(event.meetingKind, "recording");
  assert.equal(event.source.title, "Example planning meeting");
  assert.equal(event.startedAt, null);
  assert.equal(event.endedAt, null);
  assert.equal(event.durationMs, 60000);
  assert.equal((await log(owner)).some(entry => entry.meetingId === id), false);
  config.features = { meetings: false }; saveConfig();
  assert.equal((await log(member)).some(entry => entry.meetingId === id), false);
  delete config.features; saveConfig();
  await api("DELETE", `/v1/recordings/${id}`, member);
  assert.deepEqual((await log(member)).find(entry => entry.meetingId === id), { ...event, source: null });
});

test("mixed history is ordered and hides current channel sources when the channel feature is off", async () => {
  const channel = (await api("POST", "/v1/conversations", owner, { name: "example-work", memberIds: [member.user.id] })).body.conversation;
  const message = (await api("POST", `/v1/conversations/${channel.id}/messages`, owner, { text: "Review the example delivery" })).body.message;
  await api("POST", `/v1/saved-messages/${message.id}`, member, {});
  await api("PATCH", `/v1/saved-messages/${message.id}`, member, { completed: true, note: "Review finished" });
  // Attendance collection is exercised with actual peers in meetings.test.mjs.
  const db = new DatabaseSync(path.join(dir, "meetings", "meetings.db"));
  const endedAt = Date.now();
  try {
    db.prepare("INSERT INTO meetings(id,conversation_id,started_by,started_at,ended_at,status,title) VALUES(?,?,?,?,?,'done',?)")
      .run("meet_example", channel.id, owner.user.id, endedAt - 60000, endedAt, "Example review call");
    db.prepare("INSERT INTO meeting_work_log(meeting_id,user_id,started_at,ended_at,duration_ms) VALUES(?,?,?,?,?)")
      .run("meet_example", member.user.id, endedAt - 60000, endedAt, 60000);
  } finally { db.close(); }
  const entries = await log(member);
  assert.ok(entries.some(entry => entry.kind === "saved" && entry.completion.note === "Review finished"));
  assert.equal(entries.find(entry => entry.meetingId === "meet_example").source.title, "Example review call");
  assert.deepEqual(entries.map(entry => entry.at), entries.map(entry => entry.at).sort((a, b) => b - a));
  assert.equal((await log(owner)).some(entry => entry.meetingId === "meet_example"), false, "hosting alone is not attendance");
  config.features = { channels: false }; saveConfig();
  try {
    const hidden = await log(member);
    assert.equal(hidden.find(entry => entry.meetingId === "meet_example").source, null);
    assert.equal(hidden.find(entry => entry.kind === "saved" && entry.completion.messageId === message.id).completion.message, null);
  } finally { delete config.features; saveConfig(); }
});
