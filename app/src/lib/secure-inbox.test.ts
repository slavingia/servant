import { test } from "node:test";
import assert from "node:assert/strict";
import { createInboxClient, createInboxDraftId, createInboxLane, inboxContactConfirmed, inboxCursor, inboxDueLabel, inboxOverdue, inboxReplyEmailLine, mergeInboxMessages, parseInboxDueDate, pollInbox, validateInboxFiles, type InboxMessage } from "./secure-inbox.ts";

const message = (id: string, sequence: number) => ({ id, sequence, conversationId: "inbox_example", text: id, sender: "visitor", senderName: "Pat Tester", createdAt: sequence, attachments: [] }) as InboxMessage;

test("inbox pages merge by message id and ordered sequence, without losing older history", () => {
  const all = mergeInboxMessages([message("a", 1), message("c", 3)], [message("b", 2), message("c", 3)]);
  assert.deepEqual(all.map(item => item.id), ["a", "b", "c"]);
  assert.equal(inboxCursor(all), 3);
  assert.equal(inboxCursor([]), 0);
});

test("reply drafts keep their id for a retry and reset after editing or sending", () => {
  let n = 0;
  const draft = createInboxDraftId(() => `request-${++n}`);
  assert.equal(draft.current(), "request-1");
  assert.equal(draft.current(), "request-1");
  draft.reset();
  assert.equal(draft.current(), "request-2");
});

test("inbox enforces the shared attachment budget before upload", () => {
  validateInboxFiles([{ size: 5 * 1024 * 1024 }, { size: 5 * 1024 * 1024 }]);
  assert.throws(() => validateInboxFiles([{ size: 5 * 1024 * 1024 + 1 }]), /5 MB/);
  assert.throws(() => validateInboxFiles(Array.from({ length: 3 }, () => ({ size: 4 * 1024 * 1024 }))), /10 MB/);
  assert.throws(() => validateInboxFiles(Array.from({ length: 5 }, () => ({ size: 1 }))), /4 files/);
  assert.throws(() => validateInboxFiles([{ size: NaN }]), /5 MB/);
});

test("inbox client keeps conversation/file scopes and sends only supported upload fields", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const client = createInboxClient(async (path, init) => { calls.push({ path, init }); return { json: async () => ({}) }; });
  await client.list("open", "  Pat & subject  ");
  await client.send("a/b", "Hello", [{ name: "notes.txt", data: "aGk=", size: 2 }], "retry-1");
  await client.read("a/b", 12);
  assert.equal(calls[0].path, "/v1/inbox?status=open&q=Pat%20%26%20subject&offset=0&scope=all");
  assert.equal(calls[1].path, "/v1/inbox/a%2Fb/messages");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { text: "Hello", attachments: [{ name: "notes.txt", data: "aGk=" }], requestId: "retry-1" });
  assert.equal(calls[2].path, "/v1/inbox/a%2Fb/read");
});

test("inbox list pagination sends the server cursor so older conversations remain reachable", async () => {
  let route = "";
  const client = createInboxClient(async path => { route = path; return { json: async () => ({ conversations: [], hasMore: false, nextOffset: null }) }; });
  await client.list("all", "", undefined, 100);
  assert.equal(route, "/v1/inbox?status=all&q=&offset=100&scope=all");
});

test("private notes and public replies keep independent draft IDs and fixed send/file routes", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const client = createInboxClient(async (path, init) => { calls.push({ path, init }); return { json: async () => ({ file: { id: "file", name: "notes.txt", data: "aGk=", size: 2 } }) }; });
  const team = createInboxLane(client, "case/one", "team");
  const visitor = createInboxLane(client, "case/one", "conversation");
  const teamDraft = createInboxDraftId(() => "team-retry");
  const publicDraft = createInboxDraftId(() => "public-retry");
  await team.send("Private note", [], teamDraft.current());
  await visitor.send("Public reply", [], publicDraft.current());
  publicDraft.reset();
  await team.send("Private note", [], teamDraft.current());
  await team.file("private/file");
  await visitor.file("public/file");
  assert.deepEqual(calls.map(call => call.path), ["/v1/inbox/case%2Fone/notes", "/v1/inbox/case%2Fone/messages", "/v1/inbox/case%2Fone/notes", "/v1/inbox/case%2Fone/notes/files/private%2Ffile", "/v1/inbox/case%2Fone/files/public%2Ffile"]);
  assert.equal(calls[0].init?.body, calls[2].init?.body, "switching tabs and sending a public draft never changes the pending private retry");
  assert.equal(JSON.parse(String(calls[1].init?.body)).text, "Public reply");
});

test("case filters, follow-ups and activity use authenticated case-scoped routes", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const client = createInboxClient(async (path, init) => { calls.push({ path, init }); return { json: async () => ({}) }; });
  await client.list("open", "CASE-000001", undefined, 0, "mine");
  await client.case("case/one");
  await client.addTask("case/one", { text: "Check the document", assigneeId: "member", dueDate: "2026-12-01" }, "task-id");
  await client.updateTask("case/one", "task/one", { status: "done" }, "done-id");
  await client.activity("case/one", 9);
  assert.equal(calls[0].path, "/v1/inbox?status=open&q=CASE-000001&offset=0&scope=mine");
  assert.equal(calls[1].path, "/v1/inbox/case%2Fone/case");
  assert.equal(calls[2].path, "/v1/inbox/case%2Fone/tasks");
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { status: "done", requestId: "done-id" });
  assert.equal(calls[3].path, "/v1/inbox/case%2Fone/tasks/task%2Fone");
  assert.equal(calls[4].path, "/v1/inbox/case%2Fone/activity?after=9");
});

test("staff-created cases retain their request id and visitor links are requested explicitly", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const client = createInboxClient(async (path, init) => { calls.push({ path, init }); return { json: async () => ({}) }; });
  const draft = createInboxDraftId(() => "case-request");
  const fields = { name: "Pat Tester", email: "pat@example.gov", subject: "Existing work" };
  await client.create(fields, draft.current());
  await client.create(fields, draft.current());
  assert.equal(calls[0].path, "/v1/inbox");
  assert.equal(calls[0].init?.body, calls[1].init?.body);
  assert.equal(calls.some(call => call.path.includes("visitor-link")), false);
  await client.visitorLink("case/one");
  assert.equal(calls[2].path, "/v1/inbox/case%2Fone/visitor-link");
  assert.equal(calls[2].init?.method, "POST");
});

test("follow-up dates reject impossible dates and compare due work by UTC calendar date", () => {
  assert.equal(parseInboxDueDate("  "), null);
  assert.equal(parseInboxDueDate("2028-02-29"), "2028-02-29");
  assert.equal(parseInboxDueDate("1900-01-01"), "1900-01-01");
  assert.throws(() => parseInboxDueDate("1899-12-31"), /on or after 1900-01-01/);
  assert.throws(() => parseInboxDueDate("2027-02-29"), /real calendar date/);
  assert.throws(() => parseInboxDueDate("2026-13-01"), /real calendar date/);
  assert.throws(() => parseInboxDueDate("12/01/26"), /YYYY-MM-DD/);
  const now = new Date("2026-11-11T00:30:00.000Z");
  assert.equal(inboxDueLabel("2026-11-11", now), "Due today");
  assert.match(inboxDueLabel("2026-11-10", now), /^Overdue/);
  assert.match(inboxDueLabel("2026-11-12", now), /^Due ·/);
  assert.equal(inboxDueLabel(null, now), "No due date");
});

test("inbox keeps the server's public entry URL distinct from its API address", async () => {
  let publicUrl: string | null = "https://chat.example.gov/contact";
  const client = createInboxClient(async () => ({ json: async () => ({ conversations: [], hasMore: false, nextOffset: null, publicUrl }) }));
  assert.equal((await client.list("open", "")).publicUrl, "https://chat.example.gov/contact");
  publicUrl = null;
  assert.equal((await client.list("open", "")).publicUrl, null);
});

test("downloads reject invalid content and force a safe binary media type", async () => {
  let data = "aGk=";
  const client = createInboxClient(async () => ({ json: async () => ({ file: { id: "f", name: "notes.html", mime: "text/html", size: 2, data } }) }));
  assert.equal((await client.file("a", "f")).mime, "application/octet-stream");
  data = "<script>";
  await assert.rejects(client.file("a", "f"), /download/);
});

test("live polling does not overlap requests and aborting prevents later polls", async () => {
  let finish: () => void = () => {};
  let calls = 0;
  let signal: AbortSignal | undefined;
  const stop = pollInbox(async received => { calls++; signal = received; await new Promise<void>(resolve => { finish = resolve; }); }, () => assert.fail("unexpected error"), 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  stop(); finish();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

test("a follow-up is overdue only when its date is before today", () => {
  const now = new Date("2026-11-11T15:00:00.000Z");
  assert.equal(inboxOverdue("2026-11-10", now), true);
  assert.equal(inboxOverdue("2026-11-11", now), false, "due today is not overdue");
  assert.equal(inboxOverdue("2026-11-12", now), false);
  assert.equal(inboxOverdue(null, now), false, "no date is never overdue");
  // The mark and the word agree: whatever is marked overdue is also labeled so.
  for (const date of ["2026-11-10", "2026-11-11", "2026-11-12"]) assert.equal(inboxOverdue(date, now), inboxDueLabel(date, now).startsWith("Overdue"));
});

// The team could not tell whether someone would ever see a reply: nothing told the visitor, and nothing said so.
test("a case says in one sentence whether the visitor is told about a reply", () => {
  assert.equal(inboxReplyEmailLine({ available: true, state: "on", email: "ana@example.gov" }), "Emailed at ana@example.gov when the team replies.");
  assert.equal(inboxReplyEmailLine({ available: true, state: "pending", email: "ana@example.gov" }), "Has not confirmed ana@example.gov yet, so no email when the team replies.");
  for (const state of ["none", "off"] as const) assert.equal(inboxReplyEmailLine({ available: true, state, email: state === "off" ? "ana@example.gov" : null }), "No email when the team replies. They see a reply when they come back to the page.");
  assert.equal(inboxReplyEmailLine({ available: false, state: "none", email: null }), "This server does not send email. They see a reply when they come back to the page.");
  assert.equal(inboxReplyEmailLine(undefined), "This server does not send email. They see a reply when they come back to the page.", "a server from before reply emails");
});

test("a contact address counts as confirmed only when the visitor proved that same address with a code", () => {
  assert.equal(inboxContactConfirmed("Ana@Example.gov ", { available: true, state: "on", email: "ana@example.gov" }), true);
  assert.equal(inboxContactConfirmed("ana@example.gov", { available: true, state: "on", email: "jo@example.gov" }), false, "they confirmed a different address");
  assert.equal(inboxContactConfirmed("ana@example.gov", { available: true, state: "pending", email: "ana@example.gov" }), false);
  assert.equal(inboxContactConfirmed("ana@example.gov", { available: true, state: "off", email: "ana@example.gov" }), false);
  assert.equal(inboxContactConfirmed("", { available: true, state: "on", email: "" }), false);
  assert.equal(inboxContactConfirmed("ana@example.gov", undefined), false);
});
