#!/usr/bin/env node
// Servant hub. Zero dependencies. Runs on the owner's Mac.
//
// Phones talk to the hub (through a tunnel). The hub checks the device token,
// keeps each person's chats separate, and forwards messages to a Hermes API
// server on localhost. Hermes API keys never leave this machine.
//
//   node hub/server.mjs                     start the hub
//   node hub/server.mjs invite              print the team's join link (reusable until it expires)
//   node hub/server.mjs invite --name Me --role owner   one-time invite for a named person
//   node hub/server.mjs devices             list paired devices
//   node hub/server.mjs revoke <deviceId>   revoke a device

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMessaging } from "./messaging.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SERVANT_DATA_DIR || path.join(HERE, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const MAX_MESSAGE_CHARS = 8000;

// ---------- config + state ----------

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  const cfg = loadJson(CONFIG_FILE, {});
  return {
    host: process.env.SERVANT_HOST || cfg.host || "127.0.0.1",
    port: Number(process.env.SERVANT_PORT ?? cfg.port ?? 8787),
    name: cfg.name || "Servant",
    // Where the hub can be reached from phones. Filled in by the tunnel script.
    publicUrl: process.env.SERVANT_PUBLIC_URL || cfg.publicUrl || "",
    // Stable URL that always returns {"url": "<current publicUrl>"}.
    discoveryUrl: process.env.SERVANT_DISCOVERY_URL || cfg.discoveryUrl || "",
    upstreams: cfg.upstreams || {
      owner: { url: "http://127.0.0.1:8642", key: process.env.SERVANT_OWNER_KEY || "" },
      member: { url: "http://127.0.0.1:8643", key: process.env.SERVANT_MEMBER_KEY || "" },
    },
  };
}

function emptyState() {
  return { users: {}, devices: {}, invites: {}, chats: {} };
}

let state = loadJson(STATE_FILE, emptyState());
const persist = () => saveJson(STATE_FILE, state);
const reload = () => {
  state = loadJson(STATE_FILE, emptyState());
};

const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = () => Date.now();

// Invite codes are read aloud or typed: no 0/O/1/I/L.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function inviteCode() {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}
const normalizeCode = (c) => String(c || "").toUpperCase().replace(/[^0-9A-Z]/g, "");

// userId: pair another device (phone, iPad) for someone who's already on the hub.
export function createInvite({ name, role = "member", userId }) {
  reload();
  if (!["owner", "member"].includes(role)) throw new Error("role must be owner or member");
  const existing = userId ? state.users[userId] : null;
  if (userId && !existing) throw new Error("No such user");
  const code = inviteCode();
  state.invites[sha256(normalizeCode(code))] = {
    name: existing ? existing.name : String(name || "").slice(0, 80) || "Guest",
    role: existing ? existing.role : role,
    ...(existing ? { userId: existing.id } : {}),
    createdAt: now(),
    expiresAt: now() + INVITE_TTL_MS,
  };
  persist();
  return code;
}

// The team's join link: anyone with it can join as a member (they type their own
// name) until it expires. One live link at a time; fresh replaces the old one.
export function joinLink({ fresh = false } = {}) {
  reload();
  const live = Object.values(state.invites).find((i) => i.reusable && !i.revokedAt && i.expiresAt > now());
  if (live && !fresh) return { code: live.code, expiresAt: live.expiresAt };
  if (live) live.revokedAt = now();
  const code = inviteCode();
  state.invites[sha256(normalizeCode(code))] = { reusable: true, code, role: "member", uses: 0, createdAt: now(), expiresAt: now() + INVITE_TTL_MS };
  persist();
  return { code, expiresAt: now() + INVITE_TTL_MS };
}

export function pairLink(code, cfg = loadConfig()) {
  const params = new URLSearchParams({ code });
  if (cfg.discoveryUrl) params.set("d", cfg.discoveryUrl);
  else if (cfg.publicUrl) params.set("hub", cfg.publicUrl);
  return `servant://pair?${params}`;
}

// ---------- http helpers ----------

// Auth is a bearer token, never a cookie, so any origin may call the hub
// (the web build of the app runs on its own origin).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Max-Age": "600",
};

function send(res, status, body, headers = {}) {
  const data = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...CORS,
    ...headers,
  });
  res.end(data);
}

const fail = (res, status, code, message) => send(res, status, { error: { code, message } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Message is too long"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Body must be JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// Per-IP limiter on failed pairing codes. Successful pairings don't count, so
// a whole team can pair from one office network.
const pairFailures = new Map();
const PAIR_WINDOW_MS = 10 * 60 * 1000;
function pairAllowed(ip) {
  const list = (pairFailures.get(ip) || []).filter((t) => now() - t < PAIR_WINDOW_MS);
  pairFailures.set(ip, list);
  return list.length < 10;
}
function pairFailed(ip) {
  pairFailures.set(ip, [...(pairFailures.get(ip) || []), now()]);
}

function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "");
}

function authenticate(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;
  const device = state.devices[sha256(header.slice(7).trim())];
  if (!device || device.revokedAt) return null;
  const user = state.users[device.userId];
  if (!user) return null;
  device.lastSeenAt = now();
  return { device, user };
}

// ---------- upstream (Hermes API server) ----------

function upstreamFor(user, cfg) {
  const up = cfg.upstreams[user.role === "owner" ? "owner" : "member"];
  if (!up || !up.url || !up.key) return null;
  return up;
}

async function hermes(up, method, pathname, body, extraHeaders = {}) {
  const res = await fetch(new URL(pathname, up.url), {
    method,
    headers: {
      Authorization: `Bearer ${up.key}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

// Sends one turn to Hermes and calls onEvent(name, payload) for each SSE event.
// Resolves with the final assistant text.
async function streamTurn(up, sessionId, text, key, onEvent, isClosed = () => false) {
  const r = await hermes(
    up,
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
    { message: text },
    { Accept: "text/event-stream", "X-Hermes-Session-Key": key },
  );
  if (!r.ok || !r.body) throw Object.assign(new Error(`The agent didn't answer (${r.status})`), { status: 502, code: "agent_error" });
  const decoder = new TextDecoder();
  let buf = "";
  let final = "";
  let deltas = "";
  for await (const chunk of r.body) {
    if (isClosed()) break;
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let name = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue; // ignore malformed upstream event
      }
      if (name === "assistant.delta") deltas += payload.delta || "";
      if (name === "assistant.completed") final = payload.content || final;
      onEvent(name, payload);
    }
  }
  return final || deltas;
}

// Memory scope per person, so one member never sees another's long-term memory.
const sessionKey = (user) => `servant:${user.id}`;

function chatView(chat) {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p && (p.text || p.content) ? p.text || p.content : ""))
      .join("");
  }
  return "";
}

// ---------- routes ----------

let messaging = null;

async function handle(req, res, cfg) {
  const url = new URL(req.url, "http://hub");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, name: cfg.name });
  }

  // Lets the app check a hub address before pairing (and re-discover it later).
  if (method === "GET" && url.pathname === "/v1/hub") {
    return send(res, 200, { name: cfg.name, publicUrl: cfg.publicUrl || null });
  }

  if (method === "POST" && url.pathname === "/v1/pair") {
    const ip = clientIp(req);
    if (!pairAllowed(ip)) return fail(res, 429, "rate_limited", "Too many tries. Wait ten minutes");
    const body = await readBody(req);
    reload();
    const key = sha256(normalizeCode(body.code));
    const invite = state.invites[key];
    if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt < now()) {
      pairFailed(ip);
      return fail(res, 403, "invalid_invite", "That invite link doesn't work. Ask for a new one");
    }
    const name = invite.reusable ? String(body.name || "").trim().slice(0, 80) : invite.name;
    if (!name) return fail(res, 400, "name_required", "Enter your name");
    if (invite.reusable) invite.uses += 1;
    else invite.usedAt = now();
    const user = (invite.userId && state.users[invite.userId]) || { id: id("usr"), name, role: invite.role, createdAt: now() };
    const token = crypto.randomBytes(32).toString("base64url");
    const device = {
      id: id("dev"),
      userId: user.id,
      label: String(body.device || "Phone").slice(0, 80),
      createdAt: now(),
      lastSeenAt: now(),
    };
    state.users[user.id] = user;
    state.devices[sha256(token)] = device;
    persist();
    messaging?.joinDefaults(user.id);
    return send(res, 201, { token, user: { id: user.id, name: user.name, role: user.role }, hub: { name: cfg.name } });
  }

  // Everything below needs a device token.
  if (parts[0] !== "v1") return fail(res, 404, "not_found", "Not found");
  reload();
  const auth = authenticate(req);
  if (!auth) return fail(res, 401, "unauthorized", "This device isn't paired, or was removed");
  const { user, device } = auth;

  if (method === "GET" && url.pathname === "/v1/me") {
    persist();
    return send(res, 200, { user: { id: user.id, name: user.name, role: user.role }, device: { id: device.id, label: device.label }, hub: { name: cfg.name } });
  }

  if (method === "POST" && url.pathname === "/v1/signout") {
    device.revokedAt = now();
    persist();
    return send(res, 200, { ok: true });
  }

  // ----- owner-only admin -----
  if (parts[1] === "invites" || parts[1] === "devices") {
    if (user.role !== "owner") return fail(res, 403, "forbidden", "Only the owner can do that");
    if (method === "POST" && parts[1] === "invites" && parts.length === 2) {
      const body = await readBody(req);
      const { code, expiresAt } = joinLink({ fresh: body.fresh === true });
      reload();
      return send(res, 200, { code, link: pairLink(code, cfg), expiresAt });
    }
    if (method === "GET" && parts[1] === "devices" && parts.length === 2) {
      const list = Object.values(state.devices)
        .filter((d) => !d.revokedAt)
        .map((d) => ({ id: d.id, label: d.label, lastSeenAt: d.lastSeenAt, user: state.users[d.userId] && { name: state.users[d.userId].name, role: state.users[d.userId].role } }));
      return send(res, 200, { devices: list });
    }
    if (method === "DELETE" && parts[1] === "devices" && parts.length === 3) {
      const d = Object.values(state.devices).find((x) => x.id === parts[2]);
      if (!d) return fail(res, 404, "not_found", "No such device");
      d.revokedAt = now();
      persist();
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, "not_found", "Not found");
  }

  // ----- channels, direct messages, threads -----
  if (messaging && (await messaging.handle(req, res, { user, method, parts, url, send, fail, readBody, cors: CORS }))) return undefined;

  // ----- chats with the agent -----
  if (parts[1] !== "chats") return fail(res, 404, "not_found", "Not found");
  const up = upstreamFor(user, cfg);
  if (!up) return fail(res, 503, "agent_unavailable", "The agent isn't set up on this hub yet");
  const mine = Object.values(state.chats).filter((c) => c.userId === user.id && !c.deletedAt);

  if (method === "GET" && parts.length === 2) {
    persist();
    return send(res, 200, { chats: mine.sort((a, b) => b.updatedAt - a.updatedAt).map(chatView) });
  }

  if (method === "POST" && parts.length === 2) {
    const body = await readBody(req);
    const chatId = id("cht");
    const hermesSessionId = `servant_${user.id}_${chatId}`;
    const r = await hermes(up, "POST", "/api/sessions", { id: hermesSessionId, title: `Servant · ${user.name} · ${chatId.slice(-6)}` });
    if (!r.ok) return fail(res, 502, "agent_error", `The agent didn't start a chat (${r.status})`);
    const chat = {
      id: chatId,
      userId: user.id,
      role: user.role,
      hermesSessionId,
      title: String(body.title || "New chat").slice(0, 80),
      createdAt: now(),
      updatedAt: now(),
    };
    state.chats[chatId] = chat;
    persist();
    return send(res, 201, { chat: chatView(chat) });
  }

  const chat = mine.find((c) => c.id === parts[2]);
  if (!chat) return fail(res, 404, "not_found", "No such chat");
  // A member promoted to owner (or the reverse) keeps old chats on the old agent.
  const chatUp = cfg.upstreams[chat.role === "owner" ? "owner" : "member"];

  if (method === "DELETE" && parts.length === 3) {
    chat.deletedAt = now();
    persist();
    hermes(chatUp, "DELETE", `/api/sessions/${encodeURIComponent(chat.hermesSessionId)}`).catch(() => {});
    return send(res, 200, { ok: true });
  }

  if (method === "GET" && parts[3] === "messages" && parts.length === 4) {
    const r = await hermes(chatUp, "GET", `/api/sessions/${encodeURIComponent(chat.hermesSessionId)}/messages`);
    if (!r.ok) return fail(res, 502, "agent_error", `Couldn't load messages (${r.status})`);
    const data = await r.json();
    const raw = data.messages || data.data || [];
    const messages = raw
      .filter((m) => (m.role === "user" || m.role === "assistant") && textOf(m.content).trim())
      .map((m, i) => ({ id: String(m.id ?? i), role: m.role, text: textOf(m.content), at: m.timestamp || m.created_at || null }));
    return send(res, 200, { messages });
  }

  if (method === "POST" && parts[3] === "messages" && parts.length === 4) {
    const body = await readBody(req);
    const text = String(body.text || "").trim();
    if (!text) return fail(res, 400, "empty", "Type a message first");
    if (text.length > MAX_MESSAGE_CHARS) return fail(res, 413, "too_long", "That message is too long");

    if (chat.title === "New chat") chat.title = text.replace(/\s+/g, " ").slice(0, 60);
    chat.updatedAt = now();
    persist();

    res.writeHead(200, {
      ...CORS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15000);
    let closed = false;
    res.on("close", () => {
      closed = true;
      clearInterval(keepalive);
    });

    // Re-emit a small, stable event set. Members never see tool arguments.
    const owner = user.role === "owner";
    const forward = (name, payload) => {
      switch (name) {
        case "assistant.delta":
          return emit("delta", { text: payload.delta || "" });
        case "tool.started":
          return emit("status", { text: owner && payload.tool_name ? `Using ${payload.tool_name}` : "Working" });
        case "assistant.completed":
          return emit("message", { text: payload.content || "" });
        case "error":
          return emit("error", { message: "The agent hit a problem. Try again" });
        default:
          return undefined;
      }
    };

    try {
      await streamTurn(chatUp, chat.hermesSessionId, text, sessionKey(user), forward, () => closed);
    } catch (e) {
      if (!closed) emit("error", { message: e.code === "agent_error" ? "The agent didn't answer. Try again" : "Lost the connection to the agent" });
    }
    clearInterval(keepalive);
    if (!closed) {
      emit("done", {});
      res.end();
    }
    reload();
    if (state.chats[chat.id]) {
      state.chats[chat.id].updatedAt = now();
      if (state.chats[chat.id].title === "New chat") state.chats[chat.id].title = chat.title;
      persist();
    }
    return undefined;
  }

  return fail(res, 404, "not_found", "Not found");
}

export function startServer(fixedCfg) {
  // Without a fixed config, re-read it per request so a new tunnel address
  // (written by publish.mjs) shows up without a restart.
  const cfg = fixedCfg || loadConfig();
  process.umask(0o077); // messages.db and its WAL files are private to this user
  messaging ??= createMessaging({
    file: path.join(DATA_DIR, "messages.db"),
    users: () => state.users,
    agentName: () => (fixedCfg || loadConfig()).agentName || "Agent",
    // In channels several people read the answer, so the agent always runs
    // as the limited member profile, never the owner's.
    askAgent: async ({ sessionId, sessionKey: key, fresh, text, onDelta }) => {
      const up = upstreamFor({ role: "member" }, fixedCfg || loadConfig());
      if (!up) return "The agent isn't set up on this hub yet";
      if (fresh) {
        const made = await hermes(up, "POST", "/api/sessions", { id: sessionId, title: `Servant · ${sessionId.slice(8, 30)}` });
        if (!made.ok && made.status !== 409) throw new Error(`session ${made.status}`);
      }
      return streamTurn(up, sessionId, text, key, (name, p) => {
        if (name === "assistant.delta") onDelta(p.delta || "");
      });
    },
  });
  messaging.ensureGeneral();
  reload();
  for (const uid of Object.keys(state.users)) messaging.joinDefaults(uid);
  const server = http.createServer((req, res) => {
    handle(req, res, fixedCfg || loadConfig()).catch((err) => {
      if (res.headersSent) return res.end();
      const status = err.status || 500;
      if (status === 500) console.error("[servant]", err);
      fail(res, status, status === 500 ? "server_error" : err.code || "bad_request", status === 500 ? "Something went wrong on the hub" : err.message);
    });
  });
  server.requestTimeout = 0; // agent turns can take minutes
  server.headersTimeout = 30000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => resolve(server));
  });
}

// ---------- cli ----------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "invite") {
    const named = arg("name", "") || arg("user", "");
    const { code, expiresAt } = named
      ? { code: createInvite({ name: arg("name", ""), role: arg("role", "member"), userId: arg("user", "") || undefined }), expiresAt: now() + INVITE_TTL_MS }
      : joinLink({ fresh: process.argv.includes("--fresh") });
    console.log(`Invite code: ${code}`);
    console.log(`Link:        ${pairLink(code)}`);
    console.log(`${named ? "Single use" : "Anyone with it can join"}. Expires ${new Date(expiresAt).toDateString()}.`);
  } else if (cmd === "devices") {
    for (const d of Object.values(state.devices).filter((x) => !x.revokedAt)) {
      const u = state.users[d.userId] || {};
      console.log(`${d.id}  ${u.role || "?"}  ${u.name || "?"}  ${d.label}  last seen ${new Date(d.lastSeenAt).toISOString()}`);
    }
  } else if (cmd === "revoke") {
    const d = Object.values(state.devices).find((x) => x.id === process.argv[3]);
    if (!d) {
      console.error("No such device");
      process.exit(1);
    }
    d.revokedAt = now();
    persist();
    console.log(`Revoked ${d.id}`);
  } else {
    const cfg = loadConfig();
    const server = await startServer();
    const { port } = server.address();
    console.log(`[servant] hub listening on http://${cfg.host}:${port}`);
    for (const [role, up] of Object.entries(cfg.upstreams)) {
      console.log(`[servant] ${role} agent: ${up.url}${up.key ? "" : " (no key set)"}`);
    }
  }
}
