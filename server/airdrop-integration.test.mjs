// AirDrop end to end: through the encrypted transport, the owner's chunks land in AIRDROP_DIR and a member is refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";

const ACCEPT = { version: TERMS_VERSION, items: TERMS_ITEMS };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-airdrop-api-"));
const dropDir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-airdrop-desk-"));
process.env.SERVANT_DATA_DIR = dataDir;
process.env.AIRDROP_DIR = dropDir;
let server, base, mod;

before(async () => {
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ port: 0, name: "AirDrop test", agentName: "Hermes" }));
  mod = await import("./server.mjs");
  server = await mod.startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await server.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(dropDir, { recursive: true, force: true });
});

async function api(method, route, token, body) {
  const res = await testFetch(dataDir, base + route, { method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}
async function pair(name, role) {
  const response = await api("POST", "/v1/pair", undefined, { terms: ACCEPT, code: mod.createInvite({ name, role }), device: "AirDrop test" });
  assert.equal(response.status, 201, response.text);
  return response.json.token;
}

test("the owner's file lands in the AirDrop folder; a member is refused", async () => {
  const owner = await pair("Owner", "owner"), member = await pair("Member", "member");
  const folder = await api("GET", "/v1/airdrop", owner);
  assert.equal(folder.status, 200, folder.text);
  assert.equal(typeof folder.json.folder, "string");

  const bytes = Buffer.from("hello from the phone, in two pieces");
  const start = await api("POST", "/v1/airdrop", owner, { name: "../notes.txt", size: bytes.length });
  assert.equal(start.status, 201, start.text);
  const id = start.json.id;
  const first = await api("POST", `/v1/airdrop/${id}`, owner, { offset: 0, data: bytes.subarray(0, 10).toString("base64") });
  assert.equal(first.status, 200, first.text);
  const last = await api("POST", `/v1/airdrop/${id}`, owner, { offset: 10, data: bytes.subarray(10).toString("base64") });
  assert.equal(last.status, 200, last.text);
  assert.equal(last.json.saved, "notes.txt");
  assert.equal(fs.readFileSync(path.join(dropDir, "notes.txt"), "utf8"), bytes.toString());

  assert.equal((await api("GET", "/v1/airdrop", member)).status, 403);
  assert.equal((await api("POST", "/v1/airdrop", member, { name: "x.txt", size: 1 })).status, 403);
  assert.deepEqual(fs.readdirSync(dropDir), ["notes.txt"]);
});
