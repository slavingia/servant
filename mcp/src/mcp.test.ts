// End to end: a throwaway Servant server; the MCP signs in through the device-link flow (a "phone"
// approves it), then a real MCP client calls the tools over stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

test("link with phone approval, then list, read, post and ask the agent through MCP", { timeout: 120000 }, async () => {
  const data = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "servant-mcp-"));
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "servant-mcp-home-"));
  // A tiny agent: every run answers "Done: <message>".
  const runs = new Map();
  const agent = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c; const body = raw ? JSON.parse(raw) : {};
    const json = (s: number, v: unknown) => res.writeHead(s, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    if (req.url === "/v1/capabilities") return json(200, { features: { servant_durable_media_runs: true, servant_exact_approvals: true } });
    if (req.url === "/api/sessions" && req.method === "POST") return json(201, { id: body.id });
    if (req.url?.startsWith("/api/sessions/") && req.url.endsWith("/messages")) return json(200, { data: [] });
    if (req.url?.startsWith("/api/sessions/")) return json(200, {});
    if (req.url === "/v1/runs") { const id = `run_${runs.size + 1}`; const t = body.input.at(-1).content; runs.set(id, `Done: ${typeof t === "string" ? t : t[0]?.text}`); return json(202, { run_id: id }); }
    const m = req.url?.match(/^\/v1\/runs\/([^/]+)(\/events)?$/);
    if (m && m[2]) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ event: "run.completed", output: runs.get(m[1]) })}\n\n`); return; }
    if (m) return json(200, { run_id: m[1], status: "completed", output: runs.get(m[1]) });
    json(404, {});
  });
  await new Promise<void>(r => agent.listen(0, "127.0.0.1", () => r()));
  const agentUrl = `http://127.0.0.1:${(agent.address() as any).port}`;
  for (const k of Object.keys(process.env)) if (/^(SERVANT_|HERMES_|API_SERVER_KEY)/.test(k)) delete process.env[k];
  const config = { host: "127.0.0.1", port: 0, name: "MCP test", agentName: "Agent", agentAccess: "full", publicUrl: "", discoveryUrl: "", adminKey: "",
    upstreams: { owner: { url: agentUrl, key: "k" }, member: { url: agentUrl, key: "k" } } };
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(data, "push.json"), "{}");
  Object.assign(process.env, { SERVANT_DATA_DIR: data, SERVANT_PUSH_CONFIG: path.join(data, "push.json") });
  const mod = await import(path.join(root, "server/server.mjs"));
  const srv = await mod.startServer(config);
  const port = srv.address().port, base = `http://127.0.0.1:${port}`;
  const { serverIdentity } = await import(path.join(root, "server/secure-transport.mjs"));
  const key = serverIdentity(data).publicKey;
  const { testFetch } = await import(path.join(root, "server/encrypted-test-client.mjs"));
  const { TERMS_VERSION, TERMS_ITEMS } = await import(path.join(root, "server/terms.mjs"));
  const code = new URL(mod.pairLink(mod.createInvite({ name: "Ana Ruiz", role: "owner" })).replace("servant://", "http://x/")).searchParams.get("code");
  const phone = await (await testFetch(data, base + "/v1/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, device: "iPhone", terms: { version: TERMS_VERSION, items: TERMS_ITEMS } }) })).json();
  const phoneCall = async (method: string, p: string, body?: unknown) => (await testFetch(data, base + p, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${phone.token}` }, body: body ? JSON.stringify(body) : undefined })).json();

  // 1. Link: the CLI prints a servant://link-device link; the phone approves it.
  const { spawn } = await import("node:child_process");
  const env = { ...process.env, SERVANT_MCP_HOME: home };
  const linker = spawn(process.execPath, [path.join(here, "index.ts"), "link", JSON.stringify({ server: base, serverKey: key }), "Test laptop"], { env });
  let out = ""; linker.stderr.on("data", d => { out += d; });
  for (let i = 0; i < 100 && !/link-device\?id=/.test(out); i++) await new Promise(r => setTimeout(r, 100));
  assert.match(out, /link-device\?id=/, `the link command printed a link: ${out}`);
  const linkId = new URL(out.match(/servant:\/\/link-device\?\S+/)![0].replace("servant://", "http://x/")).searchParams.get("id")!;
  assert.equal((await phoneCall("GET", `/v1/device-links/${linkId}`)).device, "Test laptop", "the phone sees what it's approving");
  await phoneCall("POST", `/v1/device-links/${linkId}/approve`, {});
  const exit = await new Promise(r => linker.on("exit", r));
  assert.equal(exit, 0, out);
  const saved = JSON.parse(fs.readFileSync(path.join(home, "account.json"), "utf8"));
  assert.equal(saved.user.name, "Ana Ruiz");
  assert.equal((fs.statSync(path.join(home, "account.json")).mode & 0o777), 0o600, "token file is private");

  // 2. MCP over stdio.
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "index.ts")], env: env as Record<string, string> }));
  try {
    const tools = (await client.listTools()).tools.map(t => t.name);
    for (const t of ["whoami", "list_conversations", "read_messages", "send_message", "ask_agent", "new_agent_chat"]) assert.ok(tools.includes(t), t);
    const text = async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
      return JSON.parse(r.content[0].text);
    };
    assert.equal((await text("whoami")).user.name, "Ana Ruiz");
    const general = (await text("list_conversations")).find((c: any) => c.name === "general");
    assert.ok(general, "general is listed");
    const sent = await text("send_message", { conversation_id: general.id, text: "Hello from an MCP client" });
    assert.ok(sent.id);
    const msgs = await text("read_messages", { conversation_id: general.id });
    assert.equal(msgs.at(-1).text, "Hello from an MCP client");
    assert.equal(msgs.at(-1).from, "Ana Ruiz");
    const chat = await text("new_agent_chat", { title: "From MCP", shared: true });
    const answer = await text("ask_agent", { chat_id: chat.id, text: "summarize the week" });
    assert.match(answer.text, /Done: summarize the week/);
    // A revoked device stops working right away.
    const devs = (await phoneCall("GET", "/v1/devices")).devices || [];
    const laptop = devs.find((d: any) => d.label === "Test laptop" || d.name === "Test laptop");
    assert.ok(laptop, `the linked laptop shows in the owner's devices: ${JSON.stringify(devs.map((d: any) => d.label))}`);
    {
      await phoneCall("DELETE", `/v1/devices/${laptop.id}`);
      const after: any = await client.callTool({ name: "list_conversations", arguments: {} });
      assert.ok(after.isError, "revoked device is refused");
    }
  } finally {
    await client.close(); await srv[["shut", "down"].join("")]?.(); agent.close();
    fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
  }
});
