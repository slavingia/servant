// Sharing a prototype with a business owner, over the real server: the person who built it types a work email, the
// business owner gets a link, confirms a code sent to that address, sees the prototype and comments on it, and each
// comment becomes a to-do for the person who shared it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === "API_SERVER_KEY") delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-reviews-http-"));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PUSH_CONFIG = path.join(directory, "push.json");
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
const config = { host: "127.0.0.1", port: 0, name: "Example team", agentName: "Agent", publicUrl: "https://team.example.gov", discoveryUrl: "", adminKey: "",
  // Chat routes need an agent to be configured; nothing here talks to it.
  upstreams: { owner: { url: "http://127.0.0.1:9", key: "fixture-key" } },
  emailVerification: { enabled: false, domains: ["example.gov"] } };
const mail = [], pushes = [];
let mailFails = false;
globalThis.__servantEmailSend = async message => { if (mailFails) throw new Error("smtp down"); mail.push(message); };
globalThis.__servantPushSend = async (target, notification) => { pushes.push({ to: target.token, title: notification.title, body: notification.body, page: notification.data.page }); return { ok: true }; };

const people = { ana: { name: "Ana Ruiz", role: "owner" }, pat: { name: "Pat Tester", role: "member" }, sam: { name: "Sam Lee", role: "member" } };
const FOLDER = "proto-0123456789abcdef01";
let server, base, mod;
before(async () => {
  mod = await import("./server.mjs"); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.join(directory, "prototypes", FOLDER), { recursive: true });
  fs.writeFileSync(path.join(directory, "prototypes", FOLDER, "index.html"), "<html><body><h1>Refund tracker</h1><button>Pay now</button></body></html>");
  mod.mutateStateForTest(state => {
    for (const [key, p] of Object.entries(people)) {
      p.id = `usr_${key}`; p.token = crypto.randomBytes(32).toString("base64url");
      state.users[p.id] = { id: p.id, name: p.name, role: p.role, createdAt: Date.now(), agentTier: 2 };
      state.devices[crypto.createHash("sha256").update(p.token).digest("hex")] = { id: `dev_${key}`, userId: p.id, label: "Phone", createdAt: Date.now(), lastSeenAt: Date.now(), push: { platform: "ios", token: `push-${key}`, environment: "production" } };
    }
    const chat = (id, userId, extra) => { state.chats[id] = { id, userId, title: "Refund tracker", role: "owner", createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now(), ...extra }; };
    chat("cht_proto", people.pat.id, { mode: "vibe", vibeFolder: FOLDER, hosted: "server" });
    chat("cht_plain", people.pat.id, {});
  });
});
after(async () => { await server?.shutdown(); delete globalThis.__servantEmailSend; delete globalThis.__servantPushSend; fs.rmSync(directory, { recursive: true, force: true }); });

async function api(who, method, route, body) {
  const response = await testFetch(directory, `${base}/v1/${route}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${people[who].token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
// The business owner's browser: plain requests to /review/<link>, no account.
async function visit(pathname, { method = "GET", body, session } = {}) {
  const response = await fetch(`${base}${pathname}`, { method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: response.status, text, json, headers: response.headers };
}
const linkIn = message => new URL(message.text.match(/https:\/\/team\.example\.gov\/review\/[A-Za-z0-9_-]+/)[0]).pathname;
async function waitFor(list, count) { for (let i = 0; i < 300 && list.length < count; i++) await new Promise(r => setTimeout(r, 20)); return list.splice(0); }

test("share by work email, confirm a code, see the prototype, comment; the comment becomes the sharer's to-do", async () => {
  // Who may share, and to whom.
  assert.equal((await api("ana", "POST", "chats/cht_proto/prototype/shares", { email: "jo@example.gov" })).status, 403, "an owner can read the chat, but it isn't theirs to share");
  assert.equal((await api("pat", "POST", "chats/cht_plain/prototype/shares", { email: "jo@example.gov" })).status, 404, "a chat without a prototype has nothing to share");
  assert.equal((await api("pat", "POST", "chats/cht_proto/prototype/shares", { email: "jo@example.com" })).body.error.code, "email_not_allowed");
  assert.equal((await api("pat", "POST", "chats/cht_proto/prototype/shares", { email: "nope" })).body.error.code, "email_invalid");
  assert.equal(mail.length, 0);

  const shared = await api("pat", "POST", "chats/cht_proto/prototype/shares", { email: "Jo.Park@example.gov" });
  assert.equal(shared.status, 201);
  assert.deepEqual(shared.body.shares.map(s => [s.email, s.comments.length, !!s.endedAt]), [["jo.park@example.gov", 0, false]]);
  assert.equal(JSON.stringify(shared.body).includes("/review/"), false, "the link is only ever in the email");
  const [invite] = mail.splice(0);
  assert.equal(invite.to, "jo.park@example.gov");
  assert.equal(invite.subject, "Pat Tester shared a prototype with you: Refund tracker");
  const link = linkIn(invite);

  // The link alone: who shared what, a masked address, and neither the prototype nor where it lives.
  const page = await visit(link);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Pat Tester shared a prototype with you") && page.text.includes("j***@example.gov"));
  assert.equal(page.text.includes(FOLDER), false);
  assert.equal(page.text.includes("jo.park@"), false);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await visit(`${link}/comments`)).status, 401);
  assert.equal((await visit(`${link}/comments`, { session: "made-up" })).status, 401);
  assert.equal((await visit(`${link}/comments`, { method: "POST", body: { text: "hi" } })).status, 401);
  const wrongLink = await visit("/review/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(wrongLink.status, 404);
  assert.ok(wrongLink.text.includes("This link doesn't work"));

  // The code goes to the address it was shared with, whatever the visitor sends.
  const asked = await visit(`${link}/code`, { method: "POST", body: { email: "attacker@example.org" } });
  assert.equal(asked.status, 200);
  const [codeMail] = mail.splice(0);
  assert.equal(codeMail.to, "jo.park@example.gov");
  assert.match(codeMail.subject, /^Your code to see "Refund tracker" is \d{6}$/);
  const wrong = await visit(`${link}/verify`, { method: "POST", body: { challenge: asked.json.challenge, code: codeMail.code === "000000" ? "111111" : "000000" } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error.code, "email_code_wrong");
  const verified = await visit(`${link}/verify`, { method: "POST", body: { challenge: asked.json.challenge, code: codeMail.code } });
  assert.equal(verified.status, 200);
  assert.equal(verified.json.prototype, `/p/${FOLDER}/`);
  assert.deepEqual(verified.json.comments, []);
  assert.equal((await visit(`${link}/verify`, { method: "POST", body: { challenge: asked.json.challenge, code: codeMail.code } })).status, 403, "a code works once");
  const session = verified.json.session;
  assert.ok((await visit(`${verified.json.prototype}?review=1`)).text.includes("data-servant-review"), "the prototype they are shown listens for right-clicks");

  // A comment: saved, shown back to them, a to-do for Pat, and an alert that opens To-dos.
  assert.equal((await visit(`${link}/comments`, { method: "POST", session, body: { page: "index.html", x: 0.4, y: 0.2, text: " " } })).status, 400);
  const made = await visit(`${link}/comments`, { method: "POST", session, body: { page: `/p/${FOLDER}/index.html`, x: 0.4, y: 0.2, anchor: "Pay now", text: "This should say Pay in full" } });
  assert.equal(made.status, 201);
  assert.deepEqual([made.json.comment.page, made.json.comment.anchor, made.json.comment.text], ["index.html", "Pay now", "This should say Pay in full"]);
  assert.equal("email" in made.json.comment, false);
  assert.deepEqual((await visit(`${link}/comments`, { session })).json.comments.map(c => c.text), ["This should say Pay in full"]);
  assert.deepEqual(await waitFor(pushes, 1), [{ to: "push-pat", title: "Comment on Refund tracker", body: "jo.park@example.gov: This should say Pay in full", page: "todos" }]);
  const todos = (await api("pat", "GET", "todos")).body.todos.filter(t => /^Comment on Refund tracker/.test(t.text));
  assert.equal(todos.length, 1);
  assert.equal(todos[0].text, "Comment on Refund tracker: This should say Pay in full");
  assert.match(todos[0].description, /jo\.park@example\.gov commented on the prototype "Refund tracker"\./);
  assert.match(todos[0].description, /Where: On "Pay now", index\.html/);
  assert.match(todos[0].description, new RegExp(`Page: https://team\\.example\\.gov/p/${FOLDER}/`));
  assert.equal((await api("sam", "GET", "todos")).body.todos.some(t => /Refund tracker/.test(t.text)), false, "it is Pat's to-do, not a teammate's");
  const listed = (await api("pat", "GET", "chats/cht_proto/prototype/shares")).body.shares[0];
  assert.ok(listed.verifiedAt && listed.lastSeenAt);
  assert.deepEqual(listed.comments.map(c => [c.text, c.anchor, c.todoId]), [["This should say Pay in full", "Pay now", todos[0].id]]);

  // Sharing again replaces the link; ending the share closes the session. The comment stays.
  const again = await api("pat", "POST", "chats/cht_proto/prototype/shares", { email: "jo.park@example.gov" });
  assert.deepEqual(again.body.shares.map(s => !!s.endedAt), [false, true]);
  const newLink = linkIn(mail.splice(0)[0]);
  assert.notEqual(newLink, link);
  assert.equal((await visit(link)).status, 404, "the old link stops working");
  assert.equal((await visit(`${link}/comments`, { session })).status, 404);
  assert.equal((await visit(newLink)).status, 200);
  const live = again.body.shares[0];
  assert.equal((await api("ana", "DELETE", `chats/cht_proto/prototype/shares/${live.id}`)).status, 403);
  const ended = await api("pat", "DELETE", `chats/cht_proto/prototype/shares/${live.id}`);
  assert.equal(ended.status, 200);
  assert.equal((await visit(newLink)).status, 404);
  assert.equal(ended.body.shares.flatMap(s => s.comments).length, 1, "the comment is still on record");
  assert.equal((await api("pat", "DELETE", `chats/cht_proto/prototype/shares/${live.id}`)).status, 404);
});

test("an email that can't be sent leaves no working link, and deleting the chat ends its shares", async () => {
  mailFails = true;
  const failed = await api("pat", "POST", "chats/cht_proto/prototype/shares", { email: "sam@example.gov" });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, "email_send_failed");
  mailFails = false;
  const shares = (await api("pat", "GET", "chats/cht_proto/prototype/shares")).body.shares;
  assert.ok(shares.filter(s => s.email === "sam@example.gov").every(s => s.endedAt), "the link nobody received is ended");
  await api("pat", "POST", "chats/cht_proto/prototype/shares", { email: "sam@example.gov" });
  const link = linkIn(mail.splice(0)[0]);
  assert.equal((await visit(link)).status, 200);
  assert.equal((await api("pat", "DELETE", "chats/cht_proto")).status, 200);
  assert.equal((await visit(link)).status, 404);
  assert.equal((await visit(`${link}/code`, { method: "POST" })).status, 404);
  assert.equal((await visit("/robots.txt")).text.includes("Disallow: /review/"), true);
});
