#!/usr/bin/env node
// Servant server. Zero dependencies. Runs on the owner's Mac.
//
// Phones talk to the server (through a tunnel). The server checks the device token,
// keeps each person's chats separate, and forwards messages to a Hermes API
// server on localhost. Hermes API keys never leave this machine.
//
//   node server/server.mjs                     start the server
//   node server/server.mjs invite              print the team's join link (reusable until it expires)
//   node server/server.mjs invite --name Me --role owner   one-time invite for a named person
//   node server/server.mjs devices             list paired devices
//   node server/server.mjs revoke <deviceId>   revoke a device
//   node server/server.mjs release <build> <notes.md>   post a build's notes to #whats-new

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMessaging } from "./messaging.mjs";
import os from "node:os";
import { createFeedback, feedbackPrompt, feedbackResult } from "./feedback.mjs";
import { createPushService, preferences, updatePushRegistration, updatePreferences } from "./push.mjs";
import { createPushTransport } from "./push-transport.mjs";
import { createSecureTransport, serverIdentity } from "./secure-transport.mjs";
import { createStateStore } from "./state-store.mjs";
import { createChatMediaStore } from "./chat-media.mjs";
import { createAgentTurns, terminalTurn } from "./agent-turns.mjs";
import { supportsDurableRuns, runDurableHermes } from "./hermes-runs.mjs";
import { verifyMemberUpstream } from "./member-policy.mjs";
import { validateUploads, normalizeMediaContent, hermesInput, mediaPage, createMediaDeltaFilter, MAX_UPLOAD_BODY } from "./media.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SERVANT_DATA_DIR || path.join(HERE, "data");
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
    agentName: cfg.agentName || "Agent",
    // "full" (default): everyone's agent has full Hermes access. "limited":
    // non-owners use the restricted member bridge (docs/member-security.md).
    agentAccess: cfg.agentAccess === "limited" ? "limited" : "full",
    // Where the server can be reached from phones. Filled in by the tunnel script.
    publicUrl: process.env.SERVANT_PUBLIC_URL || cfg.publicUrl || "",
    // Stable URL that always returns {"url": "<current publicUrl>"}.
    discoveryUrl: process.env.SERVANT_DISCOVERY_URL || cfg.discoveryUrl || "",
    // Lets build scripts on this Mac post release notes. Never leaves the Mac.
    adminKey: process.env.SERVANT_ADMIN_KEY || cfg.adminKey || "",
    upstreams: cfg.upstreams || {
      owner: { url: "http://127.0.0.1:8642", key: process.env.SERVANT_OWNER_KEY || "" },
      member: { url: "http://127.0.0.1:8643", key: process.env.SERVANT_MEMBER_KEY || "" },
    },
  };
}

// Lazy initialization keeps the independent feedback worker from migrating or
// opening account storage just because it imports runFeedback.
let stateStore;
const store = () => stateStore ??= createStateStore({ directory: DATA_DIR });
const readState = () => store().read();
const mutateState = fn => store().mutate(fn);

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

// userId: pair another device (phone, iPad) for someone who's already on the server.
export function createInvite({ name, role = "member", userId }) {
  return mutateState(state => {
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
    return code;
  });
}

// The team's join link: anyone with it can join as a member (they type their own
// name) until it expires. One live link at a time; fresh replaces the old one.
export function joinLink({ fresh = false } = {}) {
  return mutateState(state => makeJoinLink(state, { fresh }));
}

function makeJoinLink(state, { fresh }) {
  const live = Object.values(state.invites).find((i) => i.reusable && !i.revokedAt && i.expiresAt > now());
  if (live && !fresh) return { code: live.code, expiresAt: live.expiresAt };
  if (live) live.revokedAt = now();
  const code = inviteCode();
  state.invites[sha256(normalizeCode(code))] = { reusable: true, code, role: "member", uses: 0, createdAt: now(), expiresAt: now() + INVITE_TTL_MS };
  return { code, expiresAt: now() + INVITE_TTL_MS };
}

export function pairLink(code, cfg = loadConfig()) {
  const params = new URLSearchParams({ code });
  params.set("key", serverIdentity(DATA_DIR).publicKey);
  if (cfg.discoveryUrl) params.set("d", cfg.discoveryUrl);
  else if (cfg.publicUrl) params.set("hub", cfg.publicUrl);
  return `servant://pair?${params}`;
}

// ---------- http helpers ----------

// Auth is a bearer token, never a cookie, so any origin may call the server
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

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
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

function authenticate(req, state) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;
  const device = state.devices[sha256(header.slice(7).trim())];
  if (!device || device.revokedAt) return null;
  const user = state.users[device.userId];
  if (!user) return null;
  return { device, user };
}

const requestError = (status, code, message) => Object.assign(new Error(message), { status, code });
function requireAuth(req, state = readState(), owner = false) {
  const auth = authenticate(req, state);
  if (!auth) throw requestError(401, "unauthorized", "This device isn't paired, or was removed");
  if (owner && auth.user.role !== "owner") throw requestError(403, "forbidden", "Only the owner can do that");
  return auth;
}
const mutateAuthenticated = (req, fn, owner = false) => mutateState(state => {
  const auth = requireAuth(req, state, owner);
  auth.device.lastSeenAt = now();
  return fn(state, auth);
});
function requireChat(state, userId, chatId) {
  const chat = state.chats[chatId];
  if (!chat || chat.deletedAt || chat.userId !== userId) throw requestError(404, "not_found", "No such chat");
  return chat;
}
function revokeDevice(device) {
  device.revokedAt = now();
  delete device.push;
  delete device.pushPresence;
}

// ---------- upstream (Hermes API server) ----------

// Owner, 10/31: the agent has full Hermes access for everyone (files, terminal,
// web, memory), no approvals. Set "agentAccess": "limited" in config.json to go
// back to the restricted member bridge for non-owners.
function fullAgentAccess(cfg) {
  return cfg.agentAccess !== "limited";
}

function agentRole(role, cfg) {
  return role === "owner" || fullAgentAccess(cfg) ? "owner" : "member";
}

function upstreamFor(user, cfg) {
  const up = cfg.upstreams[agentRole(user.role, cfg)];
  if (!up || !up.url || !up.key) return null;
  return up;
}

async function hermes(up, method, pathname, body, extraHeaders = {}, signal) {
  const res = await fetch(new URL(pathname, up.url), {
    method,
    headers: {
      Authorization: `Bearer ${up.key}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return res;
}

// Sends one turn to Hermes and calls onEvent(name, payload) for each SSE event.
// Resolves with the final assistant text.
async function streamTurn(up, sessionId, text, key, onEvent, isClosed = () => false, onAccepted = () => {}) {
  const r = await hermes(
    up,
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
    { message: text },
    { Accept: "text/event-stream", "X-Hermes-Session-Key": key },
  );
  if (!r.ok || !r.body) throw Object.assign(new Error(`The agent didn't answer (${r.status})`), { status: 502, code: "agent_error" });
  await onAccepted();
  const decoder = new TextDecoder();
  let buf = "";
  let final = "";
  let completed = false;
  const filterDelta = createMediaDeltaFilter();
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
      if (name === "assistant.delta") {
        const delta = filterDelta(payload.delta || "");
        if (delta) onEvent(name, { ...payload, delta });
        continue;
      }
      if (name === "assistant.completed") {
        completed = true;
        const tail = filterDelta("", true);
        if (tail) onEvent("assistant.delta", { delta: tail });
        final = payload.content || final;
      }
      onEvent(name, payload);
    }
  }
  const tail = filterDelta("", true);
  if (tail) onEvent("assistant.delta", { delta: tail });
  if (!completed) throw requestError(502, "agent_error", "The agent response ended before it finished");
  return final;
}

// Memory scope per person, so one member never sees another's long-term memory.
const sessionKey = (user) => `servant:${user.id}`;

function chatView(chat) {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt };
}

// ---------- routes ----------

let push;
let feedback;
let messaging = null;
let secureTransport = null;
let chatMedia;
let agentTurns;
let privateTimer;
const privateStreams = new Set();
const chatMediaStore = () => chatMedia ??= createChatMediaStore(path.join(DATA_DIR, "chat-media.db"));

async function handle(req, res, cfg) {
  const url = new URL(req.url, "http://server");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, name: cfg.name });
  }

  // Lets the app check a server address before pairing (and re-discover it later).
  if (method === "GET" && (url.pathname === "/v1/server" || url.pathname === "/v1/hub")) {
    return send(res, 200, { name: cfg.name, publicUrl: cfg.publicUrl || null });
  }

  if (method === "POST" && url.pathname === "/v1/secure" && !req.encryptedTransport) {
    return secureTransport.handle(req, res, (innerReq, innerRes) => handle(innerReq, innerRes, cfg));
  }
  if (url.pathname.startsWith("/v1/") && !req.encryptedTransport) {
    // Only an operator can grandfather an already-paired device during the
    // initial rollout. New devices/pairing remain encrypted, and the grant is
    // bounded by an explicit expiry stored in private transactional state.
    const legacy = authenticate(req, readState());
    if (url.pathname === "/v1/pair" || !legacy || !Number.isSafeInteger(legacy.device.legacyPlaintextUntil) || legacy.device.legacyPlaintextUntil <= now()) {
      return fail(res, 426, "encryption_required", "Update Servant and open a new invite from your admin to enable encryption");
    }
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", new Date(legacy.device.legacyPlaintextUntil).toUTCString());
  }

  if (method === "POST" && url.pathname === "/v1/pair") {
    const ip = clientIp(req);
    if (!pairAllowed(ip)) return fail(res, 429, "rate_limited", "Too many tries. Wait ten minutes");
    const body = await readBody(req);
    const { token, user } = mutateState(state => {
      const key = sha256(normalizeCode(body.code));
      const invite = state.invites[key];
      if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt < now()) {
        pairFailed(ip);
        throw requestError(403, "invalid_invite", "That invite link doesn't work. Ask for a new one");
      }
      const name = invite.reusable ? String(body.name || "").trim().slice(0, 80) : invite.name;
      if (!name) throw requestError(400, "name_required", "Enter your name");
      if (invite.reusable) invite.uses += 1;
      else invite.usedAt = now();
      const user = (invite.userId && state.users[invite.userId]) || { id: id("usr"), name, role: invite.role, createdAt: now() };
      const token = crypto.randomBytes(32).toString("base64url");
      state.users[user.id] = user;
      state.devices[sha256(token)] = {
        id: id("dev"), userId: user.id, label: String(body.device || "Phone").slice(0, 80),
        createdAt: now(), lastSeenAt: now(),
      };
      return { token, user };
    });
    messaging?.joinDefaults(user.id);
    return send(res, 201, { token, user: { id: user.id, name: user.name, role: user.role }, server: { name: cfg.name }, hub: { name: cfg.name } });
  }

  // Build scripts on this Mac post release notes. Tunnel traffic always carries
  // cf-connecting-ip, so it can't reach this even with the key.
  if (method === "POST" && url.pathname === "/admin/releases") {
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) && !req.headers["cf-connecting-ip"];
    const key = String(req.headers["x-servant-admin"] || "");
    const ok = cfg.adminKey && key.length === cfg.adminKey.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(cfg.adminKey));
    if (!local || !ok) return fail(res, 403, "forbidden", "Not allowed");
    const body = await readBody(req);
    const owner = Object.values(readState().users).find((u) => u.role === "owner");
    if (!owner) return fail(res, 409, "no_owner", "Pair the owner first");
    return send(res, 200, { release: messaging.postRelease({ build: body.build, notes: body.notes, authorId: owner.id }) });
  }

  // Everything below needs a device token.
  if (parts[0] !== "v1") return fail(res, 404, "not_found", "Not found");
  const state = readState();
  const auth = requireAuth(req, state);
  const { user, device } = auth;
  const readAuthorizedBody = async (...args) => {
    const body = await readBody(...args);
    requireAuth(req);
    return body;
  };

  if (parts[1] === "feedback") {
    if (method === "GET" && parts.length === 2) return send(res, 200, { reports: feedback.list(user.id) });
    if (method === "POST" && parts.length === 2) return send(res, 202, { report: feedback.submit(user.id, await readAuthorizedBody(req)) });
    if (method === "POST" && parts.length === 4 && parts[3] === "retry") {
      feedback.retry(user.id, parts[2]);
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, "not_found", "Not found");
  }

  if (method === "GET" && url.pathname === "/v1/me") {
    mutateAuthenticated(req, (_state, current) => { current.device.lastSeenAt = now(); });
    return send(res, 200, { user: { id: user.id, name: user.name, role: user.role }, device: { id: device.id, label: device.label }, server: { name: cfg.name }, hub: { name: cfg.name } });
  }

  if (method === "POST" && url.pathname === "/v1/signout") {
    mutateAuthenticated(req, (_state, current) => revokeDevice(current.device));
    return send(res, 200, { ok: true });
  }

  // Device tokens are registered only through the authenticated device session.
  if (parts[1] === "notifications") {
    if (method === "GET" && parts.length === 2) return send(res, 200, { preferences: preferences(user), registered: !!device.push, deviceId: device.id });
    if (["PUT", "PATCH", "POST"].includes(method)) {
      const body = await readBody(req);
      const result = mutateAuthenticated(req, (state, current) => {
        if (method === "PUT" && parts.length === 2) updatePushRegistration(state, current.device, body);
        else if (method === "PATCH" && parts.length === 2) updatePreferences(current.user, body);
        else if (method === "POST" && parts[2] === "presence") {
          const conversation = typeof body.conversation === "string" && /^(ch|dm|cht)_[A-Za-z0-9_-]+$/.test(body.conversation) ? body.conversation : null;
          current.device.pushPresence = { conversation, until: body.active === true ? now() + 75000 : 0 };
        } else throw requestError(404, "not_found", "Not found");
        return { preferences: preferences(current.user), registered: !!current.device.push, deviceId: current.device.id };
      });
      return send(res, 200, result);
    }
    return fail(res, 404, "not_found", "Not found");
  }

  // ----- owner-only admin -----
  if (parts[1] === "invites" || parts[1] === "devices") {
    if (user.role !== "owner") return fail(res, 403, "forbidden", "Only the owner can do that");
    if (method === "POST" && parts[1] === "invites" && parts.length === 2) {
      const body = await readBody(req);
      const { code, expiresAt } = mutateAuthenticated(req, state => makeJoinLink(state, { fresh: body.fresh === true }), true);
      return send(res, 200, { code, link: pairLink(code, cfg), expiresAt });
    }
    if (method === "GET" && parts[1] === "devices" && parts.length === 2) {
      const list = Object.values(state.devices)
        .filter((d) => !d.revokedAt)
        .map((d) => ({ id: d.id, label: d.label, lastSeenAt: d.lastSeenAt, user: state.users[d.userId] && { name: state.users[d.userId].name, role: state.users[d.userId].role } }));
      return send(res, 200, { devices: list });
    }
    if (method === "DELETE" && parts[1] === "devices" && parts.length === 3) {
      mutateAuthenticated(req, state => {
        const d = Object.values(state.devices).find((x) => x.id === parts[2]);
        if (!d) throw requestError(404, "not_found", "No such device");
        revokeDevice(d);
      }, true);
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, "not_found", "Not found");
  }

  // ----- channels, direct messages, threads -----
  if (method === "GET" && parts[1] === "attachments" && parts.length === 3 && parts[2].startsWith("chatfile_")) {
    const a = chatMediaStore().attachment(parts[2]);
    const state = readState();
    const current = requireAuth(req, state).user;
    const chat = a && state.chats[a.chat_id];
    if (!chat || chat.deletedAt || chat.userId !== current.id) return fail(res, 404, "not_found", "That attachment is unavailable");
    return send(res, 200, { data: Buffer.from(a.data).toString("base64") });
  }
  if (messaging && (await messaging.handle(req, res, { user, method, parts, url, send, fail, readBody: readAuthorizedBody, cors: CORS,
    isAuthorized: () => authenticate(req, readState())?.user.id === user.id,
  }))) return undefined;

  // ----- chats with the agent -----
  if (parts[1] !== "chats") return fail(res, 404, "not_found", "Not found");
  const up = upstreamFor(user, cfg);
  if (!up) return fail(res, 503, "agent_unavailable", "The agent isn't set up on this server yet");
  const currentState = readState();
  requireAuth(req, currentState);
  const mine = Object.values(currentState.chats).filter((c) => c.userId === user.id && !c.deletedAt);

  if (method === "GET" && parts.length === 2) {
    return send(res, 200, { chats: mine.sort((a, b) => b.updatedAt - a.updatedAt).map(chat => ({ ...chatView(chat), latestTurn: agentTurns.latest(chat.id)[0] || null })) });
  }

  if (method === "POST" && parts.length === 2) {
    const body = await readAuthorizedBody(req);
    const creator = requireAuth(req).user;
    const creationUp = upstreamFor(creator, cfg);
    if (!creationUp) return fail(res, 503, "agent_unavailable", "The agent isn't set up on this server yet");
    if (agentRole(creator.role, cfg) !== "owner") await verifyMemberUpstream(creationUp);
    const chatId = id("cht");
    const hermesSessionId = `servant_${creator.id}_${chatId}`;
    const r = await hermes(creationUp, "POST", "/api/sessions", { id: hermesSessionId, title: `Servant · ${creator.name} · ${chatId.slice(-6)}` });
    if (!r.ok) return fail(res, 502, "agent_error", `The agent didn't start a chat (${r.status})`);
    const chat = {
      id: chatId,
      userId: creator.id,
      role: creator.role,
      hermesSessionId,
      title: String(body.title || "New chat").slice(0, 80),
      createdAt: now(),
      updatedAt: now(),
    };
    try {
      mutateAuthenticated(req, (state, current) => {
        if (current.user.role !== creator.role || current.user.id !== creator.id) throw requestError(403, "forbidden", "Your access changed. Start a new chat");
        state.chats[chatId] = chat;
      });
    } catch (error) {
      // The upstream call ran outside the transaction. Do not retain an orphan
      // session if the device was revoked while that call was pending.
      void hermes(creationUp, "DELETE", `/api/sessions/${encodeURIComponent(hermesSessionId)}`).catch(() => {});
      throw error;
    }
    return send(res, 201, { chat: chatView(chat) });
  }

  const chat = mine.find((c) => c.id === parts[2]);
  if (!chat) return fail(res, 404, "not_found", "No such chat");
  // A member promoted to owner (or the reverse) keeps old chats on the old agent.
  const chatUp = cfg.upstreams[agentRole(chat.role, cfg)];

  if (method === "DELETE" && parts.length === 3) {
    mutateAuthenticated(req, (state, current) => { requireChat(state, current.user.id, chat.id).deletedAt = now(); });
    chatMediaStore().deleteChat(chat.id);
    hermes(chatUp, "DELETE", `/api/sessions/${encodeURIComponent(chat.hermesSessionId)}`).catch(() => {});
    return send(res, 200, { ok: true });
  }

  let upstreamUnavailable = false;
  const syncChatHistory = async (allowOffline = false) => {
    const cached = () => {
      const latest = readState();
      requireChat(latest, requireAuth(req, latest).user.id, chat.id);
      upstreamUnavailable = true;
      return chatMediaStore().history(chat.id);
    };
    if (agentRole(chat.role, cfg) !== "owner") {
      try { await verifyMemberUpstream(chatUp); }
      catch (error) { if (allowOffline) return cached(); throw error; }
    }
    const generation = chatMediaStore().beginSync(chat.id);
    let r;
    try { r = await hermes(chatUp, "GET", `/api/sessions/${encodeURIComponent(chat.hermesSessionId)}/messages`, undefined, {}, AbortSignal.timeout(8000)); }
    catch (error) { if (!allowOffline) throw error; }
    if (allowOffline && (!r || r.status >= 500)) {
      return cached();
    }
    if (!r.ok) throw requestError(502, "agent_error", `Couldn't load messages (${r.status})`);
    const data = await r.json();
    const latest = readState();
    requireChat(latest, requireAuth(req, latest).user.id, chat.id);
    const messages = data.messages ?? data.data;
    if (!Array.isArray(messages)) throw requestError(502, "agent_error", "The agent returned invalid message history");
    return chatMediaStore().sync(chat.id, messages, generation);
  };

  if (method === "GET" && parts[3] === "messages" && parts.length === 4) {
    const messages = await syncChatHistory(true);
    const latestTurn = agentTurns.latest(chat.id)[0] || null;
    for (const turn of agentTurns.drafts(chat.id)) messages.push({
      id: `draft_${turn.id}`, role: "assistant", text: turn.assistantText, at: turn.updatedAt,
      attachments: [], pending: !terminalTurn(turn), interrupted: terminalTurn(turn), turnId: turn.id,
    });
    messages.sort((a, b) => a.at - b.at);
    return send(res, 200, { messages, latestTurn, upstreamUnavailable });
  }

  if (method === "GET" && parts[3] === "media" && parts.length === 4) {
    await syncChatHistory(true);
    const sender = { id: user.id, name: user.name };
    return send(res, 200, mediaPage(chatMediaStore().media(chat.id, sender, cfg.agentName || "Agent"), url.searchParams));
  }

  const ownTurn = turnId => {
    const latest = readState();
    const current = requireAuth(req, latest);
    requireChat(latest, current.user.id, chat.id);
    if (!agentTurns.owns(turnId, chat.id, current.user.id)) throw requestError(404, "not_found", "No such turn");
    return current;
  };
  if (parts[3] === "turns") {
    if (method === "GET" && parts.length === 4) return send(res, 200, { turns: agentTurns.latest(chat.id) });
    const current = ownTurn(parts[4]);
    if (method === "GET" && parts[5] === "events" && parts.length === 6) {
      const after = Number(url.searchParams.get("after") || 0);
      if (!Number.isSafeInteger(after) || after < 0) return fail(res, 400, "cursor", "Invalid event cursor");
      return streamPrivateTurn(req, res, parts[4], () => ownTurn(parts[4]), after);
    }
    if (method === "POST" && parts[5] === "stop" && parts.length === 6) {
      await readAuthorizedBody(req);
      ownTurn(parts[4]);
      return send(res, 200, { turn: agentTurns.requestStop(parts[4]) });
    }
    if (method === "POST" && parts[5] === "approval" && parts.length === 6) {
      const body = await readAuthorizedBody(req);
      const actor = ownTurn(parts[4]);
      // ownTurn already proves this is the caller's own turn in their own chat.
      if (agentRole(chat.role, cfg) !== "owner") return fail(res, 403, "forbidden", "Only the owner can approve this action");
      return send(res, 200, { turn: agentTurns.requestApproval(parts[4], body.approvalId, body.choice) });
    }
  }

  if (method === "POST" && parts[3] === "messages" && parts.length === 4) {
    const body = await readAuthorizedBody(req, MAX_UPLOAD_BODY);
    const text = String(body.text || "").trim();
    const attachments = validateUploads(body.attachments, { mediaOnly: true });
    if (!text && !attachments.length) return fail(res, 400, "empty", "Type a message first");
    if (text.length > MAX_MESSAGE_CHARS) return fail(res, 413, "too_long", "That message is too long");
    const prior = agentTurns.replay({ chat, text, attachments, requestId: body.requestId });
    if (prior) return streamPrivateTurn(req, res, prior.id, () => ownTurn(prior.id));
    // Establish history before the worker records new accepted deliveries.
    await syncChatHistory();
    const turn = mutateAuthenticated(req, (state, current) => {
      const active = requireChat(state, current.user.id, chat.id);
      const queued = agentTurns.enqueue({ chat: active, user: current.user, device: current.device, text, attachments, requestId: body.requestId });
      if (active.title === "New chat") active.title = (text || attachments[0].name).replace(/\s+/g, " ").slice(0, 60);
      active.updatedAt = now();
      return queued;
    });
    if (privateTimer) void agentTurns.processNext();
    return streamPrivateTurn(req, res, turn.id, () => {
      // An already-open stream may finish after its chat is deleted. It never
      // makes deleted attachments downloadable or opens a new subscription.
      const latest = readState();
      const current = requireAuth(req, latest);
      if (latest.chats[chat.id]?.userId !== current.user.id) throw requestError(404, "not_found", "No such chat");
    });
  }

  return fail(res, 404, "not_found", "Not found");
}

function streamPrivateTurn(req, res, turnId, authorize, after = 0) {
  authorize();
  res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
  return new Promise(resolve => {
    let closed = false, poll, keepalive;
    const close = () => {
      if (closed) return;
      closed = true; clearInterval(poll); clearInterval(keepalive);
      privateStreams.delete(close);
      res.end(); resolve();
    };
    privateStreams.add(close);
    res.once("close", close);
    const flush = () => {
      if (closed) return;
      try {
        authorize();
        const events = agentTurns.events(turnId, after);
        for (const event of events) {
          res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.payload)}\nid: ${event.seq}\n\n`);
          after = event.seq;
          if (event.event === "done") { close(); break; }
        }
        if (!events.length && terminalTurn(agentTurns.get(turnId))) close();
      } catch { close(); }
    };
    poll = setInterval(flush, 100);
    keepalive = setInterval(() => { if (!closed) res.write(": keepalive\n\n"); }, 15000);
    flush();
  });
}

async function executePrivateTurn(turn, hooks, cfg) {
  const initial = readState();
  const user = initial.users[turn.user_id];
  const device = Object.values(initial.devices).find(d => d.id === turn.device_id && d.userId === turn.user_id && !d.revokedAt);
  const chat = requireChat(initial, turn.user_id, turn.chat_id);
  if (!user || !device || (chat.role === "owner" && user.role !== "owner")) throw requestError(403, "forbidden", "Access changed before this turn started");
  const up = upstreamFor({ role: turn.role }, cfg);
  if (!up) throw requestError(502, "agent_error", "The agent is unavailable");
  const full = agentRole(turn.role, cfg) === "owner";
  if (!full) await verifyMemberUpstream(up);
  const input = hermesInput(turn.text, turn.attachments);
  let assistantMessage;
  const saveAssistant = content => {
    if (assistantMessage) return;
    const latest = readState();
    const active = latest.chats[turn.chat_id];
    if (!active || active.userId !== turn.user_id) throw requestError(404, "not_found", "That chat is gone");
    const normalized = normalizeMediaContent(content);
    assistantMessage = active.deletedAt
      ? { id: id("msg"), role: "assistant", text: normalized.text, at: now(), attachments: [] }
      : chatMediaStore().accept(turn.chat_id, "assistant", normalized.text, normalized.attachments, turn.id);
    hooks.emit("message", assistantMessage);
  };
  const onAccepted = () => {
    const latest = readState();
    requireChat(latest, turn.user_id, turn.chat_id);
    if (!Object.values(latest.devices).some(d => d.id === turn.device_id && d.userId === turn.user_id && !d.revokedAt)) throw requestError(401, "unauthorized", "Device removed");
    const message = chatMediaStore().accept(turn.chat_id, "user", turn.text, turn.attachments, turn.id);
    chatMediaStore().identifyInput(message.id, input);
    hooks.emit("sent", { message });
  };
  const onEvent = (name, payload) => {
    if (name === "assistant.delta") hooks.emit("delta", { text: payload.delta || "" });
    else if (name === "tool.started") hooks.emit("status", { text: full && payload.tool_name ? `Using ${payload.tool_name}` : "Working" });
    else if (name === "assistant.completed") saveAssistant(payload.content || "");
    else if (name === "run.completed") {
      const source = (Array.isArray(payload.messages) ? payload.messages : []).findLast(m => m.role === "assistant" && (m.content || m.text));
      if (assistantMessage && source) chatMediaStore().identify(assistantMessage.id, source.content ?? source.text);
    } else if (name === "approval.request") {
      if (!full) throw requestError(403, "forbidden", "Member agents cannot request privileged approvals");
      hooks.emit("approval", { approval: { id: payload.approval_id, command: String(payload.command || "").slice(0, 8000),
        description: String(payload.description || payload.reason || "Allow this action on your Mac?").slice(0, 2000), choices: ["once", "deny"] } });
    } else if (name === "approval.responded") {
      const current = hooks.controls().approval;
      if (current && (!payload.approvalId || current.id === payload.approvalId)) hooks.emit("approval_resolved", { approvalId: current.id });
    } else if (name === "error") hooks.emit("error", { message: "The agent hit a problem. Try again" });
  };
  let result;
  if (turn.run_id || await supportsDurableRuns(up)) {
    if (turn.run_id && !turn.accepted) onAccepted();
    result = await runDurableHermes({ up, sessionId: turn.session_id, input, sessionKey: sessionKey(user), runId: turn.run_id,
      onAccepted, onEvent, checkpoint: hooks.checkpoint, controls: hooks.controls });
    // Run output is resolved by the bridge, while history contains its original
    // MEDIA source. Bind the cache record to that source for later galleries.
    if (assistantMessage) {
      try {
        const response = await hermes(up, "GET", `/api/sessions/${encodeURIComponent(turn.session_id)}/messages`);
        const history = response.ok ? await response.json() : {};
        onEvent("run.completed", { messages: history.messages ?? history.data });
      } catch { /* accepted local media remains available even if history lags */ }
    }
  } else {
    const answer = await streamTurn(up, turn.session_id, input, sessionKey(user), onEvent, () => false, onAccepted);
    if (!assistantMessage && answer) saveAssistant(answer);
    result = { status: "completed" };
  }
  mutateState(state => { const current = state.chats[turn.chat_id]; if (current && !current.deletedAt) current.updatedAt = now(); });
  return { status: result.status, notification: assistantMessage && (assistantMessage.text || assistantMessage.attachments.length) ? {
    kind: "agent", eventId: turn.id, chatId: turn.chat_id, userId: turn.user_id,
    text: assistantMessage.text || (assistantMessage.attachments.some(a => a.mime.startsWith("video/")) ? "Sent a video" : "Sent an image"),
  } : undefined };
}

// Runs in a separate worker so deploying/restarting the API cannot lose a report.
export async function runFeedback(report) {
  const up = upstreamFor({ role: "owner" }, loadConfig());
  if (!up) throw new Error("Development agent unavailable");
  const sid = `servant_feedback_${report.id}`;
  const made = await hermes(up, "POST", "/api/sessions", { id: sid, title: `Servant feedback ${report.id}` });
  if (!made.ok && made.status !== 409) throw new Error("Could not create feedback session");
  return feedbackResult(await streamTurn(up, sid, feedbackPrompt(report), "servant:development-feedback", () => {}));
}

function createServices(fixedCfg, { externalWorker = false, autoDrain = true } = {}) {
  process.umask(0o077); // messages.db and its WAL files are private to this user
  store();
  let servicePush;
  const serviceMessaging = createMessaging({
    file: path.join(DATA_DIR, "messages.db"),
    externalWorker,
    users: () => readState().users,
    onMessage: event => servicePush.enqueue(event),
    agentName: () => (fixedCfg || loadConfig()).agentName || "Agent",
    // Channels use the same agent as private chats: full access unless the
    // server is set to "agentAccess": "limited".
    askAgent: async ({ sessionId, sessionKey: key, fresh, text, restartText, attachments, onDelta }) => {
      const cfg = fixedCfg || loadConfig();
      const up = upstreamFor({ role: "member" }, cfg);
      if (!up) return "The agent isn't set up on this server yet";
      if (!fullAgentAccess(cfg)) await verifyMemberUpstream(up);
      let create = fresh;
      if (!fresh) {
        // Threads started on the other agent (before an access change) have
        // no session here. Recreate it and send the whole thread instead.
        const existing = await hermes(up, "GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
        if (existing.status === 404) { create = true; if (restartText) text = restartText; }
      }
      if (create) {
        const made = await hermes(up, "POST", "/api/sessions", { id: sessionId, title: `Servant · ${sessionId.slice(8, 30)}` });
        if (!made.ok && made.status !== 409) throw new Error(`session ${made.status}`);
      }
      const answer = await streamTurn(up, sessionId, hermesInput(text, attachments), key, (name, p) => {
        if (name === "assistant.delta") onDelta(p.delta || "");
      });
      return normalizeMediaContent(answer);
    },
  });
  const serviceTurns = createAgentTurns({ file: path.join(DATA_DIR, "agent-turns.db"),
    execute: (turn, hooks) => executePrivateTurn(turn, hooks, fixedCfg || loadConfig()) });
  servicePush = createPushService({
    file: path.join(DATA_DIR, "push.db"),
    autoDrain,
    state: readState,
    mutate: mutateState,
    resolve: (event, user) => {
      if (event.kind === "message") return serviceMessaging.notificationFor(event.messageId, user);
      const chat = readState().chats[event.chatId];
      if (event.userId !== user.id || !chat || chat.deletedAt || chat.userId !== user.id) return null;
      return { kind: "agent", chatId: chat.id, title: "Agent · " + chat.title, body: event.text };
    },
    send: createPushTransport(() => loadJson(process.env.SERVANT_PUSH_CONFIG || path.join(os.homedir(), ".config/servant/push.json"), {})),
  });
  return { messaging: serviceMessaging, push: servicePush, agentTurns: serviceTurns,
    closeState: () => { chatMedia?.close(); chatMedia = null; stateStore?.close(); stateStore = null; } };
}

export function createWorkerServices() {
  return createServices(undefined, { externalWorker: true, autoDrain: false });
}

export function startServer(fixedCfg) {
  // Config is re-read per request so discovery changes require no restart.
  const cfg = fixedCfg || loadConfig();
  const externalWorker = process.env.SERVANT_WORKER_MODE === "external";
  if (!messaging) ({ messaging, push, agentTurns } = createServices(fixedCfg, { externalWorker, autoDrain: !externalWorker }));
  if (!externalWorker && !privateTimer) {
    agentTurns.recoverInterrupted();
    privateTimer = setInterval(() => {
      void agentTurns.processNext();
      agentTurns.drainOutbox(event => push.enqueue(event));
    }, 250);
  }
  secureTransport ??= createSecureTransport(DATA_DIR);
  feedback ??= createFeedback({ file: path.join(DATA_DIR, "feedback.db"), interval: 0, recover: false });
  messaging.ensureGeneral();
  for (const uid of Object.keys(readState().users)) messaging.joinDefaults(uid);
  let draining = false;
  const requests = new Set();
  const server = http.createServer((req, res) => {
    const pathname = req.url.split("?")[0];
    if (req.method === "GET" && pathname === "/ready") {
      return send(res, draining ? 503 : 200, {
        ok: !draining, release: process.env.SERVANT_RELEASE_ID || "development", deploymentProtocol: 1,
      });
    }
    if (draining && !(req.method === "GET" && pathname === "/health")) {
      res.setHeader("Connection", "close");
      res.setHeader("Retry-After", "1");
      return fail(res, 503, "draining", "Server restarting. Try again shortly");
    }
    // A disconnected client can still have an agent turn running upstream.
    // Track the handler, not just the lifetime of its HTTP response.
    const task = handle(req, res, fixedCfg || loadConfig()).catch((err) => {
      if (res.headersSent) return res.end();
      const status = err.status || 500;
      if (status === 500) console.error("[servant]", err);
      fail(res, status, status === 500 ? "server_error" : err.code || "bad_request", status === 500 ? "Something went wrong on the server" : err.message);
    });
    requests.add(task);
    const settled = () => requests.delete(task);
    task.then(settled, settled);
  });
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    while (requests.size) await Promise.allSettled([...requests]);
    clearInterval(privateTimer); privateTimer = null;
    await agentTurns?.whenIdle();
    agentTurns?.drainOutbox(event => push.enqueue(event));
    await messaging?.whenIdle();
    await push?.shutdown();
    push = null;
    feedback?.close(); feedback = null;
    messaging?.close(); messaging = null;
    agentTurns?.close(); agentTurns = null;
    chatMedia?.close(); chatMedia = null;
    secureTransport?.close(); secureTransport = null;
    stateStore?.close(); stateStore = null;
  })();
  server.on("close", () => { void cleanup().catch(err => console.error("[servant] shutdown cleanup failed", err)); });
  // Kept separate from shutdown so a future proxy can withdraw readiness first.
  // This does not make overlapping API processes safe against the same data.
  server.drain = () => {
    draining = true;
    messaging?.closeEvents();
    if (externalWorker) for (const close of [...privateStreams]) close();
  };
  // The proxy first retires persistent event streams while allowing requests
  // already assigned to this version to reach the still-open listener.
  server.drainEvents = () => { messaging?.closeEvents(); if (externalWorker) for (const close of [...privateStreams]) close(); };
  let shutdownPromise;
  server.shutdown = ({ timeoutMs = 300000 } = {}) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("Invalid shutdown timeout");
    if (shutdownPromise) return shutdownPromise;
    server.drain();
    shutdownPromise = (async () => {
      let timer;
      try {
        const finished = new Promise((resolve, reject) => {
          server.close(err => err ? reject(err) : resolve());
        }).then(cleanup).then(() => true);
        if (timeoutMs === 0) return await finished;
        return await Promise.race([
          finished,
          new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    })();
    return shutdownPromise;
  };
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
  } else if (cmd === "release") {
    const [build, file] = process.argv.slice(3);
    if (!build || !file) {
      console.error("usage: server.mjs release <build> <notes.md>");
      process.exit(2);
    }
    // The stable ingress deliberately blocks administrative routes. Discover
    // the private active API port through the operator-only control socket.
    const defaultRuntime = path.join(os.homedir(), ".local/share/servant");
    const runtimeDir = process.env.SERVANT_RUNTIME_DIR ??
      (fs.existsSync(path.join(defaultRuntime, "control.sock")) ? defaultRuntime : null);
    let adminPort = loadConfig().port;
    if (runtimeDir !== null) {
      try {
        if (!runtimeDir.trim()) throw new Error("SERVANT_RUNTIME_DIR must be a directory");
        const { controlRequest } = await import("./deploy.mjs");
        const status = await controlRequest(runtimeDir, "/status");
        if (status.stopping || !status.active?.ready || !Number.isInteger(status.active.port) ||
            status.active.port < 1 || status.active.port > 65535) throw new Error("No active API is ready");
        adminPort = status.active.port;
      } catch (error) {
        console.error(`Couldn't locate the active API: ${error.message}`);
        process.exit(1);
      }
    }
    const raw = loadJson(CONFIG_FILE, {});
    if (!raw.adminKey) saveJson(CONFIG_FILE, { ...raw, adminKey: crypto.randomBytes(24).toString("base64url") });
    const cfg = loadConfig();
    const r = await fetch(`http://127.0.0.1:${adminPort}/admin/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Servant-Admin": cfg.adminKey },
      body: JSON.stringify({ build, notes: fs.readFileSync(file, "utf8") }),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`Couldn't post the notes (${r.status}): ${data.error?.message || "server not running?"}`);
      process.exit(1);
    }
    console.log(`${data.release.updated ? "Updated" : "Posted"} build ${build} notes in #whats-new (message ${data.release.messageId})`);
  } else if (cmd === "devices") {
    const state = readState();
    for (const d of Object.values(state.devices).filter((x) => !x.revokedAt)) {
      const u = state.users[d.userId] || {};
      console.log(`${d.id}  ${u.role || "?"}  ${u.name || "?"}  ${d.label}  last seen ${new Date(d.lastSeenAt).toISOString()}`);
    }
  } else if (cmd === "revoke") {
    const revoked = mutateState(state => {
      const d = Object.values(state.devices).find((x) => x.id === process.argv[3]);
      if (d) revokeDevice(d);
      return d?.id;
    });
    if (!revoked) {
      console.error("No such device");
      process.exit(1);
    }
    console.log(`Revoked ${revoked}`);
  } else {
    const timeoutMs = Number(process.env.SERVANT_SHUTDOWN_TIMEOUT_MS ?? 300000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("Invalid SERVANT_SHUTDOWN_TIMEOUT_MS");
    const cfg = loadConfig();
    const server = await startServer();
    process.on("message", message => { if (message?.type === "drain-events") server.drainEvents(); });
    let stopping = false;
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log("[servant] draining requests and agent work");
      server.shutdown({ timeoutMs }).then(finished => {
        if (!finished) console.error("[servant] shutdown deadline exceeded; unfinished work may be interrupted");
        process.exit(finished ? 0 : 1);
      }).catch(err => {
        console.error("[servant] shutdown failed", err);
        process.exit(1);
      });
    });
    const { port } = server.address();
    console.log(`[servant] server listening on http://${cfg.host}:${port}`);
    for (const [role, up] of Object.entries(cfg.upstreams)) {
      console.log(`[servant] ${role} agent: ${up.url}${up.key ? "" : " (no key set)"}`);
    }
  }
}
