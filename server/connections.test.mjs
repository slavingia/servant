// Personal connections (connections.mjs): a person's own tool credentials, encrypted at rest, never returned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILTIN_TOOLS, HIDDEN, checkGithubToken, cleanTool, cleanValues, createConnections, createTextStream, loadConnectionsKey, publicTool, readConnectMarkers, redactor, stripConnectMarkers, tokenInChatMessage, tokenInText, toolCatalog, toolEnv } from "./connections.mjs";

// Made-up values in the shapes the real ones have, put together here so no file holds one whole.
const GH = "ghp_" + "x".repeat(32) + "a1b2";
const GH_FINE = "github_pat_" + "y".repeat(40) + "c3d4";
const JIRA = "ATATT3" + "z".repeat(40) + "e5f6";
const jiraValues = { site: "example.atlassian.net", email: "pat@example.gov", token: JIRA };

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-connections-"));
  let now = 1_000;
  const file = path.join(directory, "connections.db");
  const store = createConnections({ file, clock: () => now++, ...options });
  return { directory, file, store, tick: ms => { now += ms; }, done: () => { try { store.close(); } catch { /* already closed */ } fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("the key file is made once, is 32 bytes and only the server's user can read it", () => {
  const f = fixture();
  try {
    const keyFile = path.join(f.directory, "connections-key");
    const first = fs.readFileSync(keyFile);
    assert.equal(first.length, 32);
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    fs.chmodSync(keyFile, 0o644);
    assert.deepEqual(loadConnectionsKey(keyFile), first, "an existing key is kept, not replaced");
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, "and its permissions are put right");
    fs.writeFileSync(path.join(f.directory, "short"), "too short");
    assert.throws(() => loadConnectionsKey(path.join(f.directory, "short")), /Invalid connections key/);
  } finally { f.done(); }
});

test("values are encrypted at rest and come back only as the person's own command environment", () => {
  const f = fixture();
  try {
    const saved = f.store.save("usr_pat", "github", { token: `  ${GH}  ` }, { account: "@pat" });
    assert.deepEqual(saved, { connection: { type: "github", last4: "a1b2", account: "@pat", savedAt: saved.connection.savedAt }, replaced: false });
    f.store.save("usr_pat", "jira", jiraValues);
    f.store.save("usr_jo", "github", { token: GH_FINE });
    // Nothing on disk holds a value in the clear: not the database, its journal, nor the key file.
    for (const name of fs.readdirSync(f.directory)) {
      const bytes = fs.readFileSync(path.join(f.directory, name)).toString("latin1");
      for (const secret of [GH, GH_FINE, JIRA, "pat@example.gov"]) assert.ok(!bytes.includes(secret), `${name} holds a value in the clear`);
    }
    assert.deepEqual(f.store.envFor("usr_pat", { chatId: "cht_1" }), { env: { GH_TOKEN: GH, GITHUB_TOKEN: GH, JIRA_SITE: "example.atlassian.net", JIRA_EMAIL: "pat@example.gov", JIRA_API_TOKEN: JIRA }, types: ["github", "jira"] });
    assert.deepEqual(f.store.envFor("usr_jo"), { env: { GH_TOKEN: GH_FINE, GITHUB_TOKEN: GH_FINE }, types: ["github"] });
    assert.deepEqual(f.store.envFor("usr_nobody"), { env: {}, types: [] });
    assert.deepEqual(f.store.secrets("usr_pat").sort(), [GH, JIRA].sort(), "only secret fields are hidden, not the site or email");
    assert.ok(f.store.status("usr_pat", "github").usedAt, "using it is remembered");
  } finally { f.done(); }
});

test("a row copied onto another person does not open, and a wrong key reads nothing", () => {
  const f = fixture();
  try {
    f.store.save("usr_pat", "github", { token: GH });
    f.store.close();
    const db = new DatabaseSync(f.file);
    db.prepare("INSERT INTO connections(user_id,type,sealed,last4,saved_at) SELECT 'usr_jo', type, sealed, last4, saved_at FROM connections").run();
    db.close();
    const errors = [], original = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      const reopened = createConnections({ file: f.file });
      assert.deepEqual(reopened.envFor("usr_jo"), { env: {}, types: [] }, "sealed for Pat, so it is not Jo's");
      assert.equal(reopened.envFor("usr_pat").env.GH_TOKEN, GH);
      reopened.close();
      fs.writeFileSync(path.join(f.directory, "connections-key"), Buffer.alloc(32, 7));
      const wrong = createConnections({ file: f.file });
      assert.deepEqual(wrong.envFor("usr_pat"), { env: {}, types: [] });
      assert.deepEqual(wrong.secrets("usr_pat"), []);
      wrong.close();
    } finally { console.error = original; }
    assert.ok(errors.length >= 2);
    for (const line of errors) assert.ok(!line.includes(GH), "the log never holds the value");
  } finally { f.done(); }
});

test("save, replace, remove and list never return a value", () => {
  const f = fixture();
  try {
    const all = [];
    all.push(f.store.save("usr_pat", "github", { token: GH }));
    all.push(f.store.list("usr_pat"), f.store.status("usr_pat", "github"));
    const replaced = f.store.save("usr_pat", "github", { token: GH_FINE }, { account: "@pat" });
    all.push(replaced);
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.connection.last4, "c3d4");
    assert.equal(f.store.envFor("usr_pat").env.GH_TOKEN, GH_FINE);
    all.push(f.store.history(), f.store.requestsForChat("cht_1"));
    assert.equal(f.store.has("usr_pat"), true);
    assert.equal(f.store.remove("usr_pat", "github"), true);
    assert.equal(f.store.remove("usr_pat", "github"), false);
    assert.equal(f.store.has("usr_pat"), false);
    assert.equal(f.store.status("usr_pat", "github"), null);
    assert.deepEqual(f.store.envFor("usr_pat"), { env: {}, types: [] });
    all.push(f.store.history());
    const text = JSON.stringify(all);
    for (const secret of [GH, GH_FINE]) assert.ok(!text.includes(secret));
    assert.throws(() => f.store.save("usr_pat", "nothing", { token: GH }), { status: 404 });
    const gone = createConnections({ file: path.join(f.directory, "other.db"), known: () => false });
    assert.throws(() => gone.save("usr_left", "github", { token: GH }), { status: 403 });
    gone.close();
  } finally { f.done(); }
});

test("values must fit the tool's fields", () => {
  const github = BUILTIN_TOOLS[0], jira = BUILTIN_TOOLS[1];
  assert.deepEqual(cleanValues(github, { token: GH }), { token: GH });
  assert.deepEqual(cleanValues(github, { token: GH_FINE, extra: "ignored" }), { token: GH_FINE });
  for (const bad of ["", "hunter2", "ghp_short", `${GH} ${GH}`, `x${GH}`, 12, null]) assert.throws(() => cleanValues(github, { token: bad }), { status: 400 }, String(bad));
  assert.throws(() => cleanValues(github, { token: "ghp_short" }), /Personal access token doesn't look right. It should look like github_pat_… or ghp_…/);
  assert.deepEqual(cleanValues(jira, jiraValues), jiraValues);
  assert.throws(() => cleanValues(jira, { ...jiraValues, site: "https://example.atlassian.net" }), /Jira site doesn't look right/);
  assert.throws(() => cleanValues(jira, { ...jiraValues, email: "pat" }), /Your Jira email doesn't look right/);
  assert.throws(() => cleanValues(jira, { site: "example.atlassian.net", token: JIRA }), /Your Jira email is needed to connect Jira/);
  // A value becomes an environment variable, so it is one line.
  const custom = cleanTool({ id: "tax-api", name: "Tax data API", fields: [{ key: "key", label: "API key" }], env: { TAX_API_KEY: "{key}" } });
  assert.throws(() => cleanValues(custom, { key: "abc\ndef" }), { status: 400 });
  assert.deepEqual(toolEnv(custom, { key: "abc" }), { TAX_API_KEY: "abc" });
});

test("a new tool type is data: an owner's type from config.json works like the built-in ones", () => {
  const problems = [];
  const tools = toolCatalog({ types: [
    { id: "tax-api", name: "Tax data API", help: "Needed for tax data.", createUrl: "https://api.example.gov/keys", hosts: ["api.example.gov", "not a host"],
      fields: [{ key: "user", label: "User name", secret: false }, { key: "key", label: "API key", placeholder: "tax_…", pattern: "^tax_[a-z0-9]{12}$", detect: "tax_[a-z0-9]{12}" }],
      env: { TAX_API_URL: "https://{user}@api.example.gov", TAX_API_KEY: "{key}" } },
    { id: "github", name: "Another GitHub", fields: [{ key: "t" }], env: { X_TOKEN: "{t}" } },
    { id: "Bad Id", name: "x", fields: [{ key: "t" }], env: { X: "{t}" } },
    { id: "no-secret", name: "x", fields: [{ key: "t", secret: false }], env: { X: "{t}" } },
    { id: "bad-env", name: "x", fields: [{ key: "t" }], env: { PATH: "{t}" } },
    { id: "bad-proxy", name: "x", fields: [{ key: "t" }], env: { https_proxy: "{t}" } },
    { id: "bad-field", name: "x", fields: [{ key: "t" }], env: { X: "{other}" } },
    { id: "bad-pattern", name: "x", fields: [{ key: "t", pattern: "(" }], env: { X: "{t}" } },
    { id: "bad-url", name: "x", createUrl: "http://example.gov", fields: [{ key: "t" }], env: { X: "{t}" } },
  ] }, problems);
  assert.deepEqual(tools.map(t => t.id), ["github", "jira", "tax-api"]);
  assert.equal(problems.length, 8);
  const tax = tools[2];
  assert.equal(tax.heading, "Tax data API token for your account");
  assert.deepEqual(tax.hosts, ["api.example.gov"]);
  assert.deepEqual(toolEnv(tax, { user: "pat", key: "tax_abcdef123456" }), { TAX_API_URL: "https://pat@api.example.gov", TAX_API_KEY: "tax_abcdef123456" });
  const f = fixture({ tools: () => tools });
  try {
    f.store.save("usr_pat", "tax-api", { user: "pat", key: "tax_abcdef123456" });
    assert.equal(f.store.status("usr_pat", "tax-api").last4, "3456");
    assert.equal(tokenInText("my key is tax_abcdef123456.", tools)?.id, "tax-api");
  } finally { f.done(); }
  // The app is told the fields, never how values reach the agent or how they are spotted in chat.
  const shown = publicTool(BUILTIN_TOOLS[0]);
  assert.deepEqual(Object.keys(shown).sort(), ["createUrl", "fields", "heading", "help", "hosts", "id", "name"]);
  assert.deepEqual(Object.keys(shown.fields[0]).sort(), ["key", "label", "pattern", "placeholder", "secret"]);
  assert.equal(shown.createUrl, "https://github.com/settings/personal-access-tokens/new");
  assert.equal(publicTool(BUILTIN_TOOLS[1]).createUrl, "https://id.atlassian.com/manage-profile/security/api-tokens");
});

test("the history says what happened, never holds a value, and can't be changed or deleted", () => {
  const f = fixture();
  try {
    f.store.request("usr_pat", "cht_1", "github", "msg_1");
    f.store.save("usr_pat", "github", { token: GH });
    f.store.save("usr_pat", "github", { token: GH_FINE });
    f.store.envFor("usr_pat", { chatId: "cht_1" });
    f.store.remove("usr_pat", "github");
    const declined = f.store.request("usr_pat", "cht_2", "jira", "msg_2");
    f.store.decline(declined.id, "usr_pat");
    const history = f.store.history({ userId: "usr_pat" }).reverse();
    assert.deepEqual(history.map(h => [h.action, h.type, h.chatId]), [["requested", "github", "cht_1"], ["saved", "github", undefined], ["replaced", "github", undefined], ["used", "github", "cht_1"], ["removed", "github", undefined], ["requested", "jira", "cht_2"], ["declined", "jira", "cht_2"]]);
    assert.ok(!JSON.stringify(history).includes(GH) && !JSON.stringify(history).includes(GH_FINE));
    assert.deepEqual(f.store.history({ userId: "usr_jo" }), []);
    f.store.close();
    const db = new DatabaseSync(f.file);
    assert.throws(() => db.exec("UPDATE history SET action='saved'"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM history"), /append-only/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM history").get().n, 7);
    db.close();
  } finally { f.done(); }
});

test("the agent's request: one per person, chat and tool; saving answers it; declining ends it for that chat", () => {
  const f = fixture();
  try {
    const first = f.store.request("usr_pat", "cht_1", "github", "msg_1");
    assert.equal(first.status, "open");
    const again = f.store.request("usr_pat", "cht_1", "github", "msg_2");
    assert.equal(again.id, first.id, "asking again is the same request");
    assert.equal(again.messageId, "msg_2", "shown on the newest message that asked");
    assert.equal(f.store.request("usr_pat", "cht_1", "unknown", "msg_3"), null);
    const elsewhere = f.store.request("usr_pat", "cht_2", "github", "msg_4");
    assert.throws(() => f.store.decline(first.id, "usr_jo"), { status: 404 }, "only your own");
    assert.equal(f.store.decline(first.id, "usr_pat").status, "declined");
    assert.equal(f.store.decline(first.id, "usr_pat").status, "declined");
    assert.deepEqual(f.store.declinedIn("usr_pat", "cht_1"), ["github"]);
    assert.equal(f.store.request("usr_pat", "cht_1", "github", "msg_5"), null, "not asked again in that chat");
    assert.deepEqual(f.store.declinedIn("usr_pat", "cht_2"), []);
    f.store.save("usr_pat", "github", { token: GH });
    assert.equal(f.store.requestsForChat("cht_2")[0].status, "saved");
    assert.equal(f.store.requestsForChat("cht_1")[0].status, "declined", "a declined one stays declined");
    assert.throws(() => f.store.decline(elsewhere.id, "usr_pat"), { status: 409 });
    assert.equal(f.store.request("usr_pat", "cht_3", "github", "msg_6"), null, "nothing to ask for once connected");
    f.store.remove("usr_pat", "github");
    assert.equal(f.store.request("usr_pat", "cht_2", "github", "msg_7").status, "open", "removed, so the agent may ask again");
    f.store.save("usr_jo", "github", { token: GH_FINE });
    f.store.save("usr_jo", "jira", jiraValues);
    f.store.forget("usr_jo");
    assert.deepEqual(f.store.list("usr_jo"), []);
    assert.deepEqual(f.store.history({ userId: "usr_jo" }).slice(0, 2).map(h => [h.action, h.detail.reason]), [["removed", "Left the server"], ["removed", "Left the server"]]);
  } finally { f.done(); }
});

test("a token typed into chat is recognised", () => {
  const tools = BUILTIN_TOOLS;
  assert.equal(tokenInText(`here you go: ${GH}`, tools)?.id, "github");
  assert.equal(tokenInText(`export GH_TOKEN=${GH_FINE}\n`, tools)?.id, "github");
  assert.equal(tokenInText(`"${JIRA}"`, tools)?.id, "jira");
  for (const fine of ["", "ghp_ is the prefix of a classic token", "see github_pat_ in the docs", "example.atlassian.net and pat@example.gov", `prefix${GH}`, "a".repeat(60), null]) assert.equal(tokenInText(fine, tools), null, String(fine));
  assert.equal(tokenInChatMessage(tools[0]), "That looks like a GitHub token. Use Connections so it stays out of chat.");
});

test("saved values and anything shaped like a token are hidden in what the agent writes", () => {
  const hide = redactor(BUILTIN_TOOLS, ["correct-horse-battery", "correct-horse-battery-staple", "short", GH]);
  assert.equal(hide(`GH_TOKEN=${GH} ok`), `GH_TOKEN=${HIDDEN} ok`);
  assert.equal(hide(`someone else's ${GH_FINE}, and ${JIRA}.`), `someone else's ${HIDDEN}, and ${HIDDEN}.`);
  assert.equal(hide("the password is correct-horse-battery-staple!"), `the password is ${HIDDEN}!`, "the longer saved value is hidden whole");
  assert.equal(hide("x=correct-horse-battery"), `x=${HIDDEN}`);
  assert.equal(hide("a short value is not worth hiding"), "a short value is not worth hiding");
  assert.equal(hide("nothing here"), "nothing here");
  assert.equal(hide(""), "");
  assert.equal(hide(undefined), undefined);
});

test("[[connect:type]] is taken out of the reply and names the tools asked for; unknown types are dropped", () => {
  const tools = BUILTIN_TOOLS;
  assert.deepEqual(readConnectMarkers("I need your GitHub token to open the pull request.\n\n[[connect:github]]\n\nThen I'll carry on.", tools),
    { text: "I need your GitHub token to open the pull request.\n\nThen I'll carry on.", types: ["github"] });
  assert.deepEqual(readConnectMarkers("[[connect:jira]]", tools), { text: "", types: ["jira"] });
  assert.deepEqual(readConnectMarkers("Both please [[connect:GitHub]] [[connect:jira]] [[connect:github]]", tools), { text: "Both please", types: ["github", "jira"] });
  assert.deepEqual(readConnectMarkers("First\n[[connect:slack]]\nLast", tools), { text: "First\nLast", types: [] });
  assert.deepEqual(readConnectMarkers("No marker, [[just brackets]]", tools), { text: "No marker, [[just brackets]]", types: [] });
});

test("text that arrives in pieces: the start of a secret is held until the rest arrives, and nothing else is", () => {
  const hide = redactor(BUILTIN_TOOLS, ["correct horse battery"]);
  assert.deepEqual(hide.starts, ["github_pat_", "gh", "ATATT3"]);
  const stream = () => createTextStream(text => stripConnectMarkers(hide(text)), hide);
  const run = pieces => { const s = stream(); const out = pieces.map(piece => s.push(piece)); return [...out, s.flush()]; };
  // Ordinary words go out the moment they arrive, so a reply cut off mid-way keeps all of them.
  assert.deepEqual(run(["Still working", " on it"]), ["Still working", " on it", ""]);
  // A token split across pieces is held from where it starts and hidden whole.
  assert.deepEqual(run(["The token is gh", `p_${"x".repeat(20)}`, `${"x".repeat(12)}a1b2 and `, "that is all"]), ["The token is ", "", `${HIDDEN} and `, "that is all", ""]);
  assert.deepEqual(run([`GH_TOKEN=${GH.slice(0, 9)}`, GH.slice(9)]).join(""), `GH_TOKEN=${HIDDEN}`);
  assert.deepEqual(run(["AT", "ATT3", "z".repeat(40), " ok"]).join(""), `${HIDDEN} ok`);
  // A word that only begins like one comes out when it ends.
  assert.deepEqual(run(["a gh", "ost town"]), ["a ", "ghost town", ""]);
  assert.deepEqual(run(["thigh", " bone"]), ["thigh", " bone", ""], "not the start of a word, so not the start of a token");
  // A saved value, spaces and all.
  assert.deepEqual(run(["it says correct ho", "rse bat", "tery here"]), ["it says ", "", `${HIDDEN} here`, ""]);
  assert.deepEqual(run(["it says correct ho", "tel"]), ["it says ", "correct hotel", ""]);
  // The agent's marker never shows half-written.
  assert.deepEqual(run(["ok [[conn", "ect:github]] then"]), ["ok ", " then", ""]);
  assert.deepEqual(run(["see [", "1] and [", "[connect:jira]]"]), ["see ", "[1] and ", "", ""]);
  assert.equal(stripConnectMarkers("plain text "), "plain text ");
  // Held text is let go rather than kept for ever.
  const long = createTextStream(hide, { starts: ["tok_"], hold: 10 });
  assert.equal(long.push("tok_abcdefghijklmnop"), "tok_abcdefghijklmnop");
  // A pattern whose beginning can't be told: every unfinished word waits.
  const odd = redactor([{ id: "odd", name: "Odd", fields: [{ key: "k", secret: true, detect: "(?:a|b)[0-9]{20}" }], env: { ODD: "{k}" } }], []);
  assert.equal(odd.starts, null);
  const careful = createTextStream(odd, odd);
  assert.deepEqual([careful.push("Still working"), careful.push(" on"), careful.flush()], ["Still ", "working ", "on"]);
});

test("a GitHub token is checked by asking GitHub who it belongs to", async () => {
  const asked = [];
  const answer = (status, body) => async (url, options) => { asked.push({ url, authorization: options.headers.Authorization }); return { status, ok: status >= 200 && status < 300, json: async () => body }; };
  assert.deepEqual(await checkGithubToken({ token: GH }, { fetchImpl: answer(200, { login: "pat-tester" }) }), { ok: true, account: "@pat-tester" });
  assert.deepEqual(asked, [{ url: "https://api.github.com/user", authorization: `Bearer ${GH}` }]);
  assert.deepEqual(await checkGithubToken({ token: GH }, { fetchImpl: answer(401, {}) }), { ok: false });
  assert.deepEqual(await checkGithubToken({ token: GH }, { fetchImpl: answer(200, { login: "<script>" }) }), { ok: true, account: "" });
  assert.deepEqual(await checkGithubToken({ token: GH }, { fetchImpl: answer(502, {}) }), { ok: true, unreachable: true });
  assert.deepEqual(await checkGithubToken({ token: GH }, { fetchImpl: async () => { throw new Error("offline"); } }), { ok: true, unreachable: true });
});
