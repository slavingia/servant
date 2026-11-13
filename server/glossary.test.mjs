import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanGlossaryEntry, createGlossaryStore, GLOSSARY_LIMITS, MAX_GLOSSARY_ENTRIES } from "./glossary.mjs";
import { ensureRecordsSchema, listPreserved, verifyChain } from "./records-preserve.mjs";

const project = { id: "example-app", name: "Example app", createdAt: 1 };
const entry = { abbreviation: "API", fullName: "Application programming interface", description: "A way for programs to talk", history: "Introduced with the first release", wikiUrl: "https://example.gov/wiki/api", repo: "example-org/example-app" };
const status = expected => error => error.status === expected;
function fixture(t, keepRecords = () => false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-glossary-"));
  const file = path.join(dir, "messages.db");
  const store = createGlossaryStore({ file, keepRecords });
  t.after(() => { store.close(); fs.rmSync(dir, { force: true, recursive: true }); });
  return { store, file };
}

test("glossary saves full details, supports distinct meanings, and persists across connections", t => {
  const { store, file } = fixture(t);
  const first = store.create(project, { ...entry, abbreviation: " api ", repo: "https://github.com/example-org/example-app.git" }, "usr_writer", 10);
  assert.equal(first.abbreviation, "API");
  assert.equal(first.repo, "example-org/example-app");
  assert.equal(first.history, entry.history);
  assert.equal(first.createdAt, 10);
  store.create(project, { abbreviation: "API", fullName: "Another project interface" }, "usr_writer", 11);
  assert.throws(() => store.create(project, { abbreviation: "api", fullName: " Application   programming INTERFACE " }, "usr_writer"), status(409));
  const second = createGlossaryStore({ file });
  try {
    assert.equal(second.list(project).length, 2);
    const updated = second.update(project, first.id, { description: "Updated description" }, "usr_writer", 12);
    assert.equal(updated.updatedAt, 12);
    assert.equal(updated.createdAt, 10);
    assert.equal(store.list(project).find(item => item.id === first.id).description, "Updated description");
    second.remove(project, first.id, "usr_writer");
    assert.equal(store.list(project).length, 1);
  } finally { second.close(); }
});

test("glossary project boundaries and new generations never reuse another project's records", t => {
  const { store } = fixture(t);
  const first = store.create(project, entry, "usr_writer");
  const other = { id: "prototypes", createdAt: 1 };
  const replacement = { ...project, createdAt: 2 };
  for (const inaccessible of [other, replacement]) {
    assert.deepEqual(store.list(inaccessible), []);
    assert.throws(() => store.update(inaccessible, first.id, { fullName: "Changed" }, "usr_writer"), status(404));
    assert.throws(() => store.remove(inaccessible, first.id, "usr_writer"), status(404));
  }
  assert.equal(store.list(project).length, 1);
});

test("glossary rejects invalid fields and unsafe links without truncating or guessing", () => {
  for (const body of [null, [], "API", {}, { abbreviation: "API" }, { fullName: "Full" }, { ...entry, abbreviation: "two words" }, { ...entry, description: 123 }, { ...entry, unexpected: true }, { ...entry, history: "bad\u0000text" }]) {
    assert.throws(() => cleanGlossaryEntry(body), status(400));
  }
  for (const wikiUrl of ["http://example.gov/wiki", "javascript:alert(1)", "https://name:password@example.gov/wiki", "https://example.gov/a b", "/relative", "not-a-link"]) {
    assert.throws(() => cleanGlossaryEntry({ ...entry, wikiUrl }), status(400));
  }
  for (const repo of ["../example-app", "example-org/../secret", "https://example.gov/repo", "example-org", "example-org/example-app?token=secret"]) {
    assert.throws(() => cleanGlossaryEntry({ ...entry, repo }), status(400));
  }
  for (const [key, max] of Object.entries(GLOSSARY_LIMITS)) {
    assert.throws(() => cleanGlossaryEntry({ ...entry, [key]: "x".repeat(max + 1) }), status(413));
  }
  assert.equal(cleanGlossaryEntry({ abbreviation: "ci/cd", fullName: "Continuous delivery" }).abbreviation, "CI/CD");
  assert.throws(() => cleanGlossaryEntry({}, entry), status(400));
});

test("glossary bounds the number of entries per project and rejects duplicate edits", t => {
  const { store } = fixture(t);
  const first = store.create(project, entry, "usr_writer");
  const second = store.create(project, { ...entry, fullName: "Alternate interface" }, "usr_writer");
  assert.throws(() => store.update(project, second.id, { fullName: entry.fullName }, "usr_writer"), status(409));
  for (let n = 2; n < MAX_GLOSSARY_ENTRIES; n++) store.create(project, { abbreviation: `T${n}`, fullName: `Term ${n}` }, "usr_writer");
  assert.throws(() => store.create(project, { abbreviation: "EXTRA", fullName: "Too many" }, "usr_writer"), status(409));
  store.remove(project, first.id, "usr_writer");
  store.create(project, { abbreviation: "EXTRA", fullName: "Fits now" }, "usr_writer");
  assert.equal(store.list(project).length, MAX_GLOSSARY_ENTRIES);
});

test("glossary edits and deletes preserve original content in the shared records archive", t => {
  let enabled = false;
  const { store, file } = fixture(t, () => enabled);
  const first = store.create(project, entry, "usr_author", 10);
  store.update(project, first.id, { history: "Revision before preservation was on" }, "usr_writer", 11);
  enabled = true;
  store.update(project, first.id, { history: "New history" }, "usr_writer", 12);
  store.remove(project, first.id, "usr_writer");
  const db = new DatabaseSync(file);
  try {
    const rows = listPreserved(db);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].event, "glossary_entry_edited");
    assert.equal(rows[0].detail.entry.history, "Revision before preservation was on");
    assert.equal(rows[0].author_id, "usr_author");
    assert.equal(rows[0].actor_id, "usr_writer");
    assert.equal(rows[1].event, "glossary_entry_deleted");
    assert.equal(rows[1].detail.entry.history, "New history");
    assert.equal(verifyChain(db).ok, true);
    assert.deepEqual(store.list(project), []);
  } finally { db.close(); }
});

test("a failed archive refuses edits and deletes, while a failed mutation rolls back its archive", t => {
  const { store, file } = fixture(t, () => true);
  const first = store.create(project, entry, "usr_author", 10);
  const db = new DatabaseSync(file);
  try {
    ensureRecordsSchema(db);
    db.exec("CREATE TRIGGER glossary_archive_fail BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
    assert.throws(() => store.update(project, first.id, { history: "Lost" }, "usr_writer"), error => error.code === "records_preservation_failed");
    assert.throws(() => store.remove(project, first.id, "usr_writer"), error => error.code === "records_preservation_failed");
    assert.deepEqual(store.list(project), [first]);
    assert.deepEqual(listPreserved(db), []);
    db.exec("DROP TRIGGER glossary_archive_fail; CREATE TRIGGER glossary_update_fail BEFORE UPDATE ON project_glossary BEGIN SELECT RAISE(ABORT, 'write failure'); END;");
    assert.throws(() => store.update(project, first.id, { history: "Lost" }, "usr_writer"), /write failure/);
    assert.deepEqual(store.list(project), [first]);
    assert.deepEqual(listPreserved(db), [], "copy and mutation must be in the same transaction");
  } finally { db.close(); }
});
