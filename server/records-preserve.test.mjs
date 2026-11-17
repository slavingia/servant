import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMessaging } from "./messaging.mjs";
import { createChatMediaStore } from "./chat-media.mjs";
import { ensureRecordsSchema, listPreserved, preserve, preservedFile, recordsPreservationEnabled, verifyChain } from "./records-preserve.mjs";

const people = { ann: { id: "ann", name: "Ann", role: "owner" }, bo: { id: "bo", name: "Bo", role: "member" }, cy: { id: "cy", name: "Cy", role: "member" } };

function setup(t, { keeping = true } = {}) {
  let on = keeping;
  const m = createMessaging({ file: ":memory:", users: () => people, agentName: () => "Agent", recordsPreservation: () => on });
  t.after(() => m.close());
  const call = async (user, method, p, body) => {
    let out;
    await m.handle({}, { setHeader() {} }, { user, method, parts: p.split("/").filter(Boolean), url: new URL("http://x/" + p), readBody: async () => body ?? {}, send: (_r, status, data) => { out = { status, data }; }, fail: (_r, status, code, message) => { out = { status, code, message }; } });
    return out;
  };
  return { m, call, set: v => { on = v; } };
}
const archive = (m, where = "1=1", ...args) => m.db.prepare(`SELECT * FROM records_archive WHERE ${where} ORDER BY id`).all(...args);

test("it is off unless config turns it on, and then the schema does not even exist", () => {
  assert.equal(recordsPreservationEnabled(undefined), false);
  assert.equal(recordsPreservationEnabled({ enabled: "yes" }), false);
  assert.equal(recordsPreservationEnabled({ enabled: true }), true);
  const t = { after() {} };
  const { m } = setup(t, { keeping: false });
  const ch = m.createChannel(people.ann, { name: "plain" });
  m.post(ch, "ann", "hello");
  assert.equal(m.db.prepare("SELECT name FROM sqlite_master WHERE name = 'records_archive'").get(), undefined, "a server that never turns it on is unchanged");
});

test("an edit keeps the original wording and who changed it; the person still sees the edit", async t => {
  const { m, call } = setup(t);
  const ch = m.createChannel(people.ann, { name: "design", memberIds: ["bo"] });
  const posted = m.post(ch, "bo", "The deadline is Friday");
  const edited = await call(people.bo, "PATCH", `v1/messages/${posted.seq}`, { text: "The deadline is Monday" });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.message.text, "The deadline is Monday", "people see the edit as before");
  const kept = archive(m, "event = 'message_edited'");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, "The deadline is Friday", "the wording before the edit is kept");
  assert.deepEqual([kept[0].author_id, kept[0].actor_id, kept[0].conversation_name], ["bo", "bo", "design"]);
});

test("deleting a message keeps its text, author, time, thread and attachments", async t => {
  const { m, call } = setup(t);
  const ch = m.createChannel(people.ann, { name: "ops", memberIds: ["bo"] });
  const posted = m.post(ch, "bo", "Approved the $40,000 purchase", null, { attachments: [{ name: "quote.pdf", mime: "application/pdf", data: Buffer.from("PDFDATA") }] });
  const gone = await call(people.bo, "DELETE", `v1/messages/${posted.seq}`);
  assert.equal(gone.status, 200);
  const shown = m.db.prepare("SELECT text, deleted_at FROM messages WHERE seq = ?").get(posted.seq);
  assert.equal(shown.text, "", "people see it as deleted");
  assert.ok(shown.deleted_at);
  const [row] = archive(m, "event = 'message_deleted'");
  assert.equal(row.text, "Approved the $40,000 purchase");
  assert.equal(row.author_id, "bo");
  assert.equal(row.created_at, posted.created_at);
  const [e] = listPreserved(m.db, { conversationId: ch.id }).filter(x => x.event === "message_deleted");
  assert.deepEqual(e.files.map(f => [f.name, f.size]), [["quote.pdf", 7]], "the attachment is kept too");
  assert.equal(Buffer.from(preservedFile(m.db, e.files[0].id).data).toString(), "PDFDATA");
});

test("the owner deleting someone else's message records who did it", async t => {
  const { m, call } = setup(t);
  const ch = m.createChannel(people.ann, { name: "gen", memberIds: ["bo"] });
  const posted = m.post(ch, "bo", "something");
  assert.equal((await call(people.ann, "DELETE", `v1/messages/${posted.seq}`)).status, 200);
  const [row] = archive(m, "event = 'message_deleted'");
  assert.deepEqual([row.author_id, row.actor_id], ["bo", "ann"], "author and the person who deleted it are different, and both are kept");
});

test("deleting a DM, which removes both people's messages, keeps every one of them", async t => {
  const { m, call } = setup(t);
  const dm = m.openDm(people.ann, ["bo"]);
  m.post(dm, "ann", "first");
  m.post(dm, "bo", "second");
  const del = await call(people.bo, "DELETE", `v1/conversations/${dm.id}`);
  assert.equal(del.status, 200);
  assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(dm.id).n, 0, "gone from view");
  const kept = archive(m, "conversation_id = ? AND event = 'conversation_deleted_message'", dm.id);
  assert.deepEqual(kept.map(r => [r.author_id, r.text]), [["ann", "first"], ["bo", "second"]]);
  const [head] = archive(m, "event = 'conversation_deleted'");
  assert.equal(head.actor_id, "bo");
  assert.deepEqual(JSON.parse(head.detail).members.sort(), ["ann", "bo"], "who was in it is kept");
});

test("deleting a channel keeps its messages, name and members", async t => {
  const { m, call } = setup(t);
  const ch = m.createChannel(people.ann, { name: "launch", memberIds: ["bo", "cy"], private: true });
  m.post(ch, "ann", "plan");
  m.post(ch, "cy", "ack");
  assert.equal((await call(people.ann, "DELETE", `v1/conversations/${ch.id}`)).status, 200);
  const msgs = archive(m, "conversation_id = ? AND event = 'conversation_deleted_message'", ch.id);
  assert.deepEqual(msgs.filter(r => r.text === "plan" || r.text === "ack").map(r => [r.author_id, r.text]), [["ann", "plan"], ["cy", "ack"]], "both real messages are kept");
  assert.ok(msgs.length >= 2, "and so are the system notices (who joined), which are part of the conversation's history");
  const head = archive(m, "event = 'conversation_deleted'")[0];
  assert.equal(head.conversation_name, "launch");
  assert.equal(JSON.parse(head.detail).private, true);
});

test("if the record cannot be saved, the delete does not happen", async t => {
  const { m, call } = setup(t);
  const ch = m.createChannel(people.ann, { name: "ops2", memberIds: ["bo"] });
  const posted = m.post(ch, "bo", "keep me");
  ensureRecordsSchema(m.db);
  m.db.exec("CREATE TEMP TRIGGER fail_archive BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  await assert.rejects(call(people.bo, "DELETE", `v1/messages/${posted.seq}`), e => e.status === 503 && e.code === "records_preservation_failed" && !/disk full/.test(e.message), "a plain 503 the app can show, not a raw database error");
  assert.equal(m.db.prepare("SELECT text FROM messages WHERE seq = ?").get(posted.seq).text, "keep me", "and the message is untouched");
});

test("preserved records cannot be edited or erased, even by SQL", t => {
  const { m } = setup(t);
  ensureRecordsSchema(m.db);
  preserve(m.db, { event: "message_deleted", conversation_id: "c1", text: "original", author_id: "bo" });
  assert.throws(() => m.db.exec("UPDATE records_archive SET text = 'changed'"), /append-only/);
  assert.throws(() => m.db.exec("DELETE FROM records_archive"), /append-only/);
});

test("the hash chain notices an altered, removed or reordered entry, and an altered attachment", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-records-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "a.db"));
  ensureRecordsSchema(db);
  for (let i = 1; i <= 4; i++) preserve(db, { event: "message_deleted", conversation_id: "c", text: `message ${i}`, author_id: "bo" }, i === 2 ? [{ name: "f.txt", mime: "text/plain", data: Buffer.from("file") }] : [], 1000 + i);
  assert.deepEqual(verifyChain(db), { ok: true, checked: 4, brokenAt: null });
  db.exec("DROP TRIGGER records_archive_no_update");
  db.exec("UPDATE records_archive SET text = 'forged' WHERE id = 3");
  const v = verifyChain(db);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3, "pinpoints the first altered entry");
  db.exec("UPDATE records_archive SET text = 'message 3' WHERE id = 3");
  assert.equal(verifyChain(db).ok, true, "restoring the original makes it verify again");
  db.exec("DROP TRIGGER records_archive_files_no_update");
  db.exec("UPDATE records_archive_files SET data = x'00'");
  assert.equal(verifyChain(db).ok, false, "a changed attachment is noticed");
  db.close();
});

test("a dropped-upstream agent chat message is archived before the mirror removes it", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-records-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kept = [];
  const store = createChatMediaStore(path.join(dir, "m.db"), { keepDropped: (chat, id) => kept.push([chat, id, store.preservableOne(id)?.text]) });
  t.after(() => store.close());
  store.sync("chat1", [{ id: "u1", role: "user", content: "first" }, { id: "a1", role: "assistant", content: "answer" }]);
  assert.equal(store.history("chat1").length, 2);
  store.sync("chat1", [{ id: "a1", role: "assistant", content: "answer" }]); // Hermes no longer returns u1
  assert.equal(store.history("chat1").length, 1, "it leaves the view");
  assert.deepEqual(kept.map(k => k[2]), ["first"], "but it was archived first, with its text intact");
});

test("if archiving a dropped message fails, the mirror keeps it rather than destroy it", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-records-media2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createChatMediaStore(path.join(dir, "m.db"), { keepDropped: () => { throw new Error("archive unavailable"); } });
  t.after(() => store.close());
  store.sync("chat1", [{ id: "u1", role: "user", content: "first" }, { id: "a1", role: "assistant", content: "answer" }]);
  store.sync("chat1", [{ id: "a1", role: "assistant", content: "answer" }]);
  assert.equal(store.history("chat1").length, 2, "nothing was deleted because nothing could be preserved");
});

// What the documentation promises must be true of the code. These read the destructive statements the audit found and check that each
// one is either preceded by a preservation hook or gated on the switch, so a future edit cannot quietly add a new unguarded delete.
test("every destructive path the records audit found is guarded by the preservation switch", () => {
  const read = f => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  const messaging = read("./messaging.mjs");
  const check = (src, anchor, guard, why) => { const i = src.indexOf(anchor); assert.ok(i > 0, `${why}: anchor found`); assert.ok(src.slice(Math.max(0, i - 400), i).includes(guard), `${why}: ${guard} comes before ${anchor}`); };
  check(messaging, "st.setText.run(", "keepMessage(", "edit");
  check(messaging, "st.softDelete.run(", "keepMessage(", "delete message");
  assert.equal([...messaging.matchAll(/st\.deleteConv\.run\(/g)].length, 2, "exactly two conversation deletes exist (DM and channel)");
  for (const m of messaging.matchAll(/st\.deleteConv\.run\(/g)) assert.ok(messaging.slice(m.index - 500, m.index).includes("keepConversation("), "each conversation delete is preceded by keepConversation");
  const server = read("./server.mjs");
  check(server, 'mutateAuthenticated(req, (state, current) => { requireChat(state, current.user.id, chat.id).deletedAt = now(); });', "preserveAgentChat(", "agent chat delete");
  const media = read("./chat-media.mjs");
  check(media, 'db.prepare("DELETE FROM chat_messages WHERE id=?").run(row.id);', "keepDropped(", "mirror drop");
  assert.match(read("./recordings.mjs"), /recordsPreservation\) \{ st\.hide\.run/, "personal recording delete hides instead");
  assert.match(read("./projects.mjs"), /if \(keep\(\)\) return void quarantine/, "project file removal is gated");
  assert.match(read("./documents.mjs"), /if \(keep\(\) && fs\.existsSync\(from\)\)/, "chat documents are set aside");
  assert.match(read("./prototypes.mjs"), /if \(keep && fs\.existsSync\(from\)\)/, "prototypes are set aside");
});

test("keepAll is all-or-nothing: a failure part-way saves nothing, so a retry cannot archive the same content twice", t => {
  const { m } = setup(t);
  const entries = [1, 2, 3, 4].map(i => [{ event: "agent_chat_message", conversation_id: "chat1", text: `message ${i}` }, []]);
  m.keepAll(entries);
  assert.equal(archive(m, "conversation_id = 'chat1'").length, 4, "all four saved");
  // Now make the third entry fail: nothing from this batch may remain.
  m.db.exec("CREATE TEMP TRIGGER fail_third BEFORE INSERT ON records_archive WHEN NEW.text = 'boom' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  const bad = [[{ event: "x", conversation_id: "chat2", text: "ok 1" }, []], [{ event: "x", conversation_id: "chat2", text: "ok 2" }, []], [{ event: "x", conversation_id: "chat2", text: "boom" }, []]];
  assert.throws(() => m.keepAll(bad), /disk full/);
  assert.equal(archive(m, "conversation_id = 'chat2'").length, 0, "the two that succeeded were rolled back with it");
  m.db.exec("DROP TRIGGER fail_third");
  m.keepAll(bad.slice(0, 2));
  assert.equal(archive(m, "conversation_id = 'chat2'").length, 2, "a retry saves it exactly once");
});
