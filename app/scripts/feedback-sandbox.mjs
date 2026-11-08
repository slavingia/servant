// A private Servant on this Mac for feedback sessions on the Servant UX
// features: made-up people, a made-up design and stand-in agents that never
// call a model. Everything runs on 127.0.0.1 and is deleted when it stops.
//
//   cd app && npm run sandbox
//   npm run sandbox -- --port 8790 --app-port 8099 --no-app
//
// It prints a sign-in link for the preview persona, "Preview Researcher": a
// workspace member with the Researcher agent tier, granted by this sandbox's
// server (its default tier for new people), as a real owner would grant it.
// That persona can reach every Servant UX feature in the pilot build: the
// start page and onboarding, Research Studio (study plans, prototypes from
// research findings, saved forms, working drafts), Design Studio (new designs,
// previews, Adjust design, versions, duplicate, share for review), and
// reviewing a teammate's design from its thread. The research pilot hold is on,
// as in the pilot build.
//
// Press Enter for a new sign-in link (for the next participant: sign out first,
// or use a private window). Ctrl+C stops it and deletes everything.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 && args[at + 1] ? args[at + 1] : fallback; };
const port = Number(option("port", 8790));
const appPort = Number(option("app-port", 8099));
const withApp = !args.includes("--no-app");
const base = `http://127.0.0.1:${port}`;
const appUrl = `http://localhost:${appPort}`;

// Both ports must be free before anything starts.
for (const [what, number] of [["sandbox server", port], ...(withApp ? [["app", appPort]] : [])]) {
  const free = await new Promise(resolve => { const probe = net.createServer().once("error", () => resolve(false)).listen(number, "127.0.0.1", () => probe.close(() => resolve(true))); });
  if (!free) { console.error(`Port ${number} for the ${what} is in use. Stop whatever is using it, or choose another with --${what === "app" ? "app-port" : "port"}.`); process.exit(1); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const serverDir = path.resolve(here, "../../server");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-feedback-sandbox-"));
process.env.SERVANT_DATA_DIR = dir;

let servant;
const escape = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// ---------- A made-up page the stand-in agent publishes ----------

const LAYOUTS = {
  a: { name: "Balance first", lead: "balance" },
  b: { name: "Due date first", lead: "due" },
  c: { name: "Options first", lead: "options" },
};
function samplePage({ layout = "a", note = "", version = 1 } = {}) {
  const { name, lead } = LAYOUTS[layout] ?? LAYOUTS.a;
  const balance = `<section aria-labelledby="balance"><h2 id="balance">Amount you owe</h2><p class="amount">$1,250.00</p><p>This is your balance. A payment you schedule appears separately below.</p></section>`;
  const due = `<section aria-labelledby="due"><h2 id="due">Due date</h2><p class="due">Pay by April 15 to avoid more interest.</p></section>`;
  const options = `<section aria-labelledby="options"><h2 id="options">If you can't pay in full</h2><ul><li><a href="#plan">Set up a payment plan</a></li><li><a href="#help">Talk to someone</a></li></ul></section>`;
  const order = lead === "due" ? [due, balance, options] : lead === "options" ? [options, balance, due] : [balance, due, options];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your balance (sample)</title>
<style>
:root { --brand: #1a5fb4; --ink: #1f2328; --muted: #57606a; --space-2: 16px; --radius: 8px; }
body { margin: 0; font-family: system-ui, sans-serif; color: var(--ink); }
main { max-width: 560px; margin: 0 auto; padding: var(--space-2); }
h1 { font-size: 28px; margin: 8px 0 16px; }
h2 { font-size: 18px; margin: 0 0 4px; }
section { border: 1px solid #d0d7de; border-radius: var(--radius); padding: var(--space-2); margin-bottom: 12px; }
.amount { font-size: 32px; font-weight: 700; margin: 4px 0; }
button { background: var(--brand); color: #fff; border: 0; border-radius: var(--radius); padding: 12px 20px; font-size: 16px; }
a { color: var(--brand); }
.fine { color: #a0a0a0; font-size: 12px; }
</style></head>
<body><main>
<p class="fine">Sample page for a feedback session. Made-up account and amounts.</p>
<h1>Your balance</h1>
${order.join("\n")}
<button type="button">Make a payment</button>
<p class="fine">Layout: ${escape(name)} · version ${version}</p>
${note ? `<p class="fine">Requested change: ${escape(note.slice(0, 200))}</p>` : ""}
</main></body></html>`;
}

// ---------- Stand-in agents ----------

const chatIdFrom = sessionId => { const at = String(sessionId || "").indexOf("_cht_"); return at >= 0 ? String(sessionId).slice(at + 1) : null; };
function folderFor(chatId) {
  let folder = null;
  servant.mutateStateForTest(state => { folder = state.chats[chatId]?.vibeFolder ?? null; });
  return /^[a-z0-9][a-z0-9-]{2,40}$/.test(folder || "") ? folder : null;
}
const builds = new Map();
const lastLayout = new Map();
const NOTE = "(This is the feedback sandbox's stand-in agent: it shows how the conversation works, with sample content, and doesn't use a model.)";

// What the design agent does with a message: suggest directions for a research
// prompt, otherwise publish the sample page (one layout, or several to compare).
function designTurn(message, sessionId) {
  const chatId = chatIdFrom(sessionId);
  const folder = chatId && folderFor(chatId);
  const findings = [...message.matchAll(/^F(\d+)\. (.+)$/gm)].map(m => `F${m[1]}`);
  if (/suggest design directions for this study before building/i.test(message)) {
    const refs = i => findings[i] ? `Addresses ${findings[i]}.` : "Addresses the research question.";
    return [
      "Here are three directions to compare. Each is a hypothesis to test, not a validated design.",
      "",
      `Direction A: Balance first. Lead with what's owed and show any scheduled payment separately. ${refs(0)} Tradeoff: the due date sits lower on the page. Accessibility: the amount is a heading, so screen reader users find it quickly.`,
      `Direction B: Due date first. Lead with when to pay, then the balance. ${refs(1)} Tradeoff: people looking for the amount scan past the date. Accessibility: the date is written out in words, not only as numbers.`,
      `Direction C: Options first. Start with what to do if you can't pay in full. ${refs(2)} Tradeoff: people who can pay in full have an extra step. Accessibility: options are a plain list of links.`,
      "",
      "I'd start with A as the minimum testable direction. Which should I build? You can choose more than one to compare.",
      "",
      NOTE,
    ].join("\n");
  }
  if (!folder) return `I couldn't find this design's page folder, so nothing was published. ${NOTE}`;
  const root = path.join(dir, "prototypes", folder);
  fs.mkdirSync(root, { recursive: true });
  const version = (builds.get(folder) ?? 0) + 1;
  builds.set(folder, version);
  // Adjust design requests and reviewers' suggestions; anything else that asks for a change.
  const adjusting = /^(?:Please apply these quick adjustments|Suggested adjustments)/i.test(message.trim());
  const chosen = adjusting ? [] : [...new Set([...message.matchAll(/\bdirections?\s+([abc])\b|\b([abc])\b(?=\s*(?:,|and\b|&|\.|$))/gim)].map(m => (m[1] || m[2]).toLowerCase()))];
  const several = !adjusting && (chosen.length > 1 || /\b(?:both|all three)\b|\bcompare\b/i.test(message));
  const changing = !adjusting && !chosen.length && /\b(?:change|make|move|larger|bigger|smaller|colou?r|rename|reword)\b/i.test(message);
  // The listed changes, without each element's CSS path.
  const listed = [...message.matchAll(/^\d+\.\s+(.+)$/gm)].map(m => m[1].replace(/\s*\((?:[^()]|\([^()]*\))*\)(?=:)/, "").trim());
  const note = adjusting || changing ? (listed.length ? listed.join("; ") : message.replace(/\s+/g, " ").trim()) : "";
  if (several) {
    const pages = (chosen.length > 1 ? chosen : ["a", "b"]).filter(key => LAYOUTS[key]);
    for (const key of pages) {
      fs.mkdirSync(path.join(root, key), { recursive: true });
      fs.writeFileSync(path.join(root, key, "index.html"), samplePage({ layout: key, version }));
    }
    fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Layouts to compare (sample)</title></head><body><main><h1>Layouts to compare</h1><ul>${pages.map(key => `<li><a href="./${key}/">${escape(LAYOUTS[key].name)}</a></li>`).join("")}</ul></main></body></html>`);
    return [
      `I built ${pages.length} layouts as separate pages so the study can compare them:`,
      ...pages.map(key => `- ${LAYOUTS[key].name}: ${base}/p/${folder}/${key}/`),
      "",
      "What's testable: finding the balance, the due date and the payment options. Limitations: sample content only, and no real payment flow.",
      "",
      NOTE,
    ].join("\n");
  }
  const layout = chosen[0] ?? lastLayout.get(folder) ?? "a";
  lastLayout.set(folder, layout);
  fs.writeFileSync(path.join(root, "index.html"), samplePage({ layout, note, version }));
  return [
    adjusting || changing
      ? "I republished the page. The stand-in agent can't make these exact changes, so it notes your request at the bottom of the page."
      : `I published the "${LAYOUTS[layout].name}" layout.`,
    `Preview: ${base}/p/${folder}/`,
    "",
    "What's testable: finding the balance, the due date and the payment options. Limitations: sample content only, and no real payment flow.",
    "",
    NOTE,
  ].join("\n");
}
const researcherTurn = message => /\b(study|plan|research)\b/i.test(message)
  ? `Here's how I'd approach this, as a sample answer: clarify the decision, write two or three testable questions, and pick a method that fits the time you have. ${NOTE}`
  : `Sample answer from the stand-in Researcher Agent. ${NOTE}`;
const memberTurn = () => `Sample answer from the stand-in agent. ${NOTE}`;

function standInAgent(key, capabilities, reply) {
  const sessions = new Map();
  const runs = new Map();
  const runKeys = new Map();
  let count = 0;
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { body = {}; }
    if (req.url === "/v1/capabilities") return json(200, capabilities);
    if (req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end();
    const text = content => typeof content === "string" ? content : (content || []).filter(part => part.type === "text").map(part => part.text).join("");
    if (req.method === "POST" && req.url === "/v1/chat/completions") return json(200, { choices: [{ message: { role: "assistant", content: memberTurn() } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const keyMatch = req.url.match(/^\/v1\/runs\/servant-key\.([^/]+)(\/stop)?$/);
    if (keyMatch) {
      const runKey = decodeURIComponent(keyMatch[1]);
      let entry = runKeys.get(runKey);
      if (req.method === "POST" && keyMatch[2]) {
        if (entry) { const run = runs.get(entry.runId); if (run?.status === "running") run.status = "cancelled"; }
        else { entry = { state: "refused", runId: null }; runKeys.set(runKey, entry); }
      }
      if (!entry) return json(404, {});
      const status = entry.runId ? runs.get(entry.runId)?.status : null;
      const state = entry.state === "running" && status !== "running" ? "ended" : entry.state;
      return json(200, { key: runKey, state, run_id: entry.runId, run_status: status, stopped: state !== "running" });
    }
    if (req.method === "POST" && req.url === "/v1/runs") {
      const runKey = req.headers["x-servant-run-key"];
      if (runKey && runKeys.has(runKey)) return json(409, { error: { code: "run_key_in_use" }, run_id: runKeys.get(runKey).runId });
      const id = `run_sandbox_${++count}`;
      runs.set(id, { id, sessionId: body.session_id || req.headers["x-hermes-session-key"], message: text(body.input?.at(-1)?.content), status: "running" });
      if (runKey) runKeys.set(runKey, { state: "running", runId: id });
      return json(202, { run_id: id });
    }
    const runMatch = req.url.match(/^\/v1\/runs\/([^/]+)(\/.*)?$/);
    if (runMatch) {
      const run = runs.get(decodeURIComponent(runMatch[1]));
      if (!run) return json(404, {});
      if (req.method === "POST" && runMatch[2] === "/stop") { if (run.status === "running") run.status = "cancelled"; return json(200, { status: "stopping" }); }
      if (req.method === "GET" && runMatch[2] === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": connected\n\n");
        await new Promise(resolve => setTimeout(resolve, 700));
        if (run.status !== "running") { res.write(`data: ${JSON.stringify({ event: "run.cancelled" })}\n\n`); return res.end(); }
        let output;
        try { output = reply(run.message, run.sessionId); } catch (error) { output = `The stand-in agent hit a problem: ${error.message}`; }
        const history = sessions.get(run.sessionId) ?? [];
        history.push({ id: history.length + 1, role: "user", content: run.message }, { id: history.length + 2, role: "assistant", content: output });
        sessions.set(run.sessionId, history);
        run.status = "completed";
        run.output = output;
        for (const word of output.split(/(?= )/)) res.write(`data: ${JSON.stringify({ event: "message.delta", delta: word })}\n\n`);
        res.write(`data: ${JSON.stringify({ event: "run.completed", output, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } })}\n\n`);
        return res.end();
      }
      if (req.method === "GET" && !runMatch[2]) return json(200, { run_id: run.id, status: run.status, ...(run.output ? { output: run.output } : {}) });
      return res.writeHead(404).end();
    }
    const session = req.url.match(/^\/api\/sessions(?:\/([^/]+))?(\/.*)?$/);
    if (req.method === "POST" && req.url === "/api/sessions") { sessions.set(body.id, []); return json(201, { object: "hermes.session", session: { id: body.id } }); }
    if (session) {
      const id = session[1] && decodeURIComponent(session[1]);
      if (req.method === "DELETE") { sessions.delete(id); return json(200, {}); }
      if (req.method === "GET" && session[2] === "/messages") return json(200, { object: "list", data: sessions.get(id) ?? [] });
      if (req.method === "GET") return json(200, { object: "hermes.session", session: { id } });
      if (req.method === "POST" && session[2] === "/chat/stream") {
        const output = reply(String(body.message || ""), id);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: run.started\ndata: {}\n\n");
        res.write(`event: assistant.delta\ndata: ${JSON.stringify({ delta: output })}\n\n`);
        res.write(`event: assistant.completed\ndata: ${JSON.stringify({ content: output })}\n\n`);
        return res.end("event: run.completed\ndata: {}\n\nevent: done\ndata: {}\n\n");
      }
    }
    return json(404, {});
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, key })));
}

// ---------- The workspace ----------

const { restrictedTestCapabilities, researcherTestCapabilities } = await import(path.join(serverDir, "test-hermes-capabilities.mjs"));
const durable = c => ({ ...c, features: { ...c.features, servant_durable_media_runs: true, servant_exact_approvals: true, servant_run_keys: true } });
const upstreams = {
  owner: await standInAgent("owner-key", durable(restrictedTestCapabilities), designTurn),
  member: await standInAgent("member-key", restrictedTestCapabilities, memberTurn),
  researcher: await standInAgent("researcher-key", durable(researcherTestCapabilities), researcherTurn),
  prototype: await standInAgent("prototype-key", durable(restrictedTestCapabilities), designTurn),
};
// New people start with the Researcher tier: this sandbox's server grants it, as an owner would.
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ host: "127.0.0.1", port, defaultAgentTier: 4, name: "Feedback sandbox", publicUrl: base, upstreams }));
fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify({ projects: [{ id: "design-prototypes", name: "Design prototypes", repo: "example/design-prototypes", path: "~/design-prototypes", workflow: "main", rules: ["Made-up sample data only"] }] }));

servant = await import(path.join(serverDir, "server.mjs"));
const { testFetch } = await import(path.join(serverDir, "encrypted-test-client.mjs"));
const { serverIdentity } = await import(path.join(serverDir, "secure-transport.mjs"));
const { TERMS_VERSION, TERMS_ITEMS } = await import(path.join(serverDir, "terms.mjs"));
const { snapshotPrototype } = await import(path.join(serverDir, "prototype-versions.mjs"));
await servant.startServer();
const api = (token, route, init = {}) => testFetch(dir, `${base}${route}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) } }).then(r => r.json());
const pairTeammate = async (name, role) => {
  const code = servant.createInvite({ name, role });
  const response = await testFetch(dir, `${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terms: { version: TERMS_VERSION, items: TERMS_ITEMS }, code: code.toLowerCase(), name }) });
  const body = await response.json();
  if (response.status !== 201) throw new Error(`Couldn't add ${name}: ${response.status}`);
  return { token: body.token, user: body.user };
};
const olive = await pairTeammate("Olive Owner", "owner");
const dev = await pairTeammate("Dev Designer", "member");
const rhea = await pairTeammate("Rhea Researcher", "member");

// Dev's design, published with two versions and shared for review in #general.
const folder = "proto-sandboxbalance01";
servant.mutateStateForTest(state => {
  state.users[dev.user.id].agentTier = 3;
  state.users[rhea.user.id].agentTier = 4;
  state.chats.cht_sandbox_balance = { id: "cht_sandbox_balance", userId: dev.user.id, role: "member", hermesSessionId: `servant_${dev.user.id}_cht_sandbox_balance`,
    title: "Balance due page", projectId: "design-prototypes", mode: "vibe", hosted: "server", vibeFolder: folder, shared: true, createdAt: Date.now() - 3 * 3600_000, updatedAt: Date.now() - 3600_000 };
});
const live = path.join(dir, "prototypes", folder);
fs.mkdirSync(live, { recursive: true });
const versionsDir = path.join(dir, "prototype-versions");
fs.writeFileSync(path.join(live, "index.html"), samplePage({ layout: "b", version: 1 }));
snapshotPrototype({ dir: path.join(dir, "prototypes"), versionsDir, folder, at: Date.now() - 2 * 3600_000, request: "Show the due date and balance for a sample account" });
fs.writeFileSync(path.join(live, "index.html"), samplePage({ layout: "a", version: 2 }));
snapshotPrototype({ dir: path.join(dir, "prototypes"), versionsDir, folder, at: Date.now() - 3600_000, request: "Lead with the balance and keep the payment amount separate" });
builds.set(folder, 2);

const general = (await api(olive.token, "/v1/conversations")).conversations?.find(c => c.name === "general");
if (general) {
  await api(olive.token, `/v1/conversations/${general.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Welcome to the feedback sandbox. Everyone and everything here is made up, the agents are stand-ins, and it's all deleted when the session ends." }) });
  await api(dev.token, `/v1/conversations/${general.id}/messages`, { method: "POST", body: JSON.stringify({ text: [
    "Design review: Balance due page", "Status: Published", `Preview: ${base}/p/${folder}/`,
    "Review focus: Can people tell the balance from a scheduled payment?", "Please leave feedback in this message's thread.",
  ].join("\n") }) });
}

// ---------- The preview persona ----------

const key = serverIdentity(dir).publicKey;
const signInLink = () => {
  const code = servant.createInvite({ name: "Preview Researcher", role: "member" });
  return `${appUrl}/pair?${new URLSearchParams({ code, key, server: base })}`;
};

let app = null;
if (withApp) {
  app = spawn("npx", ["expo", "start", "--web", "--port", String(appPort)], { cwd: appDir, env: { ...process.env, BROWSER: "none" }, stdio: "ignore", detached: true });
  process.stdout.write(`Starting the app at ${appUrl}…`);
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(appUrl)).ok) break; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  process.stdout.write(" ready.\n");
}

const show = () => {
  console.log(`
Feedback sandbox is running (made-up data, stand-in agents, this Mac only).

Sign in as the preview persona, Preview Researcher (Researcher access):
  ${signInLink()}

Each link works once. Press Enter for a new one (for the next participant,
sign out first or use a private window). Ctrl+C stops the sandbox and deletes
everything in it.
`);
};
show();

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (app) { try { process.kill(-app.pid, "SIGTERM"); } catch { /* already stopped */ } }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\nStopped. The sandbox and everything in it were deleted.");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
readline.createInterface({ input: process.stdin }).on("line", show).on("close", () => { if (!process.stdin.isTTY) return; stop(); });
