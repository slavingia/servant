// Personal access tokens over the real server: made in the app (encrypted API), used over plain HTTP at /api/v1/
// to see prototypes, share one for review, and talk to your own agent. A stand-in agent answers every message.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === "API_SERVER_KEY") delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-tokens-http-"));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PORT = "0";
process.env.SERVANT_HOST = "127.0.0.1";
process.env.SERVANT_PUSH_CONFIG = path.join(directory, "push.json");
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
const mail = [];
globalThis.__servantEmailSend = async message => { mail.push(message); };

// The stand-in agent keeps each chat's messages and answers every one the same way.
const said = new Map();
const agent = http.createServer((req, res) => {
  let text = "";
  req.on("data", chunk => { text += chunk; });
  req.on("end", () => {
    const json = (status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (req.headers.authorization !== "Bearer fixture-key") return json(401, {});
    const body = text ? JSON.parse(text) : {};
    const session = req.url.match(/^\/api\/sessions\/([^/]+)\/(messages|chat\/stream)$/);
    if (req.url === "/api/sessions" && req.method === "POST") { said.set(body.id, []); return json(201, { id: body.id }); }
    if (!session) return json(404, {});
    const history = said.get(session[1]) || said.set(session[1], []).get(session[1]);
    if (session[2] === "messages") return json(200, { data: history });
    const reply = `You said: ${body.message}`;
    history.push({ id: `user_${history.length}`, role: "user", content: body.message }, { id: `agent_${history.length}`, role: "assistant", content: reply });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`event: assistant.completed\ndata: ${JSON.stringify({ content: reply })}\n\n`);
  });
});

const people = { ana: { name: "Ana Ruiz", role: "owner" }, pat: { name: "Pat Tester", role: "member" }, sam: { name: "Sam Lee", role: "member" } };
const FOLDER = "proto-0123456789abcdef01";
const config = { name: "Example team", agentName: "Agent", publicUrl: "https://team.example.gov", discovery: "off", upstreams: {}, emailVerification: { enabled: false, domains: ["example.gov"] } };
const saveConfig = () => fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(config));
let server, base, mod;
before(async () => {
  await new Promise(resolve => agent.listen(0, "127.0.0.1", resolve));
  config.upstreams = { owner: { url: `http://127.0.0.1:${agent.address().port}`, key: "fixture-key" } };
  saveConfig();
  mod = await import("./server.mjs"); server = await mod.startServer(); base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.join(directory, "prototypes", FOLDER), { recursive: true });
  fs.writeFileSync(path.join(directory, "prototypes", FOLDER, "index.html"), "<html><body><h1>Refund tracker</h1></body></html>");
  mod.mutateStateForTest(state => {
    for (const [key, p] of Object.entries(people)) {
      p.id = `usr_${key}`; p.device = crypto.randomBytes(32).toString("base64url");
      state.users[p.id] = { id: p.id, name: p.name, role: p.role, createdAt: Date.now(), agentTier: 2 };
      state.devices[crypto.createHash("sha256").update(p.device).digest("hex")] = { id: `dev_${key}`, userId: p.id, label: "Phone", createdAt: Date.now(), lastSeenAt: Date.now() };
    }
    const chat = (id, userId, extra) => { state.chats[id] = { id, userId, title: "Refund tracker", role: "member", hermesSessionId: `servant_${userId}_${id}`, createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now(), ...extra }; };
    chat("cht_proto", people.pat.id, { mode: "vibe", vibeFolder: FOLDER, hosted: "server" });
    chat("cht_plain", people.pat.id, { title: "Notes" });
  });
});
after(async () => { await server?.shutdown(); agent.close(); agent.closeAllConnections?.(); delete globalThis.__servantEmailSend; fs.rmSync(directory, { recursive: true, force: true }); });

// The app: the encrypted API, signed with a device.
async function app(who, method, route, body) {
  const response = await testFetch(directory, `${base}/v1/${route}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${people[who].device}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
// A shell: plain HTTP with a token, the way PowerShell or curl would send it.
async function shell(token, method, route, body) {
  const response = await fetch(`${base}/api/v1${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* the guide is text */ }
  return { status: response.status, json, text, headers: response.headers };
}

test("until an owner turns it on there is no door at all, and no token can be made", async () => {
  assert.deepEqual([(await shell(null, "GET", "")).status, (await shell("svt_" + "a".repeat(43), "GET", "/me")).status], [404, 404]);
  const listed = await app("pat", "GET", "tokens");
  assert.deepEqual([listed.status, listed.body.enabled, listed.body.tokens], [200, false, []]);
  assert.deepEqual([(await app("pat", "POST", "tokens", { name: "Work laptop" })).status, (await app("pat", "POST", "tokens", { name: "Work laptop" })).body.error.code], [404, "feature_off"]);
  config.accessTokens = { enabled: true, requestsPerMinute: 40 }; saveConfig();
  const guide = await shell(null, "GET", "");
  assert.equal(guide.status, 200);
  assert.match(guide.headers.get("content-type"), /^text\/markdown/);
  assert.match(guide.text, /\$Servant = "https:\/\/team\.example\.gov\/api\/v1"/);
  assert.doesNotMatch(guide.text, /Pat Tester|Ana Ruiz|usr_/, "the guide names nobody on the server");
});

test("a token is made in the app, shown once, and is good only at /api/v1/", async () => {
  assert.equal((await app("pat", "POST", "tokens", { name: "" })).status, 400);
  const made = await app("pat", "POST", "tokens", { name: "Work laptop", days: 30 });
  assert.equal(made.status, 201);
  people.pat.token = made.body.token;
  assert.match(people.pat.token, /^svt_[A-Za-z0-9_-]{43}$/);
  const listed = await app("pat", "GET", "tokens");
  assert.deepEqual(listed.body.tokens.map(t => [t.name, t.state]), [["Work laptop", "active"]]);
  assert.equal(JSON.stringify(listed.body).includes(people.pat.token), false, "never shown again");
  assert.equal(listed.body.address, "https://team.example.gov/api/v1");
  assert.deepEqual((await app("sam", "GET", "tokens")).body.tokens, [], "each person sees only their own");

  assert.deepEqual((await shell(people.pat.token, "GET", "/me")).json, { name: "Pat Tester", role: "member", server: "Example team" });
  // Each credential opens only its own door.
  for (const wrong of [null, "nope", people.pat.device, "svt_" + "a".repeat(43)]) assert.deepEqual([(await shell(wrong, "GET", "/me")).status, (await shell(wrong, "GET", "/me")).json.error.code], [401, "unauthorized"]);
  const plain = await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${people.pat.token}` } });
  assert.equal(plain.status, 426, "the app's API still refuses anything unencrypted");
  const sealed = await testFetch(directory, `${base}/v1/me`, { headers: { Authorization: `Bearer ${people.pat.token}` } });
  assert.equal(sealed.status, 401, "and a token is not a device, even over the encrypted API");
  // What a token can't reach simply isn't there.
  for (const route of ["/conversations", "/people", "/todos", "/tokens", "/wiki"]) assert.equal((await shell(people.pat.token, "GET", route)).status, 404);
});

test("see prototypes and send one for review; a server owner can do it for the person who made it", async () => {
  const mine = (await shell(people.pat.token, "GET", "/prototypes")).json.prototypes;
  assert.deepEqual(mine.map(p => [p.id, p.title, p.by, p.mine, p.canShare, p.url, p.sharedWith]), [["cht_proto", "Refund tracker", "Pat Tester", true, true, `https://team.example.gov/p/${FOLDER}/`, []]]);
  assert.deepEqual((await shell(people.pat.token, "GET", "/prototypes?q=permit")).json.prototypes, []);
  people.sam.token = (await app("sam", "POST", "tokens", { name: "Script" })).body.token;
  people.ana.token = (await app("ana", "POST", "tokens", { name: "Work laptop" })).body.token;
  assert.deepEqual((await shell(people.sam.token, "GET", "/prototypes")).json.prototypes, [], "a teammate doesn't see a private prototype");
  assert.equal((await shell(people.sam.token, "POST", "/prototypes/cht_proto/shares", { emails: ["jo.park@example.gov"] })).status, 404);
  assert.equal((await shell(people.pat.token, "POST", "/prototypes/cht_plain/shares", { emails: ["jo.park@example.gov"] })).status, 404, "a chat with no prototype");
  assert.equal((await shell(people.pat.token, "POST", "/prototypes/cht_proto/shares", { emails: [] })).status, 400);
  assert.equal((await shell(people.pat.token, "POST", "/prototypes/cht_proto/shares", { emails: Array(11).fill("a@example.gov") })).status, 400);

  // The owner sends Pat's prototype to two people, one at an address that isn't allowed.
  const seen = (await shell(people.ana.token, "GET", "/prototypes?q=refund")).json.prototypes;
  assert.deepEqual(seen.map(p => [p.id, p.by, p.mine, p.canShare]), [["cht_proto", "Pat Tester", false, true]]);
  const sent = await shell(people.ana.token, "POST", "/prototypes/cht_proto/shares", { emails: ["Jo.Park@example.gov", "sam@example.com"] });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.json.prototype, { id: "cht_proto", title: "Refund tracker", by: "Pat Tester" });
  assert.deepEqual(sent.json.results.map(r => [r.email, r.sent, r.error ?? null]), [["jo.park@example.gov", true, null], ["sam@example.com", false, "Use an email that ends in @example.gov"]]);
  // Each one that went out comes back with its link and a message to paste; one that didn't has neither.
  const [ok, refused] = sent.json.results;
  assert.match(ok.link, /^https:\/\/team\.example\.gov\/review\/[A-Za-z0-9_-]+$/);
  // It ends with a footnote on what Servant is, for someone who has never seen it.
  const ABOUT = "What is Servant? It is where Example team works: secure team messaging with an AI agent that builds and changes prototypes like this one. Reviewing needs no account or install; your comments go straight to the person who built it.";
  assert.equal(ok.message, `I've shared the prototype "Refund tracker" with you for review: ${ok.link}\n\nIt will ask you to confirm your email (jo.park@example.gov) with a code. Then right-click anywhere on the prototype to leave a comment.\n\n${ABOUT}`);
  assert.equal(mail[0].text.includes(`\n\n${ABOUT}\n\nIf you weren't expecting this, ignore this email.`), true, "and so does the email Servant sends");
  assert.deepEqual(["link" in refused, "message" in refused], [false, false]);
  assert.equal(mail[0].text.includes(ok.link), true, "the same link the email carries");
  // The link opens nothing by itself: the prototype still needs a code sent to that address.
  const page = await fetch(ok.link.replace("https://team.example.gov", base));
  assert.equal(page.status, 200);
  assert.equal((await page.text()).includes(FOLDER), false, "the review page does not give the prototype away before the code");
  assert.equal((await fetch(`${ok.link.replace("https://team.example.gov", base)}/comments`)).status, 401);
  assert.deepEqual(mail.map(m => [m.to, m.subject]), [["jo.park@example.gov", "Ana Ruiz shared a prototype with you: Refund tracker"]]);
  assert.match(mail[0].text, /https:\/\/team\.example\.gov\/review\/[A-Za-z0-9_-]+/);
  // With a name, the message and Servant's own email greet them by it. The name is not kept anywhere.
  mail.splice(0);
  const named = await shell(people.ana.token, "POST", "/prototypes/cht_proto/shares", { people: [{ name: "  Jo   Park ", email: "jo.park@example.gov" }] });
  assert.deepEqual([named.status, named.json.results[0].name], [201, "Jo Park"]);
  assert.match(named.json.results[0].message, /^Hi Jo, I've shared the prototype "Refund tracker" with you for review: https:\/\/team\.example\.gov\/review\//);
  assert.match(mail[0].text, /^Hi Jo Park,\n\nAna Ruiz shared the prototype "Refund tracker" with you/);
  assert.notEqual(named.json.results[0].link, ok.link, "sharing again makes a fresh link; the old one stops");
  assert.equal((await fetch(ok.link.replace("https://team.example.gov", base))).status, 404);
  assert.equal(JSON.stringify((await app("pat", "GET", "chats/cht_proto/prototype/shares")).body).includes("Jo Park"), false);
  for (const bad of [{ people: [{ name: "Jo" }] }, { people: [{ name: 7, email: "jo.park@example.gov" }] }, { people: "jo.park@example.gov" }]) assert.equal((await shell(people.ana.token, "POST", "/prototypes/cht_proto/shares", bad)).status, 400);
  // An owner can also invite the person onto the server with the same request: a single-use link in their name,
  // in the message and in the email, that starts them as a business owner.
  mail.splice(0);
  assert.deepEqual([(await shell(people.pat.token, "POST", "/prototypes/cht_proto/shares", { people: [{ name: "Jo Park", email: "jo.park@example.gov" }], invite: true })).status, mail.length], [403, 0], "only an owner brings people onto the server");
  assert.equal((await shell(people.ana.token, "POST", "/prototypes/cht_proto/shares", { emails: ["jo.park@example.gov"], invite: true })).status, 400, "an invite needs a name");
  assert.equal((await shell(people.ana.token, "POST", "/prototypes/cht_proto/shares", { people: [{ name: "Jo Park", email: "jo.park@example.gov" }], invite: "yes" })).status, 400);
  const invited = await shell(people.ana.token, "POST", "/prototypes/cht_proto/shares", { people: [{ name: "Jo Park", email: "jo.park@example.gov" }, { name: "Sam Outside", email: "sam@example.com" }], invite: true });
  const [jo, outside] = invited.json.results;
  assert.match(jo.join, /^https:\/\/team\.example\.gov\/join\?code=/);
  // When they are invited too, the footnote says what joining adds.
  const JOINING = " If you join, you can ask the agent for changes yourself, build prototypes of your own and talk with the team, in a browser or the phone and Mac apps.";
  assert.equal(jo.message.endsWith(`\n\nTo use the rest of Servant with the team, join here (works once, for a week): ${jo.join}\n\n${ABOUT}${JOINING}`), true);
  assert.equal(mail[0].text.includes(`${ABOUT}${JOINING}\n\nIf you weren't expecting this`), true);
  assert.equal(mail[0].text.includes(`To use the rest of Servant with the team, join here: ${jo.join}`), true);
  assert.deepEqual([outside.sent, "join" in outside, mail.length], [false, false, 1], "no invite is made for an address that can't be shared with");
  // Joining with it makes Jo a member who starts as a business owner, invited by Ana. The link works once.
  const { TERMS_VERSION, TERMS_ITEMS } = await import("./terms.mjs");
  const code = new URL(jo.join).searchParams.get("code");
  const pair = body => testFetch(directory, `${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const joined = await pair({ code, device: "Browser", terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
  assert.equal(joined.status, 201);
  const account = await joined.json();
  assert.deepEqual([account.user.name, account.user.role], ["Jo Park", "member"]);
  const listed = (await app("ana", "GET", "people")).body.people.find(p => p.id === account.user.id);
  assert.deepEqual([listed.agentTier, listed.vibeCoder], [2, true], "a business owner, able to prototype");
  assert.equal((await pair({ code, device: "Browser", terms: { version: TERMS_VERSION, items: TERMS_ITEMS } })).status >= 400, true, "used once");
  // The app's own Share never returns the link: there it is still only in the email.
  assert.equal(JSON.stringify((await app("pat", "GET", "chats/cht_proto/prototype/shares")).body).includes("/review/"), false);
  // The share is Pat's: it is in Pat's share sheet, and comments will arrive in Pat's chat.
  assert.deepEqual((await app("pat", "GET", "chats/cht_proto/prototype/shares")).body.shares.filter(s => !s.endedAt).map(s => s.email), ["jo.park@example.gov"]);
  assert.deepEqual((await shell(people.pat.token, "GET", "/prototypes")).json.prototypes[0].sharedWith, [{ email: "jo.park@example.gov", opened: false, comments: 0 }]);
  // The app's own Share still works the same way, through the same code.
  mail.splice(0);
  assert.equal((await app("pat", "POST", "chats/cht_proto/prototype/shares", { email: "sam.lee@example.gov" })).status, 201);
  assert.deepEqual(mail.map(m => m.subject), ["Pat Tester shared a prototype with you: Refund tracker"]);
});

test("a message to your own agent, and its answer read back", async () => {
  assert.equal((await shell(people.pat.token, "POST", "/agent", { text: " " })).status, 400);
  assert.equal((await shell(people.pat.token, "POST", "/agent", ["text"])).status, 400);
  const sent = await shell(people.pat.token, "POST", "/agent", { text: "Summarize the refund prototype" });
  assert.equal(sent.status, 202, JSON.stringify(sent.json));
  assert.deepEqual([sent.json.status, sent.json.read, typeof sent.json.turnId], ["queued", `/api/v1/agent/${sent.json.chatId}`, "string"]);
  let chat;
  for (let i = 0; i < 200; i++) { chat = (await shell(people.pat.token, "GET", `/agent/${sent.json.chatId}`)).json; if (!chat.working && chat.turns.at(-1)?.reply) break; await new Promise(r => setTimeout(r, 25)); }
  assert.deepEqual([chat.working, chat.needsApproval, chat.title], [false, false, "Summarize the refund prototype"]);
  assert.deepEqual(chat.turns.map(t => [t.id, t.text, t.reply]), [[sent.json.turnId, "Summarize the refund prototype", "You said: Summarize the refund prototype"]], "sent as written, with nothing put around it");
  // It is an ordinary private chat of Pat's, there in the app too.
  assert.equal((await app("pat", "GET", `chats/${sent.json.chatId}`)).status, 200);
  assert.equal((await shell(people.sam.token, "GET", `/agent/${sent.json.chatId}`)).status, 404, "not someone else's to read");
  assert.equal((await shell(people.ana.token, "GET", `/agent/${sent.json.chatId}`)).status, 404, "not even the owner's, through a token");
  // One more message in the same chat.
  const more = await shell(people.pat.token, "POST", "/agent", { text: "Shorter", chatId: sent.json.chatId });
  assert.equal(more.status, 202);
  for (let i = 0; i < 200; i++) { chat = (await shell(people.pat.token, "GET", `/agent/${sent.json.chatId}`)).json; if (!chat.working && chat.turns.length === 2 && chat.turns[1].reply) break; await new Promise(r => setTimeout(r, 25)); }
  assert.deepEqual(chat.turns.map(t => t.reply), ["You said: Summarize the refund prototype", "You said: Shorter"]);
  assert.equal((await shell(people.sam.token, "POST", "/agent", { text: "Hi", chatId: sent.json.chatId })).status, 404);
  // Someone with no agent access is told so, and nothing is started.
  mod.mutateStateForTest(state => { state.users[people.sam.id].agentTier = 0; });
  assert.deepEqual([(await shell(people.sam.token, "POST", "/agent", { text: "Hi" })).status, (await shell(people.sam.token, "POST", "/agent", { text: "Hi" })).json.error.code], [429, "usage_limit"]);
});

test("a token stops when it is revoked, when its person leaves, and when it has used up its minute", async () => {
  const id = (await app("pat", "GET", "tokens")).body.tokens[0].id;
  assert.equal((await app("sam", "DELETE", `tokens/${id}`)).status, 404, "only your own");
  const revoked = await app("pat", "DELETE", `tokens/${id}`);
  assert.deepEqual([revoked.status, revoked.body.tokens.map(t => t.state)], [200, ["revoked"]]);
  assert.equal((await shell(people.pat.token, "GET", "/me")).status, 401);
  assert.equal((await app("pat", "DELETE", `tokens/${id}`)).status, 404);
  // Forty requests a minute on this server: the owner's token runs out and is told to wait.
  let limited = null;
  for (let i = 0; i < 45 && !limited; i++) { const r = await shell(people.ana.token, "GET", "/me"); if (r.status === 429) limited = r; }
  assert.deepEqual([limited.json.error.code, limited.headers.get("retry-after")], ["rate_limited", "60"]);
  // Sam is removed from the server: Sam's token goes with them.
  assert.equal((await shell(people.sam.token, "GET", "/me")).status, 200);
  assert.equal((await app("ana", "DELETE", `people/${people.sam.id}`)).status, 200);
  assert.equal((await shell(people.sam.token, "GET", "/me")).status, 401);
});
