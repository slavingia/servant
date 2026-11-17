// Outbound network gate for the agent (docs/agent-egress.md). The agent runs in an OS sandbox whose only way out
// is this proxy on localhost. Nothing is reachable unless it is on the server's own "always" list or the person
// the agent is working for holds an entitlement that covers the host (entitlements.mjs). A refused attempt is
// written down and the people who can grant it are told; once it is granted the next attempt goes through.
//
// The proxy sees host names and ports only. HTTPS stays encrypted end to end (CONNECT); nothing is decrypted,
// and no request or reply text is stored.
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import { DatabaseSync } from "node:sqlite";

const MAX_HOLD_SECONDS = 120;

// ---------- settings ----------

/** A host name or a "*.example.gov" pattern, lowercased; null when it isn't one. Addresses are allowed as written. */
export function cleanHost(value) {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (net.isIP(host)) return host;
  if (!host || host.length > 253) return null;
  // Checked label by label: one pattern for the whole name backtracks badly on long hostile input.
  const labels = (host.startsWith("*.") ? host.slice(2) : host).split(".");
  return labels.every(label => label.length >= 1 && label.length <= 63 && /^[a-z0-9_]$|^[a-z0-9_][a-z0-9_-]*[a-z0-9_]$/.test(label)) ? host : null;
}

/** "*.example.gov" covers every name under example.gov, not example.gov itself. Anything else must match exactly. */
export function hostMatches(pattern, host) {
  if (pattern === host) return true;
  return pattern.startsWith("*.") && host.length > pattern.length - 1 && host.endsWith(pattern.slice(1));
}

/** `"agentEgress"` in config.json. Off unless mode is exactly "ask". */
export function egressSettings(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const port = Number(process.env.SERVANT_EGRESS_PORT ?? cfg.port);
  const hold = Number(cfg.holdSeconds);
  return {
    mode: cfg.mode === "ask" ? "ask" : "off",
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 8790,
    // Hosts every agent may reach without asking: the model provider and whatever else the agent itself needs to run.
    always: [...new Set((Array.isArray(cfg.always) ? cfg.always : []).map(cleanHost).filter(Boolean))],
    // How long a refused attempt waits for an owner before it fails. 0: fail at once; the agent can try again later.
    holdSeconds: Number.isFinite(hold) && hold > 0 ? Math.min(MAX_HOLD_SECONDS, Math.floor(hold)) : 0,
  };
}

// ---------- addresses the proxy never connects to ----------

const internal = new net.BlockList();
for (const [addr, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) internal.addSubnet(addr, bits, "ipv4");
for (const [addr, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) internal.addSubnet(addr, bits, "ipv6");

/** This Mac, the local network and other non-public ranges: allowing a host name must never open a way into them. */
export function isInternalAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return internal.check(mapped[1], "ipv4");
    return internal.check(address, "ipv6");
  }
  return internal.check(address, "ipv4");
}

// ---------- tokens and refused attempts ----------

const b64 = value => Buffer.from(String(value)).toString("base64url");
const DAY = 24 * 3600_000;

/**
 * The durable part, shared by the API process and the turn worker through one SQLite file.
 * secret: signs the token that says which person and chat a sandboxed command belongs to. A chat's token never
 *   changes (the agent's shell keeps the one it started with), and it stops counting when the person leaves.
 * attempts: one row per person and host the agent tried and was refused, so managers can see what was asked for.
 * Who may reach what is not kept here: that is the entitlements' job (entitlements.mjs).
 */
export function createEgressStore(file, { clock = Date.now } = {}) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS attempts (user_id TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, chat_id TEXT,
      attempts INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, told_at INTEGER NOT NULL, PRIMARY KEY(user_id, host));
    CREATE TABLE IF NOT EXISTS secret (id INTEGER PRIMARY KEY CHECK (id = 1), value BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS working (key TEXT PRIMARY KEY, user_id TEXT NOT NULL, started_at INTEGER NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO secret(id, value) VALUES (1, ?)").run(crypto.randomBytes(32));
  const secret = () => Buffer.from(db.prepare("SELECT value FROM secret WHERE id=1").get().value);
  const sign = body => crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const view = r => ({ userId: r.user_id, host: r.host, port: r.port, ...(r.chat_id ? { chatId: r.chat_id } : {}), attempts: r.attempts, firstAt: r.first_at, lastAt: r.last_at });
  return {
    /** Write down a refused attempt. `fresh` is true the first time and then at most once a day: that is when people are told. */
    refused({ userId, host, port, chatId }) {
      const now = clock();
      const existing = db.prepare("SELECT * FROM attempts WHERE user_id=? AND host=?").get(String(userId), host);
      const fresh = !existing || now - existing.told_at >= DAY;
      db.prepare(`INSERT INTO attempts(user_id,host,port,chat_id,attempts,first_at,last_at,told_at) VALUES (?,?,?,?,1,?,?,?)
        ON CONFLICT(user_id, host) DO UPDATE SET attempts=attempts+1, port=excluded.port, chat_id=COALESCE(excluded.chat_id, chat_id), last_at=excluded.last_at,
          told_at=CASE WHEN ? THEN excluded.told_at ELSE told_at END`).run(String(userId), host, port, chatId ?? null, now, now, now, fresh ? 1 : 0);
      return { attempt: view(db.prepare("SELECT * FROM attempts WHERE user_id=? AND host=?").get(String(userId), host)), fresh };
    },
    /** The most recent refusals, newest first. */
    recent: (limit = 100) => db.prepare("SELECT * FROM attempts ORDER BY last_at DESC LIMIT ?").all(Math.max(1, Math.min(500, limit))).map(view),
    /** What a sandboxed command presents to the proxy so its traffic counts as this person's, in this chat. */
    tokenFor(userId, chatId = "") {
      const body = `${b64(userId)}.${b64(chatId)}`;
      return `${body}.${sign(body)}`;
    },
    whose(token) {
      const parts = String(token || "").split(".");
      if (parts.length !== 3 || !parts[0] || !parts[2]) return null;
      const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`)), given = Buffer.from(parts[2]);
      if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
      const chatId = Buffer.from(parts[1], "base64url").toString();
      return { userId: Buffer.from(parts[0], "base64url").toString(), ...(chatId ? { chatId } : {}) };
    },
    /**
     * The agent starts working for someone outside an agent chat (a reply to @agent in a channel): returns the
     * function that ends it. Kept in the file so the API process and a separate worker agree; a row nobody ended
     * (a crash) stops counting after an hour.
     */
    working(userId) {
      const key = crypto.randomBytes(9).toString("base64url");
      db.prepare("INSERT INTO working(key,user_id,started_at) VALUES (?,?,?)").run(key, String(userId), clock());
      return () => { try { db.prepare("DELETE FROM working WHERE key=?").run(key); } catch { /* closed at shutdown: the row ages out */ } };
    },
    workingFor() {
      db.prepare("DELETE FROM working WHERE started_at < ?").run(clock() - 3600_000);
      return db.prepare("SELECT DISTINCT user_id FROM working").all().map(r => r.user_id);
    },
    close: () => db.close(),
  };
}

// ---------- the decision for one connection ----------

/**
 * Who a connection is for, and whether it may go out.
 *  - a host on the "always" list goes out for anyone;
 *  - a connection that carries a person's token is judged for that person;
 *  - one that carries none is judged for everyone whose agent is working right now, and goes out only when every
 *    one of them may reach the host (with nobody working, only the "always" list applies).
 * `allowed(userId, host)` is the entitlements' answer. Owners are not exempt: they hold entitlements like anyone else.
 * Returns { verdict: "allow" | "deny", blocked: [{ userId, chatId? }], reason? }.
 */
export function judge({ settings, host, token, whose = () => null, active = () => [], known = () => true, allowed }) {
  if (settings.always.some(p => hostMatches(p, host))) return { verdict: "allow", blocked: [] };
  const named = whose(token);
  const people = (named ? [named] : [...new Set(active())].map(userId => ({ userId }))).filter(p => known(p.userId));
  if (!people.length) return { verdict: "deny", blocked: [], reason: "nobody" };
  const blocked = people.filter(p => !allowed(p.userId, host));
  return { verdict: blocked.length ? "deny" : "allow", blocked };
}

// ---------- the proxy ----------

const refusal = (host, reason, hint) => reason === "nobody"
  ? `Servant blocked ${host}: no agent turn is running, so there is nobody whose entitlements could allow it. An owner can add it to "agentEgress.always" if the agent itself needs it.\n`
  : `Servant blocked ${host}: ${hint || "the person you are working for does not hold an entitlement that covers it."} Don't look for another route. Tell the person, and try again once a manager has granted it.\n`;

function proxyToken(headers) {
  const m = /^Basic\s+(.+)$/i.exec(headers["proxy-authorization"] || "");
  if (!m) return "";
  const text = Buffer.from(m[1], "base64").toString("utf8");
  const at = text.indexOf(":");
  // curl, git and pip send "user:password" from the proxy URL; the token may be either half.
  return (at < 0 ? text : text.slice(0, at) || text.slice(at + 1)).trim();
}

/** Resolve a name and refuse anything that lands on this machine or a private network, so a public name can't point inward. */
async function publicAddress(host, resolve) {
  if (net.isIP(host)) { if (isInternalAddress(host)) throw new Error("internal"); return host; }
  const found = await resolve(host);
  const addresses = (Array.isArray(found) ? found : [found]).map(a => a.address ?? a);
  if (!addresses.length || addresses.some(isInternalAddress)) throw new Error("internal");
  return addresses[0];
}

/**
 * The proxy itself. `settings()` is read for every connection, so config.json changes apply without a restart.
 * `allowed(userId, host)` asks the entitlements. `blocked(attempt)` is called the first time a person's agent is
 * refused a host (and at most daily after that). `hint(host, people)` may return a line for the agent about what to request.
 * `connect` and `resolve` are replaceable in tests.
 */
export function createEgressProxy({ store, settings, allowed, active, known, blocked = () => "", hint = () => "", log = console.warn,
  resolve = host => lookup(host, { all: true }), connect = (port, address) => net.connect(port, address), allowInternal = false, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  async function verdictFor(host, port, headers) {
    if (settings().mode !== "ask") return { verdict: "deny", blocked: [], reason: "off" };
    const token = proxyToken(headers);
    const ask = () => judge({ settings: settings(), host, token, whose: store.whose, active, known, allowed });
    let result = ask();
    for (const person of result.blocked) {
      const { attempt, fresh } = store.refused({ userId: person.userId, host, port, chatId: person.chatId });
      if (fresh) { try { blocked(attempt); } catch (error) { log("[egress] could not tell anyone:", error.message); } }
    }
    // Optionally wait for a manager, so a command already running carries on the moment the entitlement is granted.
    const until = Date.now() + settings().holdSeconds * 1000;
    while (result.verdict === "deny" && result.blocked.length && Date.now() < until) { await sleep(500); result = ask(); }
    if (result.verdict === "deny" && result.blocked.length) { try { result.hint = hint(host, result.blocked); } catch { /* the plain refusal still goes out */ } }
    return result;
  }
  const target = async host => allowInternal ? host : publicAddress(host, resolve);

  const server = http.createServer(async (req, res) => {
    // Plain HTTP through the proxy: "GET http://host/path". Anything else is not a proxy request.
    let url;
    try { url = new URL(req.url); } catch { url = null; }
    if (!url || url.protocol !== "http:") { res.writeHead(400, { "Content-Type": "text/plain" }); return res.end("This is the Servant agent proxy. It only forwards proxy requests.\n"); }
    const host = cleanHost(url.hostname), port = Number(url.port || 80);
    if (!host || host.startsWith("*.")) { res.writeHead(400, { "Content-Type": "text/plain" }); return res.end("That isn't a host name.\n"); }
    try {
      const result = await verdictFor(host, port, req.headers);
      if (result.verdict !== "allow") { res.writeHead(403, { "Content-Type": "text/plain", "X-Servant-Egress": result.verdict }); return res.end(refusal(host, result.reason, result.hint)); }
      const address = await target(host);
      const headers = { ...req.headers };
      for (const name of ["proxy-authorization", "proxy-connection"]) delete headers[name];
      const upstream = http.request({ host: address, port, method: req.method, path: url.pathname + url.search, headers, setHost: false });
      upstream.on("response", answer => { res.writeHead(answer.statusCode || 502, answer.headers); answer.pipe(res); });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" }); res.end(`Servant could not reach ${host}.\n`); });
      req.pipe(upstream);
    } catch (error) {
      const internalTarget = error.message === "internal";
      if (!res.headersSent) res.writeHead(internalTarget ? 403 : 502, { "Content-Type": "text/plain", ...(internalTarget ? { "X-Servant-Egress": "deny" } : {}) });
      res.end(internalTarget ? `Servant blocked ${host}: it is on this machine or a private network, which the agent may not reach.\n` : `Servant could not reach ${host}.\n`);
    }
  });

  // HTTPS and everything else that tunnels: "CONNECT host:port". The bytes inside are never read.
  server.on("connect", async (req, socket, head) => {
    const reply = (status, text, verdict) => {
      socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\n${verdict ? `X-Servant-Egress: ${verdict}\r\n` : ""}Content-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
    };
    socket.on("error", () => {});
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:]+):(\d{1,5})$/.exec(req.url || "");
    const host = m && cleanHost(m[1]), port = m ? Number(m[2]) : 0;
    if (!host || host.startsWith("*.") || port < 1 || port > 65535) return reply("400 Bad Request", "That isn't a host and port.\n");
    try {
      const result = await verdictFor(host, port, req.headers);
      if (result.verdict !== "allow") return reply("403 Forbidden", refusal(host, result.reason, result.hint), result.verdict);
      const address = await target(host);
      const upstream = connect(port, address);
      upstream.on("error", () => { if (socket.writable && !upstream.connecting) socket.destroy(); else reply("502 Bad Gateway", `Servant could not reach ${host}.\n`); });
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      socket.on("close", () => upstream.destroy());
    } catch (error) {
      if (error.message === "internal") return reply("403 Forbidden", `Servant blocked ${host}: it is on this machine or a private network, which the agent may not reach.\n`, "deny");
      return reply("502 Bad Gateway", `Servant could not reach ${host}.\n`);
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  return {
    server,
    /** Localhost only: the sandbox is the only thing meant to reach it. */
    listen(port = settings().port) { return new Promise((done, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", () => { server.off("error", fail); done(server.address().port); }); }); },
    close() { return new Promise(done => { server.close(() => done()); server.closeAllConnections?.(); }); },
  };
}
