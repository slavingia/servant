// Abbreviations nobody has defined: the sender is not asked. Agent's guess is added, marked as a guess, and the
// sender gets a to-do to check it. Store and helper on a disposable SQLite file; no agent takes part.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLexiconStore } from "./lexicon.mjs";
import { learnAbbreviations, learnTodoText } from "./lexicon-guess.mjs";
import { ensureRecordsSchema, listPreserved } from "./records-preserve.mjs";

const owner = { id: "owner", role: "owner" };
const sender = { id: "sender", role: "member" };
const other = { id: "other", role: "member" };
function fixture(t, keepRecords = () => false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-learn-"));
  const file = path.join(dir, "messages.db");
  const store = createLexiconStore({ file, keepRecords });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { file, store };
}
function todoList() {
  const made = [];
  return { made, has: source => made.some(todo => todo.source === source), add: (text, source) => { made.push({ text, source }); } };
}
const answers = guesses => async () => JSON.stringify(guesses);

test("a guess is in the list, marked as one, and anyone may keep or fix it", t => {
  const { store } = fixture(t);
  const guess = store.guess("PTO", "Paid time off", sender, 1);
  assert.deepEqual({ ...guess, id: "x" }, { id: "x", abbreviation: "PTO", fullName: "Paid time off", createdAt: 1, updatedAt: 1, guessed: true, canEdit: true });
  assert.equal(store.list(other)[0].canEdit, true, "nobody's word yet, so anyone may correct it");
  assert.equal(store.guess("pto", "Something else", other), null, "a guess never replaces what is there");
  // Keeping it as it is: the same words saved by a person.
  const kept = store.update(guess.id, { fullName: "Paid time off" }, other, 2);
  assert.deepEqual([kept.guessed, kept.fullName, kept.canEdit], [undefined, "Paid time off", true]);
  assert.equal(store.list(sender)[0].canEdit, false, "it is now the person's who kept it");
  assert.equal(store.list(owner)[0].canEdit, true);
});

test("a person's definition takes the place of a guess, and a guess never takes the place of a person's", t => {
  const { store } = fixture(t);
  const guess = store.guess("EOD", "End of day", sender, 1);
  const defined = store.create({ abbreviation: "eod", fullName: "End of discussion" }, other, 2);
  assert.deepEqual([defined.id, defined.fullName, defined.guessed, defined.canEdit], [guess.id, "End of discussion", undefined, true]);
  assert.equal(store.list(owner).length, 1);
  assert.equal(store.guess("EOD", "End of day", sender), null);
  assert.throws(() => store.create({ abbreviation: "EOD", fullName: "Third meaning" }, sender), error => error.code === "duplicate");
  assert.throws(() => store.guess("not valid!", "x", sender), error => error.code === "bad_request");
});

test("undefined abbreviations get Agent's guess and one to-do each; known ones are left alone", async t => {
  const { store } = fixture(t);
  store.create({ abbreviation: "API", fullName: "Application programming interface" }, owner);
  const todos = todoList();
  const result = await learnAbbreviations({ request: { terms: ["API", "PTO", "XYZ"], text: "PTO via the API, see XYZ" }, user: sender, lexicon: store, todos, ask: answers({ PTO: "Paid time off" }) });
  assert.deepEqual(result.entries.map(entry => [entry.abbreviation, entry.fullName, entry.guessed]), [["PTO", "Paid time off", true]]);
  assert.equal(result.todos, 2);
  assert.deepEqual(todos.made, [
    { text: 'Check what PTO stands for. Agent guessed "Paid time off". Keep it or fix it in Wiki, Abbreviations.', source: result.entries[0].id },
    { text: "Add what XYZ stands for in Wiki, Abbreviations.", source: "term:XYZ" },
  ]);
  assert.equal(learnTodoText("XYZ", ""), "Add what XYZ stands for in Wiki, Abbreviations.");
  // The same message again: PTO is known now, and XYZ has been raised once already.
  const again = await learnAbbreviations({ request: { terms: ["API", "PTO", "XYZ"], text: "PTO via the API, see XYZ" }, user: sender, lexicon: store, todos, ask: answers({}) });
  assert.deepEqual([again.entries, again.todos, todos.made.length], [[], 0, 2]);
});

test("with no agent, or one that fails, the sender is asked to add it; nothing is invented", async t => {
  const { store } = fixture(t);
  const todos = todoList();
  await learnAbbreviations({ request: { terms: ["PTO"], text: "PTO" }, user: sender, lexicon: store, todos, ask: null });
  await learnAbbreviations({ request: { terms: ["EOD"], text: "EOD" }, user: sender, lexicon: store, todos, ask: async () => { throw new Error("down"); } });
  assert.deepEqual(store.list(sender), []);
  assert.deepEqual(todos.made.map(todo => todo.text), ["Add what PTO stands for in Wiki, Abbreviations.", "Add what EOD stands for in Wiki, Abbreviations."]);
  // No to-do list at all still adds the guess.
  const result = await learnAbbreviations({ request: { terms: ["FYI"], text: "FYI" }, user: sender, lexicon: store, todos: null, ask: answers({ FYI: "For your information" }) });
  assert.deepEqual([result.entries.length, result.todos], [1, 0]);
});

// Records preservation: a guess that a person replaces or keeps is an edit of an entry.
test("records preservation archives a guess before a person replaces it, and fails closed", t => {
  const { store, file } = fixture(t, () => true);
  const guess = store.guess("EOD", "End of day", sender, 1);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  ensureRecordsSchema(db);
  db.exec("CREATE TRIGGER learn_archive_fail BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT,'archive failure'); END;");
  assert.throws(() => store.create({ abbreviation: "EOD", fullName: "End of discussion" }, other), error => error.status === 503 && error.code === "records_preservation_failed");
  assert.throws(() => store.update(guess.id, { fullName: "End of day" }, other), error => error.code === "records_preservation_failed");
  assert.deepEqual([store.list(owner)[0].fullName, store.list(owner)[0].guessed], ["End of day", true], "the guess stands when its copy cannot be saved");
  db.exec("DROP TRIGGER learn_archive_fail");
  store.create({ abbreviation: "EOD", fullName: "End of discussion" }, other, 5);
  const records = listPreserved(db);
  assert.deepEqual(records.map(record => [record.event, record.text, record.actor_id, record.detail.entry.guessed]), [["lexicon_entry_edited", "EOD: End of day", "other", true]]);
});

test("two-letter terms from older apps are not raised", async t => {
  const { store } = fixture(t);
  const todos = todoList();
  const result = await learnAbbreviations({ request: { terms: ["QA", "U.S.", "2FA", "PTO"], text: "QA in the U.S. with 2FA and PTO" }, user: sender, lexicon: store, todos, ask: answers({ QA: "Quality assurance", PTO: "Paid time off" }) });
  assert.deepEqual(result.entries.map(entry => entry.abbreviation), ["PTO"]);
  assert.deepEqual(todos.made.map(todo => todo.text), [learnTodoText("PTO", "Paid time off")]);
});
