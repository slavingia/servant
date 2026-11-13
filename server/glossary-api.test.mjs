// Real authenticated encrypted HTTP requests, with a disposable server and no agent calls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { testFetch } from "./encrypted-test-client.mjs";
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";
import { ensureRecordsSchema, listPreserved } from "./records-preserve.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-glossary-api-"));
process.env.SERVANT_DATA_DIR = dir;
process.env.SERVANT_PORT = "0";
process.env.SERVANT_HOST = "127.0.0.1";
let mod, server, base, owner, writer, reader, outsider, project;
const config = { port: 0, name: "Test server", upstreams: {} };
const saveConfig = () => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
const payload = { abbreviation: "QA", fullName: "Quality assurance", description: "Checks that the app works", history: "Added for the first release", wikiUrl: "https://example.gov/wiki/qa", repo: "example-org/example-app" };
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
  writer = await pair("member", "Jo Park");
  reader = await pair("member", "Ana Ruiz");
  outsider = await pair("member", "Other Tester");
  const created = await api("POST", "/v1/projects", owner, { name: "Example app", repo: "example-org/example-app" });
  assert.equal(created.status, 200);
  project = created.body.project;
  for (const [person, level] of [[writer, "write"], [reader, "read"]]) {
    const added = await api("POST", `/v1/projects/${project.id}/people`, owner, { userId: person.user.id, level });
    assert.equal(added.status, 200, JSON.stringify(added.body));
  }
});
after(async () => { await server?.shutdown(); fs.rmSync(dir, { force: true, recursive: true }); });

test("encrypted glossary API enforces project membership and writer permissions", async () => {
  const route = `/v1/projects/${project.id}/glossary`;
  assert.equal((await fetch(base + route)).status, 426, "plaintext is still rejected");
  assert.equal((await api("GET", route)).status, 401);
  assert.equal((await api("GET", route, outsider)).status, 404);
  assert.equal((await api("POST", route, outsider, payload)).status, 404);
  assert.equal((await api("POST", route, reader, payload)).status, 403);
  const made = await api("POST", route, writer, payload);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const item = `${route}/${made.body.entry.id}`;
  const listed = await api("GET", route, reader);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.canWrite, false);
  assert.equal(listed.body.projectRepo, "example-org/example-app");
  assert.equal(listed.body.entries[0].wikiUrl, payload.wikiUrl);
  assert.equal(listed.body.entries[0].history, payload.history);
  assert.equal((await api("GET", route, owner)).body.canWrite, true);
  assert.equal((await api("PATCH", item, reader, { fullName: "Changed" })).status, 403);
  assert.equal((await api("DELETE", item, reader)).status, 403);
  assert.equal((await api("PATCH", item, outsider, { fullName: "Changed" })).status, 404);
  const changed = await api("PATCH", item, writer, { history: "Updated from the wiki" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.entry.history, "Updated from the wiki");
  assert.equal((await api("POST", route, writer, payload)).status, 409);
  assert.equal((await api("POST", route, writer, { ...payload, wikiUrl: "javascript:alert(1)" })).status, 400);
  assert.equal((await api("POST", route, writer, null)).status, 400);
  assert.equal((await api("DELETE", item, writer)).status, 200);
  assert.deepEqual((await api("GET", route, reader)).body.entries, []);
  assert.equal((await api("PATCH", item, writer, { fullName: "Gone" })).status, 404);
});

test("project access revocation takes effect for glossary reads and writes", async () => {
  const route = `/v1/projects/${project.id}/glossary`;
  const made = await api("POST", route, writer, payload);
  assert.equal(made.status, 201);
  assert.equal((await api("DELETE", `/v1/projects/${project.id}/people/${writer.user.id}`, owner)).status, 200);
  assert.equal((await api("GET", route, writer)).status, 404);
  assert.equal((await api("PATCH", `${route}/${made.body.entry.id}`, writer, { description: "Forbidden" })).status, 404);
  assert.equal((await api("DELETE", `${route}/${made.body.entry.id}`, writer)).status, 404);
  assert.equal((await api("GET", route, owner)).body.entries[0].description, payload.description);
  assert.equal((await api("DELETE", `${route}/${made.body.entry.id}`, owner)).status, 200);
});

test("records-enabled HTTP edits fail closed and preserve old glossary details", async () => {
  config.recordsPreservation = { enabled: true }; saveConfig();
  const route = `/v1/projects/${project.id}/glossary`;
  const made = await api("POST", route, owner, payload);
  assert.equal(made.status, 201);
  const item = `${route}/${made.body.entry.id}`;
  const db = new DatabaseSync(path.join(dir, "messages.db"));
  try {
    ensureRecordsSchema(db);
    db.exec("CREATE TRIGGER glossary_api_archive_fail BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT, 'archive unavailable'); END;");
    const failed = await api("PATCH", item, owner, { description: "Unsaved description" });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, "records_preservation_failed");
    assert.equal((await api("DELETE", item, owner)).status, 503);
    assert.equal((await api("GET", route, reader)).body.entries[0].description, payload.description);
    db.exec("DROP TRIGGER glossary_api_archive_fail;");
    assert.equal((await api("PATCH", item, owner, { description: "Updated description" })).status, 200);
    assert.equal((await api("DELETE", item, owner)).status, 200);
    const records = listPreserved(db).filter(row => row.event.startsWith("glossary_"));
    assert.equal(records.length, 2);
    assert.equal(records[0].detail.entry.description, payload.description);
    assert.equal(records[1].detail.entry.description, "Updated description");
  } finally { db.close(); delete config.recordsPreservation; saveConfig(); }
});

test("a recreated project with the same slug cannot expose its predecessor's glossary", async () => {
  const route = `/v1/projects/${project.id}/glossary`;
  assert.equal((await api("POST", route, owner, payload)).status, 201);
  assert.equal((await api("DELETE", `/v1/projects/${project.id}`, owner)).status, 200);
  assert.equal((await api("GET", route, owner)).status, 404);
  const recreated = await api("POST", "/v1/projects", owner, { name: "Example app" });
  assert.equal(recreated.body.project.id, project.id);
  assert.notEqual(recreated.body.project.createdAt, project.createdAt);
  assert.deepEqual((await api("GET", route, owner)).body.entries, []);
});
