// The wiki through the real encrypted API and a disposable SQLite file; no agent or live services.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { testFetch } from "./encrypted-test-client.mjs";
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";
import { ensureRecordsSchema, listPreserved } from "./records-preserve.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-wiki-api-"));
process.env.SERVANT_DATA_DIR = dir;
process.env.SERVANT_PORT = "0";
process.env.SERVANT_HOST = "127.0.0.1";
let mod, server, base, owner, member, other;
const config = { port: 0, name: "Test server", discovery: "off", upstreams: {} };
const saveConfig = () => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
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
  member = await pair("member", "Jo Park");
  other = await pair("member", "Ana Ruiz");
});
after(async () => { await server?.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test("members build a tree of pages, edit each other's, and only the maker or an owner deletes", async () => {
  assert.equal((await api("GET", "/v1/wiki")).status, 401, "signed-in people only");
  const empty = await api("GET", "/v1/wiki", member);
  assert.deepEqual([empty.status, empty.body.pages, empty.body.limits.depth], [200, [], 6]);
  const guide = await api("POST", "/v1/wiki", member, { title: "Team guide", body: "# Welcome\n\nStart here." });
  assert.equal(guide.status, 201, JSON.stringify(guide.body));
  const child = await api("POST", "/v1/wiki", other, { title: "Onboarding", parentId: guide.body.page.id });
  assert.equal(child.body.page.parentId, guide.body.page.id);
  const listed = (await api("GET", "/v1/wiki", other)).body.pages;
  assert.deepEqual(listed.map(page => [page.title, page.updatedByName, page.canDelete, "body" in page]), [["Team guide", "Jo Park", false, false], ["Onboarding", "Ana Ruiz", true, false]]);

  const edited = await api("PATCH", `/v1/wiki/${guide.body.page.id}`, other, { body: "Start **here**.", version: 1 });
  assert.deepEqual([edited.status, edited.body.page.body, edited.body.page.updatedByName, edited.body.page.version], [200, "Start **here**.", "Ana Ruiz", 2]);
  // An edit from the old copy is refused and handed the newer page.
  const stale = await api("PATCH", `/v1/wiki/${guide.body.page.id}`, member, { body: "Mine", version: 1 });
  assert.deepEqual([stale.status, stale.body.error.code, stale.body.error.page.body], [409, "stale", "Start **here**."]);
  assert.match(stale.body.error.message, /^Ana Ruiz changed this page while you were editing/);
  assert.equal((await api("GET", `/v1/wiki/${guide.body.page.id}`, member)).body.page.body, "Start **here**.");

  assert.equal((await api("DELETE", `/v1/wiki/${guide.body.page.id}`, other)).status, 403);
  assert.equal((await api("DELETE", `/v1/wiki/${guide.body.page.id}`, member)).status, 409, "it has a subpage");
  assert.equal((await api("DELETE", `/v1/wiki/${child.body.page.id}`, owner)).status, 200);
  assert.equal((await api("DELETE", `/v1/wiki/${guide.body.page.id}`, member)).status, 200);
  assert.equal((await api("GET", `/v1/wiki/${guide.body.page.id}`, member)).status, 404);
  assert.equal((await api("POST", "/v1/wiki", member, { title: "" })).status, 400);
  assert.equal((await api("PUT", "/v1/wiki", member, { title: "A" })).status, 404);
});

test("a page as long as the limit allows saves; a longer one is refused", async () => {
  const limit = (await api("GET", "/v1/wiki", member)).body.limits.body;
  const long = await api("POST", "/v1/wiki", member, { title: "Long", body: "é".repeat(limit) });
  assert.equal(long.status, 201, JSON.stringify(long.body).slice(0, 200));
  assert.equal((await api("PATCH", `/v1/wiki/${long.body.page.id}`, member, { body: "x".repeat(limit + 1) })).status, 413);
  assert.equal((await api("DELETE", `/v1/wiki/${long.body.page.id}`, member)).status, 200);
});

test("HTTP page changes fail closed when records cannot be archived", async () => {
  config.recordsPreservation = { enabled: true }; saveConfig();
  const made = (await api("POST", "/v1/wiki", other, { title: "Policy", body: "Keep this." })).body.page;
  const route = `/v1/wiki/${made.id}`;
  const db = new DatabaseSync(path.join(dir, "messages.db"));
  try {
    ensureRecordsSchema(db);
    db.exec("CREATE TRIGGER wiki_http_archive_fail BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT,'archive unavailable'); END;");
    const refused = await api("PATCH", route, member, { body: "Lost" });
    assert.deepEqual([refused.status, refused.body.error.code], [503, "records_preservation_failed"]);
    assert.equal((await api("DELETE", route, owner)).status, 503);
    assert.equal((await api("GET", route, member)).body.page.body, "Keep this.");
    db.exec("DROP TRIGGER wiki_http_archive_fail");
    assert.equal((await api("PATCH", route, member, { body: "Changed." })).status, 200);
    assert.equal((await api("DELETE", route, owner)).status, 200);
    assert.deepEqual(listPreserved(db).filter(record => record.event.startsWith("wiki_")).map(record => [record.event, record.text]),
      [["wiki_page_edited", "# Policy\n\nKeep this."], ["wiki_page_deleted", "# Policy\n\nChanged."]]);
  } finally { db.close(); delete config.recordsPreservation; saveConfig(); }
});

test("a page is changed by asking the agent: the draft comes back unsaved, and saving it is an ordinary edit", async () => {
  const asked = [];
  globalThis.__servantWikiAsk = async (messages, user) => { asked.push({ by: user.name, text: messages[1].content }); return { content: "Title: Travel\n\n# Trains\n\nBook early.", usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 } }; };
  try {
    const page = (await api("POST", "/v1/wiki", owner, { title: "Untitled" })).body.page;
    const drafted = await api("POST", `/v1/wiki/${page.id}/draft`, owner, { instruction: "Write a page about booking trains" });
    assert.deepEqual([drafted.status, drafted.body], [200, { draft: { title: "Travel", body: "# Trains\n\nBook early." }, version: 1 }]);
    assert.deepEqual(asked.map(item => item.by), ["Pat Tester"]);
    assert.match(asked[0].text, /Write a page about booking trains$/);
    const still = (await api("GET", `/v1/wiki/${page.id}`, owner)).body.page;
    assert.deepEqual([still.title, still.body, still.version], ["Untitled", "", 1], "a draft saves nothing");
    // Carrying on from the unsaved draft.
    assert.equal((await api("POST", `/v1/wiki/${page.id}/draft`, owner, { instruction: "Shorter", draft: drafted.body.draft })).status, 200);
    assert.match(asked[1].text, /^The page now:\n\nTitle: Travel\n\n# Trains/);
    const saved = await api("PATCH", `/v1/wiki/${page.id}`, owner, { ...drafted.body.draft, version: drafted.body.version });
    assert.deepEqual([saved.status, saved.body.page.title, saved.body.page.body], [200, "Travel", "# Trains\n\nBook early."]);

    assert.equal((await api("POST", `/v1/wiki/${page.id}/draft`, owner, { instruction: "" })).status, 400);
    assert.equal((await api("POST", "/v1/wiki/wiki_missingmissing00/draft", owner, { instruction: "x" })).status, 404);
    assert.equal((await api("POST", `/v1/wiki/${page.id}/draft`, null, { instruction: "x" })).status, 401);
    // Someone with no agent access cannot spend the agent's tokens this way.
    const refused = await api("POST", `/v1/wiki/${page.id}/draft`, member, { instruction: "x" });
    assert.deepEqual([refused.status, refused.body.error.code], [429, "usage_limit"]);
    assert.equal(asked.length, 2);
    // The agent failing leaves the page alone and says so.
    globalThis.__servantWikiAsk = async () => ({ content: "   " });
    const empty = await api("POST", `/v1/wiki/${page.id}/draft`, owner, { instruction: "x" });
    assert.deepEqual([empty.status, empty.body.error.code], [502, "agent_empty"]);
    assert.equal((await api("DELETE", `/v1/wiki/${page.id}`, owner)).status, 200);
  } finally { delete globalThis.__servantWikiAsk; }
});

// The request goes to the asker's own Agent on this server, the way an agent chat does: a session, then a turn.
test("asking for a change runs a turn on the asker's own agent and counts its tokens", async () => {
  const calls = [];
  const agent = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, key: req.headers["x-hermes-session-key"], body });
    if (req.method === "POST" && req.url === "/api/sessions") return res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ id: body.id }));
    if (req.method === "POST" && /^\/api\/sessions\/[^/]+\/chat\/stream$/.test(req.url)) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: assistant.completed\ndata: ${JSON.stringify({ content: "Title: Travel\n\nBook early." })}\n\n`);
      res.write(`event: run.completed\ndata: ${JSON.stringify({ usage: { input_tokens: 300, output_tokens: 20, total_tokens: 320 } })}\n\n`);
      return res.end();
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => agent.listen(0, "127.0.0.1", resolve));
  config.upstreams = { owner: { url: `http://127.0.0.1:${agent.address().port}`, key: "fixture-key" } }; saveConfig();
  try {
    const page = (await api("POST", "/v1/wiki", owner, { title: "Travel", body: "Book through the example app." })).body.page;
    const before = (await api("GET", "/v1/leaderboard", owner)).body;
    const drafted = await api("POST", `/v1/wiki/${page.id}/draft`, owner, { instruction: "Make this shorter" });
    assert.deepEqual([drafted.status, drafted.body.draft], [200, { title: "Travel", body: "Book early." }], JSON.stringify(drafted.body));
    assert.deepEqual(calls.map(call => [call.method, call.url.replace(/servant_wiki_[\w-]+/, "SESSION")]), [["POST", "/api/sessions"], ["POST", "/api/sessions/SESSION/chat/stream"]]);
    assert.ok(calls.every(call => call.auth === "Bearer fixture-key"));
    assert.match(calls[0].body.id, new RegExp(`^servant_wiki_${owner.user.id}_[\\w-]{12}$`), "a session of its own, under the asker");
    assert.equal(calls[1].key, `servant:wiki:${owner.user.id}`);
    assert.match(calls[1].body.system_message, /^You edit one page of a team's wiki\./);
    assert.match(calls[1].body.message, /^The page now:\n\nTitle: Travel\n\nBook through the example app\.[\s\S]*Make this shorter$/);
    assert.equal((await api("GET", `/v1/wiki/${page.id}`, owner)).body.page.body, "Book through the example app.", "still nothing saved");
    // Counted against the asker like any other turn.
    const after = (await api("GET", "/v1/leaderboard", owner)).body;
    assert.deepEqual([after.totals.total - before.totals.total, after.totals.turns - before.totals.turns], [320, 1]);
    // A second request does not reuse the first one's session.
    await api("POST", `/v1/wiki/${page.id}/draft`, owner, { instruction: "Shorter still" });
    assert.notEqual(calls[2].body.id, calls[0].body.id);
    assert.equal((await api("DELETE", `/v1/wiki/${page.id}`, owner)).status, 200);
  } finally { config.upstreams = {}; saveConfig(); await new Promise(resolve => agent.close(resolve)); }
});

test("with no agent set up, asking for a change says so and changes nothing", async () => {
  const page = (await api("POST", "/v1/wiki", owner, { title: "Notes", body: "Keep." })).body.page;
  const refused = await api("POST", `/v1/wiki/${page.id}/draft`, owner, { instruction: "Shorter" });
  assert.deepEqual([refused.status, refused.body.error.code], [503, "agent_unavailable"]);
  assert.match(refused.body.error.message, /the agent isn't set up on this server yet/);
  assert.equal((await api("GET", `/v1/wiki/${page.id}`, owner)).body.page.body, "Keep.");
  assert.equal((await api("DELETE", `/v1/wiki/${page.id}`, owner)).status, 200);
});

test("someone removed from the server loses the wiki", async () => {
  const page = (await api("POST", "/v1/wiki", member, { title: "Notes" })).body.page;
  assert.equal((await api("DELETE", `/v1/people/${member.user.id}`, owner)).status, 200);
  assert.equal((await api("GET", "/v1/wiki", member)).status, 401);
  assert.equal((await api("GET", `/v1/wiki/${page.id}`, member)).status, 401);
  assert.equal((await api("PATCH", `/v1/wiki/${page.id}`, member, { body: "Denied" })).status, 401);
  assert.equal((await api("DELETE", `/v1/wiki/${page.id}`, member)).status, 401);
  assert.equal((await api("PATCH", `/v1/wiki/${page.id}`, owner, { body: "Kept up by the owner" })).status, 200);
});
