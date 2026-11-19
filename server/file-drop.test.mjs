// File drop through the real encrypted API: owner only, off unless a folder is set, and a file never replaces another.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";
import { createFileDrop, dropName, numberedName } from "./file-drop.mjs";
import { DOCUMENT_CHUNK } from "./documents.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-file-drop-"));
const folder = path.join(dir, "Desktop");
fs.mkdirSync(folder);
process.env.SERVANT_DATA_DIR = path.join(dir, "data");
fs.mkdirSync(process.env.SERVANT_DATA_DIR);
process.env.SERVANT_PORT = "0";
process.env.SERVANT_HOST = "127.0.0.1";
delete process.env.SERVANT_FILE_DROP_DIR;
let mod, server, base, owner, member;
const config = { port: 0, name: "Test server", discovery: "off", upstreams: {} };
const saveConfig = () => fs.writeFileSync(path.join(process.env.SERVANT_DATA_DIR, "config.json"), JSON.stringify(config));
async function api(method, route, person, body) {
  const response = await testFetch(process.env.SERVANT_DATA_DIR, base + route, { method,
    headers: { "Content-Type": "application/json", ...(person ? { Authorization: `Bearer ${person.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function pair(role, name) {
  const result = await api("POST", "/v1/pair", null, { terms: { version: TERMS_VERSION, items: TERMS_ITEMS }, code: mod.createInvite({ name, role }), device: "Test browser" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}
const b64 = buffer => buffer.toString("base64");
async function drop(person, name, bytes) {
  const created = await api("POST", "/v1/file-drop", person, { name, size: bytes.length });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let offset = 0, last;
  while (offset < bytes.length) {
    last = await api("POST", `/v1/file-drop/${created.body.id}`, person, { offset, data: b64(bytes.subarray(offset, offset + DOCUMENT_CHUNK)) });
    assert.equal(last.status, 200, JSON.stringify(last.body));
    offset = last.body.received;
  }
  return { id: created.body.id, ...last.body };
}
before(async () => {
  saveConfig();
  mod = await import("./server.mjs");
  server = await mod.startServer();
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await pair("owner", "Pat Tester");
  member = await pair("member", "Jo Park");
});
after(async () => { await server?.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test("file drop is off until the server names a folder, and is never offered to a member", async () => {
  assert.equal((await api("GET", "/v1/file-drop")).status, 401);
  assert.equal((await api("GET", "/v1/me", owner)).body.fileDrop, undefined);
  const off = await api("POST", "/v1/file-drop", owner, { name: "plan.pdf", size: 4 });
  assert.deepEqual([off.status, off.body.error?.code ?? off.body.code], [404, "file_drop_off"]);
  config.fileDrop = { dir: folder }; saveConfig();
  assert.equal((await api("GET", "/v1/me", owner)).body.fileDrop, true);
  assert.equal((await api("GET", "/v1/me", member)).body.fileDrop, undefined);
  assert.equal((await api("GET", "/v1/file-drop", owner)).body.enabled, true);
  for (const [method, route, body] of [["GET", "/v1/file-drop"], ["POST", "/v1/file-drop", { name: "plan.pdf", size: 4 }], ["POST", "/v1/file-drop/upl_AAAAAAAAAAAAAAAA", { offset: 0, data: "AAAA" }]]) {
    assert.equal((await api(method, route, member, body)).status, 403, `${method} ${route}`);
  }
  assert.deepEqual(fs.readdirSync(folder), []);
});

test("the owner's dropped file lands in the folder whole, and a second one with the same name sits beside it", async () => {
  const bytes = Buffer.alloc(DOCUMENT_CHUNK + 4321, 5);
  const first = await drop(owner, "Launch plan.pdf", bytes);
  assert.equal(first.saved, "Launch plan.pdf");
  assert.deepEqual(fs.readFileSync(path.join(folder, "Launch plan.pdf")), bytes);
  // The last chunk sent again (a dropped connection) answers the same and adds nothing.
  const again = await api("POST", `/v1/file-drop/${first.id}`, owner, { offset: DOCUMENT_CHUNK, data: b64(bytes.subarray(DOCUMENT_CHUNK)) });
  assert.deepEqual([again.status, again.body.saved], [200, "Launch plan.pdf"]);
  const second = await drop(owner, "Launch plan.pdf", Buffer.from("newer"));
  assert.equal(second.saved, "Launch plan 2.pdf");
  assert.deepEqual(fs.readFileSync(path.join(folder, "Launch plan.pdf")), bytes, "the first file is untouched");
  assert.deepEqual(fs.readdirSync(folder).sort(), ["Launch plan 2.pdf", "Launch plan.pdf"]);
});

test("a name can't leave the folder or hide, and a missing folder is said plainly", async () => {
  const escaped = await drop(owner, "../../.zshrc", Buffer.from("x"));
  assert.equal(escaped.saved, "__.._.zshrc");
  assert.ok(fs.existsSync(path.join(folder, escaped.saved)));
  assert.equal(fs.existsSync(path.join(dir, ".zshrc")), false);
  assert.equal((await api("POST", "/v1/file-drop", owner, { name: "  ", size: 1 })).status, 400);
  config.fileDrop = { dir: path.join(dir, "Missing") }; saveConfig();
  const missing = await api("POST", "/v1/file-drop", owner, { name: "a.txt", size: 1 });
  assert.equal(missing.status, 409);
  assert.match(JSON.stringify(missing.body), /folder on the server is missing/);
  assert.equal(fs.existsSync(path.join(dir, "Missing")), false, "the server never makes the folder itself");
  config.fileDrop = { dir: "Desktop" }; saveConfig();
  assert.equal((await api("POST", "/v1/file-drop", owner, { name: "a.txt", size: 1 })).status, 404, "a relative folder leaves it off");
});

test("names: cleaned for one folder, numbered like a second copy", () => {
  assert.equal(dropName("a/b\\c:d.txt"), "a_b_c_d.txt");
  assert.equal(dropName(".env"), "_env");
  assert.equal(dropName(""), "");
  assert.equal(numberedName("plan.pdf", 1), "plan.pdf");
  assert.equal(numberedName("plan.pdf", 3), "plan 3.pdf");
  assert.equal(numberedName("README", 2), "README 2");
});

test("one person's upload can't be finished by another", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "servant-file-drop-unit-"));
  const out = path.join(scratch, "out"); fs.mkdirSync(out);
  const store = createFileDrop({ directory: path.join(scratch, "wait"), folder: () => out });
  const { id } = store.create({ id: "u1" }, { name: "a.txt", size: 2 });
  assert.throws(() => store.append({ id: "u2" }, id, { offset: 0, data: b64(Buffer.from("hi")) }), e => e.status === 404);
  assert.equal(store.append({ id: "u1" }, id, { offset: 0, data: b64(Buffer.from("hi")) }).saved, "a.txt");
  fs.rmSync(scratch, { recursive: true, force: true });
});
