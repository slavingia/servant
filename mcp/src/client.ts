// A Servant workspace client for scripts and MCP: signs in like the Mac app (approve on your
// phone), then talks to the owner's server over the same end-to-end encrypted channel as the app.
// The server never sees a difference: same API, same permissions, same revocation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encryptedFetch } from "../../app/src/lib/tunnel-client.ts";

export type Workspace = { server: string; serverKey: string; discovery?: string; serverName?: string };
export type Account = Workspace & { token: string; user: { id: string; name: string; role: string } };

const CONFIG_DIR = process.env.SERVANT_MCP_HOME || path.join(os.homedir(), ".config", "servant-mcp");
export const accountFile = () => path.join(CONFIG_DIR, "account.json");

export function loadAccount(): Account | null {
  try { return JSON.parse(fs.readFileSync(accountFile(), "utf8")); } catch { return null; }
}
function saveAccount(a: Account) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(accountFile(), JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
}

/** A workspace from a Servant link (servant://… or https://…?server=&key=) or JSON {server, serverKey, discovery}. */
export function parseWorkspace(input: string): Workspace {
  const text = input.trim();
  if (text.startsWith("{")) {
    const w = JSON.parse(text);
    if (typeof w.server !== "string" || typeof w.serverKey !== "string") throw new Error("Workspace JSON needs server and serverKey");
    return { server: w.server.replace(/\/+$/, ""), serverKey: w.serverKey, ...(w.discovery ? { discovery: w.discovery } : {}) };
  }
  const url = new URL(text.replace(/^servant:\/\//, "https://x/"));
  const discovery = url.searchParams.get("discovery") || url.searchParams.get("d");
  const server = url.searchParams.get("server") || url.searchParams.get("hub") || "";
  const serverKey = url.searchParams.get("key");
  // Invites from a server behind a changing tunnel carry only the discovery address (d=).
  if ((!server && !discovery) || !serverKey) throw new Error("That link has no server address and key. Use an invite or workspace link from Servant");
  return { server: server.replace(/\/+$/, ""), serverKey, ...(discovery ? { discovery } : {}) };
}

async function discover(w: Workspace) {
  if (!w.discovery) return w.server;
  const r = await fetch(`${w.discovery}${w.discovery.includes("?") ? "&" : "?"}t=${Date.now()}`);
  const d = r.ok ? await r.json() as { url?: string } : {};
  return typeof d.url === "string" && /^https?:\/\//.test(d.url) ? d.url.replace(/\/+$/, "") : w.server;
}

export class ServantError extends Error {
  status: number; code: string;
  constructor(message: string, status = 0, code = "") { super(message); this.status = status; this.code = code; }
}

/** One encrypted API call. Follows the server if its address moved. */
export async function call<T = any>(w: Workspace & { token?: string }, method: string, apiPath: string, body?: unknown): Promise<T> {
  const init = { method, headers: { "Content-Type": "application/json", ...(w.token ? { Authorization: `Bearer ${w.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  if (!w.server && w.discovery) w.server = await discover(w);
  let res = await encryptedFetch(w.server, w.serverKey, apiPath, init).catch(() => null);
  if ((!res || [502, 503, 530].includes(res.status)) && w.discovery) {
    const moved = await discover(w);
    if (moved !== w.server) {
      w.server = moved;
      if ("token" in w && w.token) saveAccount(w as Account);
      res = await encryptedFetch(w.server, w.serverKey, apiPath, init).catch(() => null);
    }
  }
  if (!res) throw new ServantError("Couldn't reach the Servant server. Check your connection, or that the owner's Mac is on");
  const data = await res.json().catch(() => null);
  // The server ends sessions after a while (sessionMaxHours); this client has no screen for the emailed code, so link again.
  if (data?.error?.code === "session_expired") throw new ServantError(`Your Servant session ended. Run: servant-mcp link "<invite or workspace link>" again (approve it on your phone) to continue`, res.status, "session_expired");
  if (!res.ok) throw new ServantError(data?.error?.message || `Servant answered ${res.status}`, res.status, data?.error?.code || "");
  return data as T;
}

/**
 * Sign in as a new device. Prints a code; approve it on your phone (You → Link a computer → scan,
 * or open the servant://link-device link). Saves the device token to ~/.config/servant-mcp.
 */
export async function link(w: Workspace, deviceName = "MCP client", log: (s: string) => void = console.error, { agent = true }: { agent?: boolean } = {}): Promise<Account> {
  const server = await discover(w);
  const ws = { ...w, server };
  const start = await call<{ id: string; secret: string; code: string; expiresAt: number; intervalMs: number }>(ws, "POST", "/v1/device-links", { device: deviceName, ...(agent ? { agent: true } : {}) });
  const approveLink = `servant://link-device?${new URLSearchParams({ id: start.id, key: w.serverKey })}`;
  log(`Approve this sign-in on your phone: You → Link a computer, then scan or open\n  ${approveLink}\nCode: ${start.code} (check it matches on your phone)`);
  while (Date.now() < start.expiresAt) {
    await new Promise(r => setTimeout(r, Math.max(1000, start.intervalMs || 2000)));
    const poll = await call<any>(ws, "POST", `/v1/device-links/${start.id}/poll`, { secret: start.secret });
    if (poll.status === "approved") {
      const account: Account = { ...ws, token: poll.token, user: poll.user, serverName: poll.server?.name };
      saveAccount(account);
      log(`Signed in as ${poll.user.name} on ${poll.server?.name || "Servant"}. Saved to ${accountFile()}`);
      return account;
    }
  }
  throw new ServantError("The sign-in code expired. Run link again");
}

/** Read a Server-Sent Events stream (an agent turn) to the end; returns the agent's final text. */
export async function streamAgent(a: Account, chatId: string, text: string): Promise<{ text: string; status: string }> {
  const res = await encryptedFetch(a.server, a.serverKey, `/v1/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${a.token}` },
    body: JSON.stringify({ text, requestId: crypto.randomUUID().replace(/-/g, "") }),
  });
  if (!res.ok) { const e = await res.json().catch(() => null) as any; throw new ServantError(e?.error?.message || `Servant answered ${res.status}`, res.status); }
  let reply = "", status = "completed", buf = "";
  const reader = res.body!.getReader(); const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const name = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!name || !data) continue;
      const p = JSON.parse(data);
      if (name === "delta") reply += p.text || "";
      if (name === "message" && typeof p.text === "string") reply = p.text;
      if (name === "turn" && p.turn?.status) status = p.turn.status;
      if (name === "error") throw new ServantError(p.message || "The agent hit a problem");
    }
  }
  return { text: reply.trim(), status };
}

/**
 * Ask your own phone for a one-time code and wait for it (docs/code-requests.md). Your phone gets a push; you type the
 * code in Servant; this returns it. Gives up when the request expires, is cancelled, or `signal` aborts.
 */
export async function requestCode(a: Account, label: string, hint?: string, { timeoutSeconds = 600, length, log = (_: string) => {}, signal, intervalMs = 2000 }:
  { timeoutSeconds?: number; length?: number; log?: (s: string) => void; signal?: AbortSignal; intervalMs?: number } = {}): Promise<string> {
  const { request } = await call<{ request: { id: string; expiresAt: number } }>(a, "POST", "/v1/code-requests", { label, ...(hint ? { hint } : {}), ...(length ? { length } : {}), ttlSeconds: timeoutSeconds });
  log(`Waiting for you to enter the ${label} code in Servant on your phone…`);
  const path = `/v1/code-requests/${encodeURIComponent(request.id)}`;
  try {
    for (;;) {
      if (signal?.aborted) throw new ServantError("Cancelled");
      const out = await call<{ status: string; code?: string }>(a, "POST", `${path}/claim`, {});
      if (out.status === "answered" && out.code) return out.code;
      if (out.status !== "pending") throw new ServantError(out.status === "expired" ? "The code request expired before a code was entered" : `The code request was ${out.status}`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  } catch (error) {
    if (signal?.aborted) await call(a, "POST", `${path}/cancel`, {}).catch(() => {});
    throw error;
  }
}
