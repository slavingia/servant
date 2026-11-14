// A private Servant on this Mac for feedback sessions on the Servant Studio
// features: made-up people, a made-up design and stand-in agents that never
// call a model. Everything runs on 127.0.0.1 and is deleted when it stops.
//
//   cd app && npm run sandbox
//   npm run sandbox -- --port 8790 --app-port 8099 --start-port 8098 --no-app --no-open
//
// It opens the sandbox's start page (http://localhost:8098), which signs in as
// the preview persona, links to every feature and has the made-up files to try
// them with. The preview persona, "Preview Researcher", is a
// workspace member with the Researcher agent tier, granted by this sandbox's
// server (its default tier for new people), as a real owner would grant it.
// That persona can reach every Servant Studio feature in the pilot build: the
// start page and onboarding, Research Studio (study plans, prototypes from
// research findings, saved forms, working drafts), Design Studio (new designs,
// previews, Adjust design, versions, duplicate, share for review), and
// reviewing a teammate's design from its thread. The research pilot hold is on,
// as in the pilot build.
//
// "Sign in as Preview Researcher" on the start page works any number of times
// (each time as a new Preview Researcher); in the terminal, Enter prints a new
// sign-in link. Ctrl+C stops it and deletes everything.
//
//   --full   Turns the research pilot hold off: Researcher Agent chats (synthesis,
//            research-informed design review) and Research Hub evidence, with a
//            made-up Research Hub snapshot and scripted Researcher Agent replies.
//   --share  Lets other people use it through temporary Cloudflare quick tunnels
//            (needs cloudflared): the app is exported once and served with the
//            start page at one https://….trycloudflare.com address, and the
//            sandbox server gets a second one. Anyone with the start page link can
//            sign in, so share it only with the people testing. The addresses
//            change every time the sandbox starts.
//
//   --agents <file>
//            Uses your own Hermes agents instead of the stand-ins, from a private
//            JSON file: {"researcher": {"url": "http://127.0.0.1:8646", "key": "…"},
//            "prototype": {"url": "http://127.0.0.1:8642", "key": "…"}}. Either lane
//            can be left out to keep its stand-in. With --share only "researcher" is
//            allowed: the prototype agent is the full-access agent that writes page
//            files and can run commands on this Mac.
//
//   --daily-tokens <n>
//            Each person's daily token limit, 2,000,000 unless set (the owner is unlimited).
//            Only real agents use tokens; the stand-ins count almost nothing.
//
// Testers sign in with their name on the start page. The same name signs in to
// the same account again, so its daily limit and its work follow the person.
//
//   npm run sandbox:share     (the same as --share --full)
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
const startPort = Number(option("start-port", 8098));
const share = args.includes("--share");
const full = args.includes("--full");
const dailyTokens = Number(option("daily-tokens", 2_000_000));
if (!Number.isSafeInteger(dailyTokens) || dailyTokens < 1) { console.error("--daily-tokens must be a whole number of tokens, such as 2000000."); process.exit(1); }
// When sharing, the exported app is served by the start page server, so there's no separate app port.
const withApp = !args.includes("--no-app") && !share;
const openStart = !args.includes("--no-open");
const base = `http://127.0.0.1:${port}`;
let appUrl = `http://localhost:${appPort}`;

// Both ports must be free before anything starts.
for (const [what, number] of [["sandbox server", port], ["start page", startPort], ...(withApp ? [["app", appPort]] : [])]) {
  const free = await new Promise(resolve => { const probe = net.createServer().once("error", () => resolve(false)).listen(number, "127.0.0.1", () => probe.close(() => resolve(true))); });
  if (!free) { console.error(`Port ${number} for the ${what} is in use. If an earlier sandbox is still running, stop it with Ctrl+C in its window. Or choose another port with --${what === "app" ? "app-port" : what === "start page" ? "start-port" : "port"}.`); process.exit(1); }
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
const researcherTurn = message => {
  if (/\[Research synthesis\]|synthesi[sz]/i.test(message)) return [
    "Here's a synthesis plan to review before we start. Nothing below is a finding yet.",
    "",
    "1. Keep the sources apart first: note each one's date, who it came from and how it was collected.",
    "2. Candidate themes to check against the evidence: people can't tell a balance from a scheduled payment; similar labels slow people down; people who can't pay in full look for options first.",
    "3. Look for disagreement: where do screen reader users or phone users describe something different?",
    "4. Gaps: nothing yet from people who pay through a tax professional. Treat that as unknown, not as agreement.",
    "",
    "Output: a decision brief with each theme, where it came from and how confident we can be. Want me to draft the theme table?",
    "", NOTE].join("\n");
  if (/\[Research design review\]|design review/i.test(message)) return [
    "Here's a review plan for this design.",
    "",
    "Assumptions to check: people read the large amount as what they owe today; the scheduled payment is noticed before they pay again.",
    "Inspection first: headings and reading order with a screen reader, label wording, and contrast on the amount.",
    "Then with participants: ask people to find what they owe, when it's due and what to do if they can't pay in full. Success means they say it back in their own words.",
    "Severity: anything that could lead someone to pay twice is high.",
    "",
    "This is a plan, not a result: the design hasn't been tested with participants.",
    "", NOTE].join("\n");
  return /\b(study|plan|research)\b/i.test(message)
    ? `Here's how I'd approach this, as a sample answer: clarify the decision, write two or three testable questions, and pick a method that fits the time you have. ${NOTE}`
    : `Sample answer from the stand-in Researcher Agent. ${NOTE}`;
};
// The Researcher Agent's design guidance (Research Hub evidence → the prototype agent), worded to pass the
// server's check for source details.
const GUIDANCE = JSON.stringify({
  needs: ["People need to see what they owe first, before other account details.", "People want reassurance about whether an upcoming planned payment is already counted."],
  painPoints: ["Labels that look alike make people unsure which amount is which.", "People who can't pay everything at once have to search for other ways forward."],
  opportunities: ["Try making the amount owed a page heading, with any planned payment set apart below it.", "Try placing ways to pay over time right beside the amount owed."],
  unknowns: ["Little is known about people who pay through a tax professional.", "It's unclear how people using assistive technology move from the amount to the choices."],
});
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
    if (req.method === "POST" && req.url === "/v1/chat/completions") return json(200, { choices: [{ message: { role: "assistant", content: /de-identified design handoff/.test(JSON.stringify(body.messages || [])) ? GUIDANCE : memberTurn() } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
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

// --agents: your own Hermes agents for the researcher and/or prototype lanes. Keys are never printed.
const quit = message => { console.error(message); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); };
const ownAgents = [];
const ownLanes = [];
// "ready", "key" (it answers but rejects the key) or "down". Never prints the key.
async function agentState({ url, key }) {
  try {
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) return "down";
    const models = await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) });
    return models.status === 401 || models.status === 403 ? "key" : models.ok ? "ready" : "down";
  } catch { return "down"; }
}
const agentsFile = option("agents", "");
if (agentsFile) {
  let own;
  try { own = JSON.parse(fs.readFileSync(path.resolve(agentsFile), "utf8")); }
  catch { quit(`Couldn't read --agents ${agentsFile}. It should be a JSON file like {"researcher": {"url": "http://127.0.0.1:8646", "key": "…"}}.`); }
  const lanes = own && typeof own === "object" ? Object.keys(own) : [];
  if (!lanes.length || lanes.some(lane => !["researcher", "prototype"].includes(lane))) quit("--agents can set \"researcher\" and \"prototype\" only.");
  if (share && lanes.includes("prototype")) quit("--share can't use your own prototype agent. It's the full-access agent that writes page files and can run commands on this Mac, and anyone with the link could use it. Share with your own researcher agent only, or try your prototype agent without --share.");
  for (const lane of lanes) {
    const { url, key } = own[lane] || {};
    if (typeof url !== "string" || !/^https?:\/\/[^\s/]+(\/.*)?$/.test(url) || typeof key !== "string" || key.length < 32) quit(`--agents: "${lane}" needs a url and its API_SERVER_KEY (at least 32 characters).`);
    upstreams[lane] = { url: url.replace(/\/+$/, ""), key };
    ownAgents.push(lane === "researcher" ? "Researcher Agent" : "prototype agent");
    ownLanes.push({ lane, label: lane === "researcher" ? "Researcher Agent" : "Prototype agent", url: url.replace(/\/+$/, ""), key });
  }
  // Each of your agents must answer, with this key, before anything starts.
  for (const agent of ownLanes) {
    const state = await agentState(agent);
    if (state !== "ready") quit(state === "key" ? `Your ${agent.label} at ${agent.url} answers, but rejects the key in ${agentsFile}. It must be that bridge's API_SERVER_KEY.`
      : `Your ${agent.label} isn't answering at ${agent.url}. Start its bridge first (see docs/feedback-sandbox.md), then start the sandbox again.`);
  }
}
const agentsText = ownAgents.length ? `your own ${ownAgents.join(" and ")}, stand-ins for the rest` : "stand-in agents";
// ---------- Sharing: temporary Cloudflare quick tunnels ----------

const tunnels = [];
const cloudflared = () => process.env.CF || ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].find(file => fs.existsSync(file)) || "cloudflared";
// Starts a quick tunnel to a local port and resolves its https://….trycloudflare.com address.
function quickTunnel(localUrl, what) {
  return new Promise((resolve, reject) => {
    const child = spawn(cloudflared(), ["tunnel", "--no-autoupdate", "--url", localUrl], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    tunnels.push(child);
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`Cloudflare didn't give the ${what} an address within 90 seconds.`)), 90_000);
    const read = chunk => {
      seen = (seen + chunk).slice(-8000);
      // The tunnel's own address, never api.trycloudflare.com from one of cloudflared's error messages.
      const found = seen.match(/https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
      if (found) { clearTimeout(timer); resolve(found[0]); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", error => { clearTimeout(timer); reject(error.code === "ENOENT" ? new Error("--share needs cloudflared. Install it with: brew install cloudflared") : error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(/\b429\b|Too Many Requests/i.test(seen)
      ? `Cloudflare is limiting new quick tunnels right now, so the ${what} has no address. Wait a minute or two, then start the sandbox again.`
      : `cloudflared stopped (exit ${code}) before the ${what} had an address.`)); });
  });
}
const stopTunnels = () => { for (const child of tunnels) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ } } };
const failShare = error => { console.error(`\nCouldn't share the sandbox: ${error.message}`); stopTunnels(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); };

// The address people's browsers use for this sandbox's server: its tunnel when sharing.
let publicUrl = base;
if (share) {
  process.stdout.write("Opening a Cloudflare quick tunnel for the sandbox server…");
  publicUrl = await quickTunnel(base, "sandbox server").catch(failShare);
  process.stdout.write(` ${publicUrl}\n`);
}

// --full: a made-up Research Hub snapshot, written before the server starts. Nothing in it is real.
if (full) {
  const { researchHubRevision } = await import(path.join(serverDir, "research-hub.mjs"));
  const now = Date.now();
  const iso = time => new Date(time).toISOString();
  const day = time => iso(time).slice(0, 10);
  const record = (n, kind, title, summary, unit, value) => ({ id: `rhe_${"a".repeat(15)}${n}`, kind, title, summary,
    product: { id: "sample", name: "Sample Online Account" }, period: { start: day(now - 60 * 864e5), end: day(now - 30 * 864e5), grain: "month" },
    metric: { label: title, value, unit, sampleSize: 40 }, release: { id: "sample:release", status: "Made-up sample" },
    catalogReference: `sample_theme • ${n}`, sourcePath: "survey-research-catalog/sample.sqlite", version: 1 });
  const hub = { schemaVersion: 1, revision: "0".repeat(64), generatedAt: iso(now - 864e5), reviewBy: iso(now + 30 * 864e5),
    source: { label: "Made-up sample catalog", repository: "Taxpayer-Services-and-Online-Accounts/research-hub", path: "survey-research-catalog/catalog/canonical_source_set.json",
      commit: "a".repeat(40), catalogTree: "b".repeat(40), catalogSchemaVersion: "1.0.0", workflowRegistryVersion: "1.0.0", validation: "PASS" },
    approval: { id: "SAMPLE-1", audience: "servant-private-workspace-and-configured-researcher-model", sourcePath: "approvals/servant/SAMPLE-1.json", catalogTree: "b".repeat(40), expiresAt: iso(now + 60 * 864e5) },
    records: [
      record(1, "theme", "Balance and scheduled payment confused", "Made-up: comments said the balance and a scheduled payment looked alike.", "comments", 18),
      record(2, "theme", "Payment options hard to find", "Made-up: comments said options for paying over time were hard to find.", "comments", 12),
      record(3, "feature", "Show the due date with the balance", "Made-up: requests to see the due date next to the amount owed.", "comments", 9),
      record(4, "rating", "Ease of finding the balance", "Made-up: average ease rating for finding the balance.", "rating", 3.1),
      record(5, "bug", "Screen reader skips the balance amount", "Made-up: reports that the amount wasn't announced as a heading.", "comments", 4),
    ] };
  hub.revision = researchHubRevision(hub);
  fs.writeFileSync(path.join(dir, "research-hub.json"), JSON.stringify(hub), { mode: 0o600 });
}

// New people start with the Researcher tier: this sandbox's server grants it, as an owner would.
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ host: "127.0.0.1", port, defaultAgentTier: 4, dailyTokenLimit: dailyTokens, name: "Feedback sandbox", publicUrl, upstreams, ...(full ? { researchHold: false } : {}) }));
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
    "Design review: Balance due page", "Status: Published", `Preview: ${publicUrl}/p/${folder}/`,
    "Review focus: Can people tell the balance from a scheduled payment?", "Please leave feedback in this message's thread.",
  ].join("\n") }) });
}

// ---------- The preview persona ----------

const key = serverIdentity(dir).publicKey;
const TEAMMATES = new Set([olive.user.id, dev.user.id, rhea.user.id]);
const tokens = n => n.toLocaleString("en-US");
// A tester's name, tidied. Blank means a fresh Preview Researcher, as before names.
const testerName = value => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
// Signs in as a new Preview Researcher, or as the tester with this name: the same name is the same
// account again (its daily limit and its work), never one of the made-up teammates.
const signInLink = (name = "") => {
  const wanted = testerName(name);
  let code;
  if (wanted) {
    const existing = servant.mutateStateForTest(state => Object.values(state.users).filter(u => u.name.toLowerCase() === wanted.toLowerCase()));
    if (existing.some(u => TEAMMATES.has(u.id))) return null;
    code = existing.length ? servant.createInvite({ userId: existing[0].id }) : servant.createInvite({ name: wanted, role: "member" });
  } else code = servant.createInvite({ name: "Preview Researcher", role: "member" });
  return `${appUrl}/pair?${new URLSearchParams({ code, key, server: publicUrl })}`;
};

let app = null;
if (withApp) {
  // --clear: the app name and other settings from app.config.js are baked into the bundle cache.
  app = spawn("npx", ["expo", "start", "--web", "--clear", "--port", String(appPort)], { cwd: appDir, env: { ...process.env, BROWSER: "none" }, stdio: "ignore", detached: true });
  process.stdout.write(`Starting the app at ${appUrl}…`);
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(appUrl)).ok) break; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  process.stdout.write(" ready.\n");
}

// When sharing, the app is exported once (a few minutes) and served with the start page.
const webDir = path.join(dir, "web");
if (share) {
  process.stdout.write("Exporting the app for the web (this takes a few minutes)…");
  const exported = await new Promise(resolve => {
    const child = spawn("npx", ["expo", "export", "--platform", "web", "--clear", "--output-dir", webDir], { cwd: appDir, env: { ...process.env, CI: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-4000); });
    child.once("error", () => resolve(false));
    child.once("exit", code => { if (code !== 0) console.error(`\n${errors}`); resolve(code === 0); });
  });
  if (!exported || !fs.existsSync(path.join(webDir, "index.html"))) failShare(new Error("the web export failed."));
  process.stdout.write(" done.\n");
}

// ---------- The start page: sign in, every feature, the made-up files ----------

let startUrl = `http://localhost:${startPort}`;
const fixturesDir = path.join(appDir, "src", "lib", "fixtures");
// Only the made-up files in fixtures/ are offered, by name.
const SAMPLE_FILES = [
  ["research-studio-demo-ab.json", "The study (Civic Research Studio JSON)", "application/json"],
  ["qualtrics-survey2-SYNTHETIC.csv", "Follow-up survey export (Survey 2)", "text/csv"],
  ["qualtrics-survey1-SYNTHETIC.csv", "Intake survey export (Survey 1)", "text/csv"],
  ["qualtrics-embedded-SYNTHETIC.csv", "Follow-up survey with Research Studio inside: ratings and comments", "text/csv"],
];
const FEATURES = [
  { title: "Start page and onboarding", where: "/start", what: "Signing in shows the terms, then onboarding (role and goals), then starting points." },
  { title: "Research Studio", where: "/research", what: "Study plans, saved forms (Continue where you left off) and study readouts." },
  { title: "Build a study plan", where: "/research-new?kind=study", what: "Choose one or more methods to start from templates, add what the research found, create a prototype from it, edit the study activities and save a working draft for Civic Research Studio." },
  { title: "Write a study readout", where: "/readout", what: "Choose the study and an export from the made-up files below: charts, ratings, comments coded into themes and reviewed quotes, then a Word document or PDF." },
  { title: "Design Studio", where: "/designs", what: "New designs; each design's own page with a picture of it and everything you can do (design chat, view prototype, Adjust or Suggest, share for review, versions, duplicate); Adjust and Suggest right from the list too." },
  { title: "Review a teammate's design", where: general ? `/c/${general.id}` : "/channels", what: "The Balance due page review in #general: open the preview and suggest adjustments." },
  { title: "Agent", where: "/agent", what: "Chats with the stand-in agents, and the Servant Studio shortcuts." },
  { title: "Research preview", where: "/research-preview", what: "The local, no-data preview of the research and prototype interactions." },
];
const TASKS = [
  "Sign in, then choose a role and goals during onboarding.",
  "In Research Studio, start a study plan. Add what the research found (try a number, a quote or \"Form 1040\"), then create a prototype workspace and send the prompt.",
  "Pick one or two directions for the agent to build, and open the preview.",
  "Leave the study plan part-way, then find your way back to it.",
  "Adjust the design (change the heading's text), add the request to the design chat and send it. Then look at the design's versions.",
  "In #general, open the Balance due page review and suggest an adjustment.",
  "In Design, choose Suggest on Dev Designer's Balance due page and send your suggestion to Dev.",
  "Back in the study plan, tick a few methods under Choose your methods, replace the [bracketed] starting text, and save the working draft.",
  "Write a study readout from the study and its two exports. Write the summary, then save it as a Word document and as a PDF.",
  "Write another readout from the study and the export with Research Studio inside: look at the ratings, give a few comments themes, and quote one.",
];
// Which agent answers each kind of chat, and whether your own agents are answering right now.
const agentsCard = states => {
  const row = (label, lane, uses) => {
    const own = ownLanes.find(agent => agent.lane === lane);
    const state = own ? states[lane] : null;
    const status = !own ? "Stand-in: scripted sample replies that end with “(This is the feedback sandbox's stand-in agent…)”."
      : state === "ready" ? "✓ Your own agent, answering now. Its replies come from your model and have no stand-in note."
      : state === "key" ? "⚠ Your own agent answers, but rejects the sandbox's key, so its chats will fail."
      : "⚠ Your own agent isn't answering right now, so its chats will fail until its bridge is started again.";
    return `<li><strong>${escape(label)}</strong> <span class="muted">(${escape(uses)})</span><p${own && state !== "ready" ? ' class="warn"' : ""}>${escape(status)}</p></li>`;
  };
  return `<div class="card"><h2 style="margin-top:0">Agents in this sandbox</h2>
<ul class="features">${row("Researcher Agent", "researcher", "Agent chats, Synthesize existing evidence, research-informed design review, Prepare needs & pain points")}${row("Prototype agent", "prototype", "building and changing designs")}</ul>
<p class="muted">Checked when this page loaded. Reload to check again.</p></div>`;
};
const startPage = (states = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Servant feedback sandbox</title>
<style>
:root{color-scheme:light dark;--ink:#1b1b1b;--muted:#5c6670;--line:#d6dbe0;--surface:#f4f6f8;--blue:#0b5cad;--bg:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#eef1f4;--muted:#a3adb7;--line:#3a424a;--surface:#1e2328;--blue:#6fb0ff;--bg:#121619}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 8px}p{margin:6px 0}
.muted{color:var(--muted);font-size:14px}.card{background:var(--surface);border-radius:12px;padding:16px;margin:12px 0}
.button{display:inline-block;background:var(--blue);color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:10px;margin:8px 0}
@media (prefers-color-scheme:dark){.button{color:#0b1622}}
ul.features{list-style:none;padding:0;margin:0}ul.features li{border-top:1px solid var(--line);padding:12px 0}ul.features a{font-weight:600;color:var(--blue)}
ol li{margin:6px 0}.signin{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 4px}.signin label{font-weight:600;width:100%}.signin input{font:inherit;flex:1;min-width:200px;min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}.signin input:focus-visible{outline:3px solid var(--blue);outline-offset:1px}.signin .button{margin:0;border:0;cursor:pointer;font:inherit;font-weight:600}.warn{color:#b3261e;font-weight:600}@media (prefers-color-scheme:dark){.warn{color:#ffb4a9}}a{color:var(--blue)}a:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
</style></head><body><main>
<h1>Servant feedback sandbox</h1>
<p class="muted">Made-up people, data and designs, with ${ownAgents.length ? `this Mac's own ${escape(ownAgents.join(" and "))} (it calls a real model, so anything typed to it goes to that model's provider) and stand-ins for the other agents` : "stand-in agents that never call a model"}. ${share ? "It runs on one person's Mac and is shared through a temporary link; everything in it is deleted when it stops." : "It runs only on this Mac and is deleted when the sandbox stops."}</p>
<div class="card">
<h2 style="margin-top:0">1. Sign in with your name</h2>
<p>You'll have the Researcher agent tier, which reaches every Servant Studio feature. The sandbox's server grants it, as a workspace owner would.</p>
<form action="/sign-in" method="get" class="signin">
<label for="name">Your name</label>
<input id="name" name="name" autocomplete="name" maxlength="40" required>
<button class="button" type="submit">Sign in</button>
</form>
<p class="muted">Use the same name each time: it signs you in to the same account, with your work and your daily allowance. Each person can use up to <strong>${tokens(dailyTokens)} tokens a day</strong> with ${ownAgents.length ? "this Mac's own agent" : "the agents"}; it resets at midnight on this Mac. Agree to the terms, then go through onboarding. To switch people, sign out (You, then Sign out) or use a private window.</p>
</div>
${agentsCard(states)}
<h2>2. Open a feature</h2>
<p class="muted">After signing in, these open in the same browser.</p>
<ul class="features">${FEATURES.map(f => `<li><a href="${escape(appUrl + f.where)}">${escape(f.title)}</a><p>${escape(f.what)}</p></li>`).join("")}</ul>
<h2>3. Made-up files for study readouts</h2>
<p class="muted">Download these, then choose them in Write a study readout. Nobody took part in these studies.</p>
<ul>${SAMPLE_FILES.map(([name, label]) => `<li><a href="/files/${escape(name)}" download>${escape(label)}</a> <span class="muted">${escape(name)}</span></li>`).join("")}</ul>
<h2>4. Tasks to try</h2>
<ol>${TASKS.map(t => `<li>${escape(t)}</li>`).join("")}</ol>
<p class="muted">The teammates (Olive Owner, Dev Designer, Rhea Researcher) are made up. ${full ? "Research Hub and the Researcher Agent are turned on, with five made-up Research Hub records and scripted replies. They're paused in the pilot build." : "Research Hub and the Researcher Agent's design guidance are on hold, as in the pilot build."}</p>
</main></body></html>`;
const start = http.createServer((req, res) => {
  const url = new URL(req.url || "/", startUrl);
  if (req.method !== "GET") { res.writeHead(405).end(); return; }
  if (url.pathname === "/") {
    void Promise.all(ownLanes.map(async agent => [agent.lane, await agentState(agent)])).then(entries => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(startPage(Object.fromEntries(entries)));
    });
    return;
  }
  if (url.pathname === "/sign-in") {
    const link = signInLink(url.searchParams.get("name") ?? "");
    if (!link) {
      res.writeHead(409, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
        .end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Choose another name</title><body style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px"><h1>Choose another name</h1><p>That name belongs to one of the made-up teammates. Use your own name.</p><p><a href="/">Back to the start page</a></p></body></html>`);
      return;
    }
    res.writeHead(302, { Location: link, "Cache-Control": "no-store" }).end();
    return;
  }
  const file = SAMPLE_FILES.find(([name]) => url.pathname === `/files/${name}`);
  if (file) {
    res.writeHead(200, { "Content-Type": `${file[2]}; charset=utf-8`, "Content-Disposition": `attachment; filename="${file[0]}"` });
    fs.createReadStream(path.join(fixturesDir, file[0])).pipe(res);
    return;
  }
  if (share) { serveApp(url.pathname, res); return; }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
});
// The exported app: a file if there is one, otherwise the app's page (it routes in the browser).
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8" };
function serveApp(pathname, res) {
  let file = path.resolve(webDir, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(webDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(webDir, "index.html");
  const html = file.endsWith(".html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": html ? "no-store" : "public, max-age=3600" });
  fs.createReadStream(file).pipe(res);
}
await new Promise(resolve => start.listen(startPort, "127.0.0.1", resolve));
if (share) {
  process.stdout.write("Opening a Cloudflare quick tunnel for the app and start page…");
  startUrl = appUrl = await quickTunnel(`http://127.0.0.1:${startPort}`, "app").catch(failShare);
  process.stdout.write(` ${startUrl}\n`);
}

const show = () => {
  console.log(share ? `
Feedback sandbox is running and shared (made-up data, ${agentsText}${full ? ", every Servant Studio feature on" : ""}).

Send this link to the people testing. Anyone with it can sign in, so keep it to them.
Each person signs in with their name and can use up to ${tokens(dailyTokens)} tokens a day:
  ${startUrl}

It works while this window stays open and this Mac stays awake. The link changes each time the sandbox starts.

Ctrl+C stops sharing and deletes everything in the sandbox.
` : `
Feedback sandbox is running (made-up data, ${agentsText}, this Mac only).

Start here (sign in as the test persona, open every feature, get the made-up files):
  ${startUrl}

Or sign in straight away as Preview Researcher (this link works once; press Enter for another):
  ${signInLink()}

Ctrl+C stops the sandbox and deletes everything in it.
`);
};
show();
// Open the start page in the default browser on a Mac.
if (openStart && process.platform === "darwin") spawn("open", [startUrl], { stdio: "ignore", detached: true }).unref();

// Says so in the terminal when one of your agents stops (or starts again) answering.
if (ownLanes.length) {
  const last = Object.fromEntries(ownLanes.map(agent => [agent.lane, "ready"]));
  setInterval(async () => {
    for (const agent of ownLanes) {
      const state = await agentState(agent);
      if (state === last[agent.lane]) continue;
      last[agent.lane] = state;
      console.log(state === "ready" ? `Your ${agent.label} is answering again.` : `Your ${agent.label} stopped answering at ${agent.url}. Its chats will fail until its bridge is running again.`);
    }
  }, 60_000).unref();
}

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (app) { try { process.kill(-app.pid, "SIGTERM"); } catch { /* already stopped */ } }
  stopTunnels();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\nStopped. The sandbox and everything in it were deleted.");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
readline.createInterface({ input: process.stdin }).on("line", show).on("close", () => { if (!process.stdin.isTTY) return; stop(); });
