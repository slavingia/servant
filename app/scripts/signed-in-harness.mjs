// A local, loopback-only Servant server for the signed-in browser checks
// (web-signed-in.test.mjs). Everything is synthetic: a temporary data
// directory, fake agent upstreams that never call a model, made-up people and
// one sample prototype page. No real accounts, evidence or credentials.
//
//   node scripts/signed-in-harness.mjs <accounts.json to write>
//
// It writes the paired accounts (and where the data lives) to that file, then
// keeps running until it is stopped.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const out = process.argv[2];
if (!out) throw new Error("Usage: node scripts/signed-in-harness.mjs <accounts.json>");
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-signed-in-"));
process.env.SERVANT_DATA_DIR = dir;
const { restrictedTestCapabilities, researcherTestCapabilities } = await import(path.join(serverDir, "test-hermes-capabilities.mjs"));
const durable = c => ({ ...c, features: { ...c.features, servant_durable_media_runs: true, servant_exact_approvals: true, servant_run_keys: true } });

// Answers just enough of the agent API for chats to open and reply.
function fakeAgent(key, capabilities) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* body unused */ }
    const json = (status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/v1/capabilities") return json(200, capabilities);
    if (req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end();
    if (req.method === "POST" && req.url === "/api/sessions") return json(201, { session: {} });
    if (req.method === "POST" && /\/chat\/stream$/.test(req.url)) {
      const reply = "Sample reply from the test agent.";
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: run.started\ndata: {}\n\n");
      res.write(`event: assistant.delta\ndata: ${JSON.stringify({ delta: reply })}\n\n`);
      res.write(`event: assistant.completed\ndata: ${JSON.stringify({ content: reply })}\n\n`);
      return res.end("event: run.completed\ndata: {}\n\nevent: done\ndata: {}\n\n");
    }
    if (req.method === "DELETE") return json(200, {});
    if (req.url.startsWith("/api/sessions/")) return json(200, { object: "list", data: [] });
    return json(404, {});
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, key })));
}
const upstreams = {
  owner: await fakeAgent("owner-key", restrictedTestCapabilities),
  member: await fakeAgent("member-key", restrictedTestCapabilities),
  researcher: await fakeAgent("researcher-key", durable(researcherTestCapabilities)),
  prototype: await fakeAgent("prototype-key", durable(restrictedTestCapabilities)),
};
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 0, defaultAgentTier: 3, name: "Local check", publicUrl: "https://tsoa.example.test", upstreams }));
fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify({ projects: [{ id: "design-prototypes", name: "Design prototypes", repo: "example/design-prototypes", path: "~/design-prototypes", workflow: "main", rules: ["Made-up sample data only"] }] }));

const servant = await import(path.join(serverDir, "server.mjs"));
const { testFetch } = await import(path.join(serverDir, "encrypted-test-client.mjs"));
const { serverIdentity } = await import(path.join(serverDir, "secure-transport.mjs"));
const { TERMS_VERSION, TERMS_ITEMS } = await import(path.join(serverDir, "terms.mjs"));
const listening = await servant.startServer();
const base = `http://127.0.0.1:${listening.address().port}`;
const pair = async (name, role) => {
  const code = servant.createInvite({ name, role });
  const response = await testFetch(dir, `${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terms: { version: TERMS_VERSION, items: TERMS_ITEMS }, code: code.toLowerCase(), name }) });
  const body = await response.json();
  if (response.status !== 201) throw new Error(`Pairing ${name} failed: ${response.status}`);
  return { token: body.token, serverUrl: base, serverKey: serverIdentity(dir).publicKey, serverName: "Local check", user: body.user };
};
const boss = await pair("Olive Owner", "owner");
const researcher = await pair("Rhea Researcher", "member");
const designer = await pair("Dev Designer", "member");
const folder = `proto-${"a1b2c3d4e5".repeat(2)}`;
const kitFolder = `proto-${"0a1b2c3d4e".repeat(2)}`;
servant.mutateStateForTest(state => {
  state.users[researcher.user.id].agentTier = 4;
  const design = (id, title, extra) => ({ id, userId: designer.user.id, role: "member", hermesSessionId: `servant_${designer.user.id}_${id}`, title,
    projectId: "design-prototypes", mode: "vibe", hosted: "server", createdAt: Date.now(), updatedAt: Date.now(), ...extra });
  // A shared design with a live page, and a private draft with none yet.
  state.chats.cht_sample_ready = design("cht_sample_ready", "Balance lookup prototype", { shared: true, vibeFolder: folder });
  state.chats.cht_sample_draft = design("cht_sample_draft", "Private sketch", { shared: false, vibeFolder: `proto-${"f".repeat(20)}`, updatedAt: Date.now() - 1000 });
  // A private design whose page has a design kit (CSS custom properties), measured sizes and accessibility problems to find.
  state.chats.cht_sample_kit = design("cht_sample_kit", "Kit check", { shared: false, vibeFolder: kitFolder, updatedAt: Date.now() - 2000 });
});
fs.mkdirSync(path.join(dir, "prototypes", folder), { recursive: true });
// A small made-up page to adjust: a heading, a paragraph, a button and a link.
const samplePage = `<!doctype html><html><head><title>Sample balance page</title></head><body><main><h1>Your balance</h1><p>$50.00 is due on the 15th.</p><button>Pay now</button><a href="#help">Help</a></main></body></html>`;
fs.writeFileSync(path.join(dir, "prototypes", folder, "index.html"), samplePage);
const kitPage = `<!doctype html><html><head><title>Kit check</title><style>:root{--brand:#1a73e8;--ink:#333333;--space-2:16px}body{margin:0;font-family:sans-serif}h1{color:var(--ink);margin:16px}p{color:#aaaaaa;font-size:13.3333px;margin:16px}</style></head><body><main><h1>Kit heading</h1><p>Fine print that is hard to read.</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"><button>Go</button></main></body></html>`;
fs.mkdirSync(path.join(dir, "prototypes", kitFolder), { recursive: true });
fs.writeFileSync(path.join(dir, "prototypes", kitFolder, "index.html"), kitPage);
fs.writeFileSync(out, JSON.stringify({ dir, base, folder, kitFolder, samplePage, kitPage, boss, researcher, designer }, null, 2), { mode: 0o600 });
console.log(`signed-in harness ready at ${base}`);
