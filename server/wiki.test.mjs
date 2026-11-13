// The wiki's store: a tree of Markdown pages on a disposable SQLite file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWikiStore, WIKI_LIMITS } from "./wiki.mjs";
import { ensureRecordsSchema, listPreserved, verifyChain } from "./records-preserve.mjs";

const owner = { id: "owner", role: "owner" };
const author = { id: "author", role: "member" };
const other = { id: "other", role: "member" };
const names = () => ({ owner: "Pat Tester", author: "Jo Park", other: "Ana Ruiz" });
const code = value => error => error.code === value;
function fixture(t, keepRecords = () => false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-wiki-"));
  const file = path.join(dir, "messages.db");
  const store = createWikiStore({ file, keepRecords, names });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { file, store };
}

test("pages form a tree, anyone edits them, and the list carries no text", t => {
  const { store } = fixture(t);
  const guide = store.create({ title: " Team guide ", body: "# Welcome\r\n\r\nStart here." }, author, 1);
  assert.match(guide.id, /^wiki_[A-Za-z0-9_-]{16}$/);
  assert.deepEqual({ ...guide, id: "x" }, { id: "x", parentId: null, title: "Team guide", position: 1, createdAt: 1, updatedAt: 1, updatedByName: "Jo Park", version: 1, canDelete: true, body: "# Welcome\n\nStart here." });
  const onboarding = store.create({ title: "Onboarding", parentId: guide.id }, other, 2);
  const tools = store.create({ title: "Tools", parentId: guide.id }, other, 3);
  assert.deepEqual([onboarding.parentId, onboarding.position, tools.position, onboarding.body], [guide.id, 1, 2, ""]);
  const listed = store.list(other);
  assert.deepEqual(listed.map(page => page.title), ["Team guide", "Onboarding", "Tools"]);
  assert.ok(listed.every(page => !("body" in page)), "the tree does not download every page's text");
  assert.deepEqual(listed.map(page => page.canDelete), [false, true, true], "delete is for the page's maker or an owner");
  assert.ok(store.list(owner).every(page => page.canDelete));

  // Someone who did not make the page edits it; the page says who and when.
  const edited = store.update(guide.id, { body: "Start **here**.", version: 1 }, other, 9);
  assert.deepEqual([edited.body, edited.title, edited.version, edited.updatedAt, edited.updatedByName], ["Start **here**.", "Team guide", 2, 9, "Ana Ruiz"]);
  assert.equal(store.get(guide.id, author).body, "Start **here**.");
  // Saving what is already there changes nothing.
  assert.equal(store.update(guide.id, { body: "Start **here**." }, author, 20).version, 2);
  assert.throws(() => store.get("wiki_missingmissing00", owner), code("not_found"));
  assert.throws(() => store.get("../etc", owner), code("not_found"));
});

test("an edit made from an old copy is refused and shown the newer page", t => {
  const { store } = fixture(t);
  const page = store.create({ title: "Plan", body: "One" }, author, 1);
  store.update(page.id, { body: "Two", version: 1 }, other, 2);
  assert.throws(() => store.update(page.id, { body: "Mine", version: 1 }, author, 3), error => {
    assert.equal(error.status, 409); assert.equal(error.code, "stale");
    assert.match(error.message, /^Ana Ruiz changed this page while you were editing\. Copy your changes, reload the page, then add them again$/);
    assert.equal(error.page.body, "Two");
    return true;
  });
  assert.equal(store.get(page.id, author).body, "Two", "the newer text is not overwritten");
});

test("a page moves under another, never under itself, and nesting has a limit", t => {
  const { store } = fixture(t);
  const a = store.create({ title: "A" }, author), b = store.create({ title: "B", parentId: a.id }, author), c = store.create({ title: "C", parentId: b.id }, author);
  assert.throws(() => store.update(a.id, { parentId: c.id }, author), code("cycle"));
  assert.throws(() => store.update(a.id, { parentId: a.id }, author), code("cycle"));
  assert.throws(() => store.update(a.id, { parentId: "wiki_missingmissing00" }, author), code("not_found"));
  const moved = store.update(c.id, { parentId: null }, other, 50);
  assert.deepEqual([moved.parentId, moved.position, moved.updatedByName], [null, 2, "Jo Park"], "moving a page is not writing it");
  // Six levels deep and no further, whether a page is made there or a branch is moved there.
  let at = a.id;
  for (let depth = 2; depth <= WIKI_LIMITS.depth; depth += 1) at = (depth === 2 ? b : store.create({ title: `Level ${depth}`, parentId: at }, author)).id;
  assert.throws(() => store.create({ title: "Too deep", parentId: at }, author), code("limit"));
  assert.throws(() => store.update(c.id, { parentId: at }, author), code("limit"));
  const pair = store.create({ title: "Pair" }, author); store.create({ title: "Child", parentId: pair.id }, author);
  assert.throws(() => store.update(pair.id, { parentId: store.list(author).find(page => page.title === `Level ${WIKI_LIMITS.depth - 1}`).id }, author), code("limit"), "a branch counts by its own depth too");
});

test("only its maker or an owner deletes a page, and not while it has subpages", t => {
  const { store } = fixture(t);
  const parent = store.create({ title: "Parent" }, author), child = store.create({ title: "Child", parentId: parent.id }, other);
  assert.throws(() => store.remove(child.id, author), code("forbidden"));
  assert.throws(() => store.remove(parent.id, author), error => error.code === "has_subpages" && error.message === "This page has subpages. Move or delete them first");
  store.remove(child.id, owner);
  store.remove(parent.id, author);
  assert.deepEqual(store.list(owner), []);
  assert.throws(() => store.remove(parent.id, owner), code("not_found"));
});

test("page payloads accept only bounded text", t => {
  const { store } = fixture(t);
  for (const body of [null, [], "x", { title: "" }, { title: "   " }, { title: 7 }, { title: "A\nB" }, { title: "A\u0000" }, { title: "A", body: 7 }, { title: "A", body: "x\u0007" }, { title: "A", parentId: 7 }, { title: "A", parentId: "nope" }, { title: "A", author: "x" }]) {
    assert.throws(() => store.create(body, author), code("bad_request"), JSON.stringify(body));
  }
  assert.throws(() => store.create({ title: "x".repeat(WIKI_LIMITS.title + 1) }, author), code("limit"));
  assert.throws(() => store.create({ title: "A", body: "x".repeat(WIKI_LIMITS.body + 1) }, author), code("limit"));
  const page = store.create({ title: "x".repeat(WIKI_LIMITS.title), body: "x".repeat(WIKI_LIMITS.body) }, author);
  assert.throws(() => store.update(page.id, {}, author), code("bad_request"));
  assert.throws(() => store.update(page.id, { version: 1 }, author), code("bad_request"));
  assert.throws(() => store.update(page.id, { title: "" }, author), code("bad_request"));
  assert.throws(() => store.update(page.id, { id: "wiki_other" }, author), code("bad_request"));
});

test("the wiki stops at its page limit", t => {
  const { store, file } = fixture(t);
  const db = new DatabaseSync(file);
  try {
    const insert = db.prepare("INSERT INTO wiki_pages (id,parent_id,title,body,position,author_id,created_at,updated_at,updated_by) VALUES (?,NULL,'Page','',?,'author',1,1,'author')");
    db.exec("BEGIN");
    for (let n = 0; n < WIKI_LIMITS.pages; n += 1) insert.run(`wiki_${String(n).padStart(16, "0")}`, n + 1);
    db.exec("COMMIT");
  } finally { db.close(); }
  assert.throws(() => store.create({ title: "One more" }, author), error => error.code === "limit" && /The wiki can hold 1,000 pages/.test(error.message));
});

// Records preservation: a page's title and text are authored content.
test("records preservation archives the previous page before an edit or a delete, and fails closed", t => {
  let keeping = false;
  const { store, file } = fixture(t, () => keeping);
  const page = store.create({ title: "Policy", body: "Before preservation" }, author, 1);
  store.update(page.id, { body: "First" }, author, 2);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  ensureRecordsSchema(db);
  assert.deepEqual(listPreserved(db), [], "nothing is archived while the setting is off");
  keeping = true;
  db.exec("CREATE TRIGGER wiki_archive_fail BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT,'archive failure'); END;");
  assert.throws(() => store.update(page.id, { body: "Lost" }, other, 3), error => error.status === 503 && error.code === "records_preservation_failed");
  assert.throws(() => store.update(page.id, { title: "Lost" }, other, 3), code("records_preservation_failed"));
  assert.throws(() => store.remove(page.id, author), code("records_preservation_failed"));
  assert.deepEqual([store.get(page.id, author).title, store.get(page.id, author).body], ["Policy", "First"], "nothing changed when the copy could not be saved");
  // Moving a page writes nothing, so it needs no copy.
  const parent = store.create({ title: "Parent" }, author, 3);
  assert.equal(store.update(page.id, { parentId: parent.id }, other, 4).parentId, parent.id);
  db.exec("DROP TRIGGER wiki_archive_fail; CREATE TRIGGER wiki_write_fail BEFORE UPDATE ON wiki_pages BEGIN SELECT RAISE(ABORT,'write failure'); END;");
  assert.throws(() => store.update(page.id, { body: "Unsaved" }, other, 5));
  assert.deepEqual(listPreserved(db), [], "a failed edit rolls its archived copy back");
  db.exec("DROP TRIGGER wiki_write_fail");
  store.update(page.id, { title: "Policy 2", body: "Second" }, other, 6);
  store.remove(page.id, owner);
  const records = listPreserved(db);
  assert.deepEqual(records.map(record => [record.event, record.text, record.author_id, record.actor_id]), [
    ["wiki_page_edited", "# Policy\n\nFirst", "author", "other"],
    ["wiki_page_deleted", "# Policy 2\n\nSecond", "other", "owner"],
  ]);
  assert.equal(records[0].detail.page.id, page.id);
  assert.equal(records[0].conversation_kind, "wiki");
  assert.equal(verifyChain(db).ok, true);
});
