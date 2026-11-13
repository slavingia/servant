import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanLexiconEntry, createLexiconStore, LEXICON_LIMITS, MAX_LEXICON_ENTRIES } from "./lexicon.mjs";
import { createGlossaryStore } from "./glossary.mjs";
import { ensureRecordsSchema, listPreserved, verifyChain } from "./records-preserve.mjs";

const owner = { id: "owner", role: "owner" };
const author = { id: "author", role: "member" };
const other = { id: "other", role: "member" };
const shortcut = { abbreviation: "omw", fullName: "On my way!" };
const status = value => error => error.status === value;
function fixture(t, keepRecords = () => false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-shortcuts-"));
  const file = path.join(dir, "messages.db");
  const store = createLexiconStore({ file, keepRecords });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { file, store };
}

test("shared shortcuts persist with one value per key and author or owner editing", t => {
  const { store, file } = fixture(t);
  const first = store.create(shortcut, author, 1);
  assert.equal(first.abbreviation, "omw", "retain the key's entered casing");
  assert.equal(first.canEdit, true);
  assert.deepEqual(Object.keys(first).sort(), ["abbreviation", "canEdit", "createdAt", "fullName", "id", "updatedAt"]);
  const repeated = store.create({ abbreviation: " OMW ", fullName: " On my way! " }, other, 2);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.canEdit, false);
  assert.equal(repeated.updatedAt, 1);
  assert.throws(() => store.create({ ...shortcut, fullName: "A different value" }, other), status(409));
  assert.throws(() => store.create({ ...shortcut, fullName: "on my way!" }, other), status(409), "replacement casing is meaningful");
  assert.throws(() => store.update(first.id, { fullName: "Denied" }, other), status(403));
  assert.throws(() => store.remove(first.id, other), status(403));
  assert.equal(store.list(owner)[0].canEdit, true);
  const changed = store.update(first.id, { fullName: "I'll be there soon." }, author, 3);
  assert.equal(changed.createdAt, 1);
  assert.equal(changed.updatedAt, 3);
  const connection = createLexiconStore({ file });
  try {
    assert.equal(connection.list(other)[0].fullName, "I'll be there soon.");
    connection.update(first.id, { abbreviation: "soon" }, owner);
    assert.equal(store.list(author)[0].abbreviation, "soon");
    connection.remove(first.id, owner);
    assert.deepEqual(store.list(author), []);
    assert.throws(() => store.update(first.id, { fullName: "Gone" }, author), status(404));
  } finally { connection.close(); }
});

test("shortcut payloads accept only bounded key/value text", () => {
  for (const body of [null, [], "omw", {}, { abbreviation: "omw" }, { fullName: "Full" }, { ...shortcut, abbreviation: "two words" }, { ...shortcut, fullName: 1 }, { ...shortcut, history: "Unused" }, { ...shortcut, description: "Unused" }, { ...shortcut, wikiUrl: "https://example.gov" }, { ...shortcut, repo: "example-org/example-app" }, { ...shortcut, fullName: "bad\u0000text" }]) {
    assert.throws(() => cleanLexiconEntry(body), status(400));
  }
  for (const [key, limit] of Object.entries(LEXICON_LIMITS)) assert.throws(() => cleanLexiconEntry({ ...shortcut, [key]: "x".repeat(limit + 1) }), status(413));
  assert.throws(() => cleanLexiconEntry({}, shortcut), status(400));
  assert.equal(cleanLexiconEntry({ abbreviation: "sig", fullName: "First line\nSecond line" }).fullName, "First line\nSecond line");
});

test("shared shortcut keys stay unique on edits and the store stays bounded", t => {
  const { store } = fixture(t);
  const first = store.create(shortcut, author);
  const second = store.create({ abbreviation: "brb", fullName: "Be right back." }, other);
  assert.throws(() => store.update(second.id, { abbreviation: "OMW" }, other), status(409));
  for (let n = 2; n < MAX_LEXICON_ENTRIES; n++) store.create({ abbreviation: `t${n}`, fullName: `Text ${n}` }, author);
  assert.throws(() => store.create({ abbreviation: "extra", fullName: "Too many" }, author), status(409));
  assert.equal(store.create(shortcut, other).id, first.id, "idempotent create works at the cap");
  store.remove(first.id, author);
  store.create({ abbreviation: "extra", fullName: "Fits now" }, author);
  assert.equal(store.list(author).length, MAX_LEXICON_ENTRIES);
});

test("project glossary content is never migrated or exposed through shared shortcuts", t => {
  const { store, file } = fixture(t);
  const glossary = createGlossaryStore({ file });
  try {
    glossary.create({ id: "example-app", createdAt: 1 }, { abbreviation: "API", fullName: "Project interface", history: "Private project context" }, author.id);
    assert.deepEqual(store.list(other), []);
    store.create(shortcut, author);
    assert.equal(store.list(other).length, 1);
    assert.equal(glossary.list({ id: "example-app", createdAt: 1 }).length, 1);
  } finally { glossary.close(); }
});

test("records preservation archives shortcut edits and deletes atomically and fails closed", t => {
  let enabled = false;
  const { store, file } = fixture(t, () => enabled);
  const first = store.create(shortcut, author, 1);
  store.update(first.id, { fullName: "Before preservation" }, author, 2);
  enabled = true;
  const db = new DatabaseSync(file);
  try {
    ensureRecordsSchema(db);
    db.exec("CREATE TRIGGER shortcut_archive_fail BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT,'archive failure'); END;");
    assert.throws(() => store.update(first.id, { fullName: "Lost" }, owner), error => error.code === "records_preservation_failed");
    assert.throws(() => store.remove(first.id, author), error => error.code === "records_preservation_failed");
    assert.equal(store.list(owner)[0].fullName, "Before preservation");
    assert.deepEqual(listPreserved(db), []);
    db.exec("DROP TRIGGER shortcut_archive_fail; CREATE TRIGGER shortcut_mutation_fail BEFORE UPDATE ON text_shortcuts BEGIN SELECT RAISE(ABORT,'write failure'); END;");
    assert.throws(() => store.update(first.id, { fullName: "Lost" }, owner), /write failure/);
    assert.deepEqual(listPreserved(db), [], "a failed mutation rolls its archive back");
    db.exec("DROP TRIGGER shortcut_mutation_fail");
    store.update(first.id, { fullName: "Current" }, owner);
    store.remove(first.id, author);
    const records = listPreserved(db);
    assert.deepEqual(records.map(row => row.event), ["lexicon_entry_edited", "lexicon_entry_deleted"]);
    assert.equal(records[0].author_id, author.id);
    assert.equal(records[0].actor_id, owner.id);
    assert.equal(records[0].detail.entry.fullName, "Before preservation");
    assert.equal(records[1].detail.entry.fullName, "Current");
    assert.equal(verifyChain(db).ok, true);
  } finally { db.close(); }
});
