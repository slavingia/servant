// Personal connections over the real API (docs/connections.md): a person saves their own GitHub token, the agent's
// turns carry where to fetch it, only that person's turn gets it, and nothing the server stores, returns or sends
// holds the value.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { testFetch } from "./encrypted-test-client.mjs";

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === "API_SERVER_KEY") delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-connections-http-"));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PUSH_CONFIG = path.join(directory, "push.json");
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, "{}");
// The network gate and the entitlement checks are both off: connections work without them.
const config = { host: "127.0.0.1", port: 0, name: "Example team", agentName: "Agent", publicUrl: "", discoveryUrl: "", adminKey: "", upstreams: {},
  connections: { types: [{ id: "tax-api", name: "Tax data API", createUrl: "https://api.example.gov/keys", fields: [{ key: "key", label: "API key", placeholder: "tax_…", pattern: "^tax_[a-z0-9]{12}$", detect: "tax_[a-z0-9]{12}" }], env: { TAX_API_KEY: "{key}" } }] } };

// Made-up values in the shapes the real ones have, put together here so no file holds one whole.
const PAT_TOKEN = "ghp_" + "p".repeat(32) + "a1b2";
const PAT_NEW = "github_pat_" + "n".repeat(40) + "c3d4";
const JO_TOKEN = "ghp_" + "j".repeat(32) + "e5f6";
const BAD_TOKEN = "ghp_" + "b".repeat(36);
const JIRA_TOKEN = "ATATT3" + "z".repeat(40) + "g7h8";
const SECRETS = [PAT_TOKEN, PAT_NEW, JO_TOKEN, BAD_TOKEN, JIRA_TOKEN];

// A stand-in for the agent: it records what each turn was sent with, and answers with whatever the test set.
const turns = [];
let reply = "Done", upstreamHistory = [];
const agent = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const json = (status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  if (req.url === "/v1/capabilities") return json(200, { features: {} });
  if (req.method === "POST" && req.url === "/api/sessions") return json(201, { session: { id: "made" } });
  if (req.method === "POST" && req.url.endsWith("/chat/stream")) {
    const body = JSON.parse(raw || "{}");
    turns.push({ url: req.url, token: req.headers["x-servant-egress-token"], door: req.headers["x-servant-connections-door"], checks: req.headers["x-servant-door"], instructions: body.system_message || "", message: body.message });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // The reply arrives in small pieces, so a token is split across them.
    for (let at = 0; at < reply.length; at += 7) res.write(`event: assistant.delta\ndata: ${JSON.stringify({ delta: reply.slice(at, at + 7) })}\n\n`);
    return res.end(`event: assistant.completed\ndata: ${JSON.stringify({ content: reply })}\n\n`);
  }
  if (req.method === "GET" && req.url.endsWith("/messages")) return json(200, { data: upstreamHistory });
  return json(200, { session: { id: "known" } });
});

const pushes = [];
globalThis.__servantPushSend = async (target, notification) => { pushes.push({ to: target.token, title: notification.title, body: notification.body }); return { ok: true }; };
// A stand-in for GitHub: whose token is this? No network in tests.
const checked = [];
globalThis.__servantConnectionCheck = async values => { checked.push(values.token.slice(-4)); return values.token === BAD_TOKEN ? { ok: false } : { ok: true, account: values.token === JO_TOKEN ? "@jo-park" : "@pat-tester" }; };

const people = { owner: { name: "Ana Ruiz", role: "owner" }, jo: { name: "Jo Park", role: "member" }, pat: { name: "Pat Tester", role: "member" }, sam: { name: "Sam Lee", role: "member", agentTier: 4 } };
let server, base, mod;
before(async () => {
  await new Promise(done => agent.listen(0, "127.0.0.1", done));
  const up = { url: `http://127.0.0.1:${agent.address().port}`, key: "fixture-key" };
  config.upstreams = { owner: up, member: up, researcher: up };
  mod = await import("./server.mjs"); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`;
  mod.mutateStateForTest(state => {
    let at = Date.now() - 10_000;
    for (const [key, p] of Object.entries(people)) {
      p.id = `usr_${key}`; p.token = crypto.randomBytes(32).toString("base64url");
      state.users[p.id] = { id: p.id, name: p.name, role: p.role, createdAt: at++, agentTier: p.agentTier ?? 3 };
      state.devices[crypto.createHash("sha256").update(p.token).digest("hex")] = { id: `dev_${key}`, userId: p.id, label: "Phone", createdAt: Date.now(), lastSeenAt: Date.now(),
        push: { platform: "ios", token: `push-${key}`, environment: "production" } };
    }
  });
});
after(async () => { await server?.shutdown(); agent.close(); agent.closeAllConnections?.(); delete globalThis.__servantPushSend; delete globalThis.__servantConnectionCheck; fs.rmSync(directory, { recursive: true, force: true }); });

async function call(token, method, route, body) {
  const response = await testFetch(directory, `${base}/v1/${route}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
const api = (who, method, route, body) => call(people[who].token, method, route, body);
let requestNumber = 0;
// Send a message in an agent chat and read the whole stream of the reply.
async function say(who, chatId, text) {
  const response = await testFetch(directory, `${base}/v1/chats/${chatId}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${people[who].token}` }, body: JSON.stringify({ text, requestId: `request_${++requestNumber}_${crypto.randomBytes(4).toString("hex")}` }) });
  const stream = await response.text();
  if (response.status !== 200) return { status: response.status, body: JSON.parse(stream), events: [] };
  const events = stream.split("\n\n").map(block => ({ event: /^event: (.+)$/m.exec(block)?.[1], data: /^data: (.+)$/m.exec(block)?.[1] })).filter(e => e.event).map(e => ({ event: e.event, data: JSON.parse(e.data) }));
  return { status: 200, events, stream };
}
const door = async (port, route, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const holdsNoSecret = (value, why) => { const text = typeof value === "string" ? value : JSON.stringify(value); for (const secret of SECRETS) assert.ok(!text.includes(secret), `${why} holds a saved value`); };

test("everyone sees the tool types and their own standing; saving checks the format, then asks GitHub whose token it is", async () => {
  const start = (await api("pat", "GET", "connections")).body;
  assert.equal(start.agent, "full");
  assert.deepEqual(start.tools.map(t => [t.id, t.mine]), [["github", null], ["jira", null], ["tax-api", null]]);
  assert.equal(start.tools[0].heading, "GitHub token for your account");
  assert.equal(start.tools[0].createUrl, "https://github.com/settings/personal-access-tokens/new");
  assert.equal(start.tools[1].createUrl, "https://id.atlassian.com/manage-profile/security/api-tokens");
  assert.ok(!("env" in start.tools[0]) && !("detect" in start.tools[0].fields[0]), "how values reach the agent is not the app's to know");

  const wrongShape = await api("pat", "PUT", "connections/github", { values: { token: "hunter2" } });
  assert.equal(wrongShape.status, 400);
  assert.equal(wrongShape.body.error.code, "bad_format");
  assert.match(wrongShape.body.error.message, /Personal access token doesn't look right/);
  assert.equal((await api("pat", "PUT", "connections/github", { values: {} })).status, 400);
  assert.equal((await api("pat", "PUT", "connections/nothing", { values: { token: PAT_TOKEN } })).status, 404);
  assert.deepEqual(checked, [], "GitHub is only asked about a token of the right shape");

  const rejected = await api("pat", "PUT", "connections/github", { values: { token: BAD_TOKEN } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "token_rejected");
  assert.equal(rejected.body.error.message, "GitHub didn't accept that token. Check that it hasn't expired and that you copied all of it, then try again");
  holdsNoSecret(rejected.body, "a refusal");
  assert.equal((await api("pat", "GET", "connections")).body.tools[0].mine, null, "a rejected token is not saved");

  const saved = await api("pat", "PUT", "connections/github", { values: { token: PAT_TOKEN } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.replaced, false);
  assert.equal(saved.body.checked, true);
  assert.deepEqual({ ...saved.body.tool.mine, savedAt: 0 }, { type: "github", last4: "a1b2", account: "@pat-tester", savedAt: 0 });
  holdsNoSecret(saved.body, "the answer to saving");

  const replaced = await api("pat", "PUT", "connections/github", { values: { token: PAT_NEW } });
  assert.equal(replaced.body.replaced, true);
  assert.equal(replaced.body.tool.mine.last4, "c3d4");
  await api("pat", "PUT", "connections/github", { values: { token: PAT_TOKEN } });
  // A tool with several fields, and one the owner defined in config.json.
  const jira = await api("pat", "PUT", "connections/jira", { values: { site: "example.atlassian.net", email: "pat@example.gov", token: JIRA_TOKEN } });
  assert.equal(jira.body.tool.mine.last4, "g7h8");
  assert.equal((await api("pat", "PUT", "connections/jira", { values: { site: "example.gov", email: "pat@example.gov", token: JIRA_TOKEN } })).body.error.code, "bad_format");
  assert.equal((await api("pat", "PUT", "connections/tax-api", { values: { key: "tax_abcdef123456" } })).body.tool.mine.last4, "3456");
  assert.equal((await api("pat", "DELETE", "connections/tax-api")).status, 200);
  assert.equal((await api("pat", "DELETE", "connections/tax-api")).status, 404);
  assert.equal((await api("jo", "PUT", "connections/github", { values: { token: JO_TOKEN } })).body.tool.mine.account, "@jo-park");

  // Nobody is shown anyone's value: not the person, not another member, not the owner.
  for (const who of ["pat", "jo", "owner"]) {
    const listed = await api(who, "GET", "connections");
    holdsNoSecret(listed.body, `${who}'s list`);
    assert.equal(listed.body.tools[0].mine?.last4, { pat: "a1b2", jo: "e5f6", owner: undefined }[who], "each person sees only their own standing");
    holdsNoSecret((await api(who, "GET", "connections/history?all=1")).body, `${who}'s history`);
  }
  const mine = (await api("pat", "GET", "connections/history?all=1")).body.history;
  assert.ok(mine.every(h => h.userId === people.pat.id), "a member sees only their own history, whatever they ask for");
  assert.deepEqual(mine.map(h => `${h.tool} ${h.action}`).reverse(), ["GitHub saved", "GitHub replaced", "GitHub replaced", "Jira saved", "Tax data API saved", "Tax data API removed"]);
  const everyone = (await api("owner", "GET", "connections/history?all=1")).body.history;
  assert.ok(everyone.some(h => h.name === "Jo Park" && h.action === "saved"), "an owner sees who saved what, and when");
  assert.equal((await call(null, "GET", "connections")).status, 401);
});

test("someone whose agent can't run commands is told an owner has to give them the full agent first", async () => {
  assert.equal((await api("sam", "GET", "connections")).body.agent, "restricted");
  const refused = await api("sam", "PUT", "connections/github", { values: { token: PAT_TOKEN } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.message, "Your agent can't run commands, so it can't use this yet. Ask an owner to give you the full agent first");
  // Even a signed token gets a restricted person no environment (asked of the door in the next test).
  assert.deepEqual(mod.connectionsForTest().store.list(people.sam.id), []);
});

test("a turn of someone with a connection says where to fetch it; the door gives only the token owner's environment", async () => {
  const chat = (await api("pat", "POST", "chats", {})).body.chat;
  reply = "Opened the pull request.";
  await say("pat", chat.id, "Open a pull request");
  const turn = turns.at(-1);
  assert.match(turn.door, /^\d+$/, "sent even though the gate and the checks are off");
  assert.ok(turn.token);
  assert.equal(turn.checks, undefined, "the entitlement checks stay off: this is a different question");
  assert.match(turn.instructions, /Your commands have this person's own GitHub token in GH_TOKEN and GITHUB_TOKEN \(connected as @pat-tester\)\. Use it; don't use any other GitHub login\./);
  assert.match(turn.instructions, /Your commands have this person's own Jira credentials in JIRA_SITE, JIRA_EMAIL and JIRA_API_TOKEN\./);
  assert.match(turn.instructions, /Only when a task needs Tax data API for this person, ask for their token by writing \[\[connect:tax-api\]\] on its own line; Servant shows them a secure form\. Never ask them to paste a token in chat\./);
  holdsNoSecret(turn, "what the agent was sent");

  const mine = await door(turn.door, "/connections", { token: turn.token });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body, { env: { GH_TOKEN: PAT_TOKEN, GITHUB_TOKEN: PAT_TOKEN, JIRA_SITE: "example.atlassian.net", JIRA_EMAIL: "pat@example.gov", JIRA_API_TOKEN: JIRA_TOKEN }, connections: ["github", "jira"] });

  // Jo's turn, in Jo's chat, gets Jo's and nothing of Pat's.
  const joChat = (await api("jo", "POST", "chats", {})).body.chat;
  await say("jo", joChat.id, "Check my issues");
  const joTurn = turns.at(-1);
  assert.notEqual(joTurn.token, turn.token);
  assert.deepEqual((await door(joTurn.door, "/connections", { token: joTurn.token })).body, { env: { GH_TOKEN: JO_TOKEN, GITHUB_TOKEN: JO_TOKEN }, connections: ["github"] });

  // Someone with no connection has no door to ask at, and a token nobody signed opens nothing.
  const ownerChat = (await api("owner", "POST", "chats", {})).body.chat;
  await say("owner", ownerChat.id, "Hello");
  assert.equal(turns.at(-1).door, undefined);
  assert.equal(turns.at(-1).token, undefined);
  assert.doesNotMatch(turns.at(-1).instructions ?? "", /\[\[connect:/, "an owner's agent already has the server's logins and is never prompted to ask for a token");
  const forged = `${turn.token.split(".")[0]}.${turn.token.split(".")[1]}.${"A".repeat(43)}`;
  for (const bad of [forged, "", "not-a-token", undefined]) {
    const refused = await door(turn.door, "/connections", { token: bad });
    assert.equal(refused.status, 403, String(bad));
    assert.equal(refused.body.env, undefined);
    holdsNoSecret(refused.body, "a refusal at the door");
  }
  assert.equal((await fetch(`http://127.0.0.1:${turn.door}/connections`)).status, 404, "only POST");
  // A token for someone who has since left opens nothing.
  const leaver = mod.egressForTest().mint("usr_left", "cht_1");
  assert.equal((await door(turn.door, "/connections", { token: leaver })).status, 403);
  // Someone on the restricted agent gets no environment even with a signed token.
  assert.deepEqual((await door(turn.door, "/connections", { token: mod.egressForTest().mint(people.sam.id, "cht_1") })).body, { env: {}, connections: [] });

  const used = (await api("pat", "GET", "connections/history")).body.history.filter(h => h.action === "used");
  assert.deepEqual(used.map(h => [h.tool, h.chatId]).sort(), [["GitHub", chat.id], ["Jira", chat.id]].sort(), "each use is written down, per tool and chat");
  assert.ok((await api("pat", "GET", "connections")).body.tools[0].mine.usedAt, "and shown as last used");
});

test("[[connect:type]] in a reply becomes a form on that message; the marker text is gone and unknown types are dropped", async () => {
  await api("pat", "DELETE", "connections/jira");
  const chat = (await api("pat", "POST", "chats", {})).body.chat;
  reply = "I need Jira to file this.\n\n[[connect:jira]]\n[[connect:slack]]\n\nThen I'll carry on.";
  upstreamHistory = [];
  const sent = await say("pat", chat.id, "File a ticket");
  const message = sent.events.find(e => e.event === "message").data;
  assert.equal(message.text, "I need Jira to file this.\n\nThen I'll carry on.");
  assert.equal(message.connect.length, 1);
  const part = message.connect[0];
  assert.deepEqual({ mine: part.mine, status: part.status, agent: part.agent, tool: part.tool.id, heading: part.tool.heading }, { mine: true, status: "open", agent: "full", tool: "jira", heading: "Jira API token" });
  assert.deepEqual(part.tool.fields.map(f => [f.key, f.secret]), [["site", false], ["email", false], ["token", true]]);
  assert.ok(!sent.stream.includes("[[connect"), "the marker never reaches the app, even as the reply streams");
  // The same message, read again later; Hermes still has the reply as the agent wrote it.
  upstreamHistory = [{ id: "up_1", role: "user", content: "File a ticket" }, { id: "up_2", role: "assistant", content: reply }];
  const loaded = (await api("pat", "GET", `chats/${chat.id}/messages`)).body.messages;
  assert.deepEqual(loaded.map(m => [m.role, m.text]), [["user", "File a ticket"], ["assistant", "I need Jira to file this.\n\nThen I'll carry on."]], "one copy of the reply, without the marker");
  assert.equal(loaded[1].connect[0].requestId, part.requestId);
  // An owner reading the chat sees that it was asked, and nothing of where it stands in detail.
  mod.mutateStateForTest(state => { state.chats[chat.id].shared = true; });
  const seen = (await api("owner", "GET", `chats/${chat.id}/messages`)).body.messages.find(m => m.connect);
  assert.deepEqual({ mine: seen.connect[0].mine, status: seen.connect[0].status, last4: seen.connect[0].last4 }, { mine: false, status: "open", last4: undefined });
  assert.equal((await api("owner", "POST", `connections/requests/${part.requestId}/decline`, {})).status, 404, "only the person asked can answer");

  // Saving from the form answers it: the card shows the last four characters, never the value.
  await api("pat", "PUT", "connections/jira", { values: { site: "example.atlassian.net", email: "pat@example.gov", token: JIRA_TOKEN } });
  const after = (await api("pat", "GET", `chats/${chat.id}/messages`)).body.messages.find(m => m.connect).connect[0];
  assert.deepEqual({ status: after.status, last4: after.last4 }, { status: "saved", last4: "g7h8" });
  holdsNoSecret(after, "the saved card");
  assert.equal((await api("pat", "POST", `connections/requests/${part.requestId}/decline`, {})).status, 409);
  upstreamHistory = [];
});

test("declining tells the agent, and it is not asked again in that chat", async () => {
  const chat = (await api("pat", "POST", "chats", {})).body.chat;
  reply = "[[connect:tax-api]]";
  const sent = await say("pat", chat.id, "Look up the filing");
  const message = sent.events.find(e => e.event === "message").data;
  assert.equal(message.text, "");
  const declined = await api("pat", "POST", `connections/requests/${message.connect[0].requestId}/decline`, {});
  assert.deepEqual(declined.body, { request: { id: message.connect[0].requestId, status: "declined" } });
  assert.equal((await api("pat", "GET", `chats/${chat.id}/messages`)).body.messages.find(m => m.connect).connect[0].status, "declined");
  // The agent asks again anyway: it is told not to, and no new form appears.
  const again = await say("pat", chat.id, "Carry on");
  assert.match(turns.at(-1).instructions, /This person declined to connect Tax data API in this chat\. Don't ask again here/);
  assert.doesNotMatch(turns.at(-1).instructions, /connect:tax-api/);
  assert.equal(again.events.find(e => e.event === "message").data.connect, undefined);
  // In another chat the agent may still ask.
  const other = (await api("pat", "POST", "chats", {})).body.chat;
  const elsewhere = await say("pat", other.id, "Look up the filing");
  assert.equal(elsewhere.events.find(e => e.event === "message").data.connect[0].status, "open");
});

test("a token typed into a chat is refused, not stored and not sent to the agent", async () => {
  const chat = (await api("pat", "POST", "chats", {})).body.chat;
  const count = turns.length;
  const refused = await say("pat", chat.id, `Here is my token: ${JO_TOKEN}`);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, "secret_in_chat");
  assert.equal(refused.body.error.message, "That looks like a GitHub token. Use Connections so it stays out of chat.");
  assert.equal(turns.length, count, "the agent never saw it");
  assert.equal((await say("pat", chat.id, `export JIRA_API_TOKEN=${JIRA_TOKEN}`)).body.error.message, "That looks like a Jira token. Use Connections so it stays out of chat.");
  assert.equal((await say("pat", chat.id, "use tax_abcdef123456 please")).body.error.message, "That looks like a Tax data API token. Use Connections so it stays out of chat.");
  assert.deepEqual((await api("pat", "GET", `chats/${chat.id}/messages`)).body.messages, []);
  // The same in a channel, and when editing a message that was fine before.
  const general = (await api("pat", "POST", "conversations", { name: "token-talk", private: true })).body.conversation;
  const posted = await api("pat", "POST", `conversations/${general.id}/messages`, { text: `the token is ${PAT_NEW}` });
  assert.equal(posted.status, 400);
  assert.equal(posted.body.error.message, "That looks like a GitHub token. Use Connections so it stays out of chat.");
  const fine = await api("pat", "POST", `conversations/${general.id}/messages`, { text: "A classic token starts with ghp_ and a fine-grained one with github_pat_" });
  assert.equal(fine.status, 201);
  const edited = await api("pat", "PATCH", `messages/${fine.body.message.id}`, { text: `oops ${PAT_NEW}` });
  assert.equal(edited.status, 400);
  assert.equal(edited.body.error.code, "secret_in_chat");
  const kept = (await api("pat", "GET", `conversations/${general.id}/messages`)).body.messages;
  holdsNoSecret(kept, "the channel");
});

test("a saved value the agent writes back is hidden before it is stored, streamed, notified or read again", async () => {
  const chat = (await api("pat", "POST", "chats", {})).body.chat;
  pushes.length = 0;
  // Pat's own token, and someone else's that only its shape gives away.
  reply = `I ran echo and got ${PAT_TOKEN} back. Another one: ${JO_TOKEN}.`;
  upstreamHistory = [];
  const sent = await say("pat", chat.id, "What is in the environment?");
  holdsNoSecret(sent.stream, "the stream of the reply");
  assert.equal(sent.events.find(e => e.event === "message").data.text, "I ran echo and got [hidden] back. Another one: [hidden].");
  assert.equal(sent.events.filter(e => e.event === "delta").map(e => e.data.text).join(""), "I ran echo and got [hidden] back. Another one: [hidden].", "pieces are cleaned a word at a time, so a token split across them is still hidden");
  assert.ok(sent.events.filter(e => e.event === "delta").length > 3, "and the reply still streams");
  upstreamHistory = [{ id: "up_3", role: "user", content: "What is in the environment?" }, { id: "up_4", role: "assistant", content: reply }];
  const loaded = (await api("pat", "GET", `chats/${chat.id}/messages`)).body.messages;
  assert.deepEqual(loaded.map(m => m.text), ["What is in the environment?", "I ran echo and got [hidden] back. Another one: [hidden]."]);
  holdsNoSecret((await api("pat", "GET", `chats/${chat.id}/turns`)).body, "the turn journal");
  for (let i = 0; i < 200 && !pushes.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(pushes.length >= 1, "the reply was notified");
  holdsNoSecret(pushes, "a notification");
  upstreamHistory = [];
  // Nothing the server keeps on disk outside connections.db holds a value in the clear.
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (!fs.statSync(file).isFile()) continue;
    holdsNoSecret(fs.readFileSync(file).toString("latin1"), name);
  }
});

test("someone removed from the server loses what they saved, and their token opens nothing", async () => {
  const chat = (await api("jo", "POST", "chats", {})).body.chat;
  reply = "Done";
  await say("jo", chat.id, "Hello");
  const turn = turns.at(-1);
  assert.equal((await door(turn.door, "/connections", { token: turn.token })).body.env.GH_TOKEN, JO_TOKEN);
  assert.equal((await api("owner", "DELETE", `people/${people.jo.id}`)).status, 200);
  assert.equal((await door(turn.door, "/connections", { token: turn.token })).status, 403);
  const left = (await api("owner", "GET", "connections/history?all=1")).body.history.find(h => h.userId === people.jo.id);
  assert.deepEqual([left.action, left.detail], ["removed", { reason: "Left the server" }]);
  assert.deepEqual(mod.connectionsForTest().store.list(people.jo.id), []);
});
