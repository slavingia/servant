// Real encrypted API and disposable SQLite; no agent or live services.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { testFetch } from "./encrypted-test-client.mjs";
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";
import { ensureRecordsSchema, listPreserved } from "./records-preserve.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-shortcuts-api-"));
process.env.SERVANT_DATA_DIR = dir;
process.env.SERVANT_PORT = "0";
process.env.SERVANT_HOST = "127.0.0.1";
let mod, server, base, owner, member, other, entry;
const config = { port: 0, name: "Test server", discovery: "off", upstreams: {} };
const saveConfig = () => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
const payload = { abbreviation: "omw", fullName: "On my way!" };
async function api(method, route, person, body) {
  const response = await testFetch(dir, base + route, { method,
    headers: { "Content-Type": "application/json", ...(person ? { Authorization: `Bearer ${person.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function pair(role, name) {
  const result = await api("POST", "/v1/pair", null, { terms: { version: TERMS_VERSION, items: TERMS_ITEMS }, code: mod.createInvite({ name, role }), device: "Test browser" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}
before(async () => {
  saveConfig();
  mod = await import("./server.mjs");
  server = await mod.startServer();
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await pair("owner", "Pat Tester");
  member = await pair("member", "Jo Park");
  other = await pair("member", "Ana Ruiz");
});
after(async () => { await server?.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test("encrypted shortcut API allows members to contribute and author or owner to edit", async () => {
  assert.equal((await fetch(base + "/v1/lexicon")).status, 426);
  assert.equal((await api("GET", "/v1/lexicon")).status, 401);
  assert.equal((await api("POST", "/v1/lexicon", null, payload)).status, 401);
  const created = await api("POST", "/v1/lexicon", member, payload);
  assert.equal(created.status, 201);
  entry = created.body.entry;
  assert.equal(entry.canEdit, true);
  assert.deepEqual(Object.keys(entry).sort(), ["abbreviation", "canEdit", "createdAt", "fullName", "id", "updatedAt"]);
  const listed = await api("GET", "/v1/lexicon", other);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.canWrite, true);
  assert.equal(listed.body.entries[0].canEdit, false);
  const repeated = await api("POST", "/v1/lexicon", other, { abbreviation: " OMW ", fullName: " On my way! " });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.body.entry.id, entry.id);
  assert.equal(repeated.body.entry.canEdit, false);
  assert.equal((await api("POST", "/v1/lexicon", other, { ...payload, fullName: "Different text" })).status, 409);
  const route = `/v1/lexicon/${entry.id}`;
  assert.equal((await api("PATCH", route, other, { fullName: "Forbidden" })).status, 403);
  assert.equal((await api("DELETE", route, other)).status, 403);
  assert.equal((await api("PATCH", route, member, { fullName: "I'll be there soon." })).status, 200);
  assert.equal((await api("PATCH", route, owner, { fullName: "On my way!" })).status, 200);
  assert.equal((await api("POST", "/v1/lexicon", member, { ...payload, description: "Not supported" })).status, 400);
  assert.equal((await api("POST", "/v1/lexicon", member, null)).status, 400);
  assert.equal((await api("GET", "/v1/lexicon/stats", member)).status, 404);
});

test("shared API never exposes existing private project glossary content", async () => {
  const project = (await api("POST", "/v1/projects", owner, { name: "Example app" })).body.project;
  assert.equal((await api("POST", `/v1/projects/${project.id}/glossary`, owner, { abbreviation: "API", fullName: "Project interface", history: "Private project context" })).status, 201);
  const listed = (await api("GET", "/v1/lexicon", other)).body.entries;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].abbreviation, "omw");
});

test("HTTP shortcut changes fail closed when records cannot be archived", async () => {
  config.recordsPreservation = { enabled: true }; saveConfig();
  const made = (await api("POST", "/v1/lexicon", other, { abbreviation: "brb", fullName: "Be right back." })).body.entry;
  const route = `/v1/lexicon/${made.id}`;
  const db = new DatabaseSync(path.join(dir, "messages.db"));
  try {
    ensureRecordsSchema(db);
    db.exec("CREATE TRIGGER shortcut_http_archive_fail BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT,'archive unavailable'); END;");
    assert.equal((await api("PATCH", route, other, { fullName: "Lost" })).status, 503);
    assert.equal((await api("DELETE", route, owner)).status, 503);
    assert.equal((await api("GET", "/v1/lexicon", member)).body.entries.find(value => value.id === made.id).fullName, "Be right back.");
    db.exec("DROP TRIGGER shortcut_http_archive_fail");
    assert.equal((await api("PATCH", route, other, { fullName: "Back soon." })).status, 200);
    assert.equal((await api("DELETE", route, owner)).status, 200);
    const records = listPreserved(db).filter(record => record.event.startsWith("lexicon_"));
    assert.deepEqual(records.map(record => record.detail.entry.fullName), ["Be right back.", "Back soon."]);
  } finally { db.close(); delete config.recordsPreservation; saveConfig(); }
});

// The sender is not asked about an abbreviation nobody has defined: the server adds Agent's guess and a to-do.
test("an undefined abbreviation gets Agent's guess and a to-do for the sender, finished when someone keeps or fixes it", async () => {
  const asked = [];
  globalThis.__servantLexiconAsk = async (system, text) => { asked.push(text); return JSON.stringify({ PTO: "Paid time off" }); };
  try {
    const learned = await api("POST", "/v1/lexicon/learn", other, { terms: ["PTO", "XYZ"], text: "PTO starts Monday, see XYZ" });
    assert.equal(learned.status, 200, JSON.stringify(learned.body));
    assert.deepEqual(learned.body.entries.map(value => [value.abbreviation, value.fullName, value.guessed, value.canEdit]), [["PTO", "Paid time off", true, true]]);
    assert.equal(learned.body.todos, 2);
    assert.match(asked[0], /PTO starts Monday, see XYZ[\s\S]*Abbreviations: PTO, XYZ$/);
    const guess = learned.body.entries[0];
    // In everyone's list, marked as a guess, and anyone may correct it.
    const listed = (await api("GET", "/v1/lexicon", owner)).body.entries.find(value => value.id === guess.id);
    assert.deepEqual([listed.guessed, listed.canEdit], [true, true]);
    const open = async person => (await api("GET", "/v1/todos", person)).body.todos.map(todo => todo.text);
    assert.deepEqual((await open(other)).filter(text => /PTO|XYZ/.test(text)).sort(), [
      "Add what XYZ stands for in Wiki, Abbreviations.",
      'Check what PTO stands for. Agent guessed "Paid time off". Keep it or fix it in Wiki, Abbreviations.',
    ]);
    // Sending the same message again raises nothing new.
    const again = await api("POST", "/v1/lexicon/learn", other, { terms: ["PTO", "XYZ"], text: "PTO starts Monday, see XYZ" });
    assert.deepEqual([again.body.entries, again.body.todos], [[], 0]);
    // The sender keeps the guess: it is theirs now, no longer a guess, and their to-do is done.
    const kept = await api("PATCH", `/v1/lexicon/${guess.id}`, other, { fullName: "Paid time off" });
    assert.deepEqual([kept.status, kept.body.entry.guessed], [200, undefined]);
    assert.deepEqual((await open(other)).filter(text => /PTO/.test(text)), []);
    // Adding the one Agent could not guess finishes that to-do too.
    assert.equal((await api("POST", "/v1/lexicon", other, { abbreviation: "XYZ", fullName: "Example zone" })).status, 201);
    assert.deepEqual((await open(other)).filter(text => /XYZ/.test(text)), []);
    assert.equal((await api("POST", "/v1/lexicon/learn", null, { terms: ["ABC"], text: "ABC" })).status, 401);
    assert.equal((await api("POST", "/v1/lexicon/learn", other, { terms: [], text: "ABC" })).status, 400);
  } finally { delete globalThis.__servantLexiconAsk; }
});

test("removed members lose shortcut access and an owner can maintain their entries", async () => {
  assert.equal((await api("DELETE", `/v1/people/${member.user.id}`, owner)).status, 200);
  assert.equal((await api("GET", "/v1/lexicon", member)).status, 401);
  assert.equal((await api("POST", "/v1/lexicon", member, payload)).status, 401);
  assert.equal((await api("PATCH", `/v1/lexicon/${entry.id}`, member, { fullName: "Denied" })).status, 401);
  assert.equal((await api("DELETE", `/v1/lexicon/${entry.id}`, member)).status, 401);
  assert.equal((await api("PATCH", `/v1/lexicon/${entry.id}`, owner, { fullName: "Maintained by owner" })).status, 200);
});

test("one workspace setting adds everyday shorthand to the list, read only, without overriding shared shortcuts", async () => {
  const before = (await api("GET", "/v1/lexicon", other)).body.entries;
  assert.equal(before.some(item => item.builtIn), false);
  assert.equal((await api("POST", "/v1/lexicon", other, { abbreviation: "BTW", fullName: "Our own meaning" })).status, 201);
  config.expandColloquialisms = true; saveConfig();
  try {
    const listed = (await api("GET", "/v1/lexicon", other)).body.entries;
    const tmmrw = listed.find(item => item.abbreviation === "tmmrw");
    assert.equal(tmmrw.fullName, "tomorrow");
    assert.equal(tmmrw.canEdit, false);
    assert.equal(tmmrw.builtIn, true);
    assert.deepEqual(listed.filter(item => item.abbreviation.toUpperCase() === "BTW").map(item => item.fullName), ["Our own meaning"]);
    assert.equal(listed.length, before.length + 1 + listed.filter(item => item.builtIn).length);
  } finally { delete config.expandColloquialisms; saveConfig(); }
  assert.equal((await api("GET", "/v1/lexicon", other)).body.entries.some(item => item.builtIn), false);
});

test("guess endpoint needs sign-in, validates, and returns no guesses without an agent", async () => {
  assert.equal((await api("POST", "/v1/lexicon/guess", null, { terms: ["PTO"], text: "PTO Friday" })).status, 401);
  assert.equal((await api("POST", "/v1/lexicon/guess", owner, { terms: [], text: "x" })).status, 400);
  const result = await api("POST", "/v1/lexicon/guess", owner, { terms: ["PTO"], text: "PTO Friday" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { guesses: {} });
});
