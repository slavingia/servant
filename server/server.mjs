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
//   node server/server.mjs people | remove-person <name or id>   list people / remove someone who left
//   node server/server.mjs release <build> <notes.md>   post a build's notes to #whats-new

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMessaging } from "./messaging.mjs";
import { createOta } from "./ota.mjs";
import { createRecordings } from "./recordings.mjs";
import { createMeetings, NOTES_PROMPT as MEETING_NOTES_PROMPT } from "./meetings.mjs";
import os from "node:os";
import { createFeedback, feedbackPrompt, feedbackResult } from "./feedback.mjs";
import { createPushService, preferences, previewText, updatePushRegistration, updateVoipRegistration, updatePreferences } from "./push.mjs";
import { createPushTransport } from "./push-transport.mjs";
import { createSecureTransport, serverIdentity } from "./secure-transport.mjs";
import { createStateStore } from "./state-store.mjs";
import { createDeviceLink, previewDeviceLink, approveDeviceLink, denyDeviceLink, pollDeviceLink } from "./device-links.mjs";
import { privateMessageView } from "./source-device.mjs";
import { createChatMediaStore } from "./chat-media.mjs";
import { createUsageStore, limitMessage } from "./usage.mjs";
import { createAgentTurns, terminalTurn } from "./agent-turns.mjs";
import { supportsDurableRuns, supportsSteer, runDurableHermes } from "./hermes-runs.mjs";
import { MAX_ITEMS, MAX_PEOPLE, MAX_PROJECTS, MAX_RELEASES, VIBE_PROJECT, accessOf, accessibleProjects, cleanDate, cleanDescription, cleanLevel, cleanLogin, cleanName, cleanNotes, cleanPath, cleanReleaseName, cleanRepo, cleanRules, cleanStage, cleanStages, cleanTitle, cleanUrl, cleanWorkflow, createProjectFiles, createProjectStore, expandPath, migrateFolders, needsMigration, newItem, newProject, newRelease, patchCell, projectInstructions, projectPeople, projectSharedWith, projectView, removeAccess, setAccess, validProjectId, vibeFolder, vibePreview } from "./projects.mjs";
import { validTermsAcceptance } from "./terms.mjs";
import { verifyMemberUpstream } from "./member-policy.mjs";
import { composeForward } from "./forward.mjs";
import { stepDetail, THINKING_LINE, toolStatusLine, WRITING_LINE } from "./agent-status.mjs";
import { validateUploads, normalizeMediaContent, hermesInput, mediaPage, createMediaDeltaFilter, MAX_UPLOAD_BODY, TEXT_PART_CHARS } from "./media.mjs";
import { createDocumentStore, DOCUMENT_CHUNK, DOCUMENT_CHUNK_BODY } from "./documents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SERVANT_DATA_DIR || path.join(HERE, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;
// Agent chats take long pastes. Up to INLINE_MESSAGE_CHARS travel inline on
// durable runs. Longer ones are saved beside the server data and the
// agent reads them from the file, so the message never overflows its context.
const MAX_MESSAGE_CHARS = 5_000_000;
const INLINE_MESSAGE_CHARS = 100_000;
const LONG_MESSAGE_PREVIEW_CHARS = 4000;
const LONG_MESSAGE_DIR = path.join(DATA_DIR, "long-messages");
// Files the full agent works on (ZIPs, PDFs, prototypes): saved beside the
// server data so it can open, unpack, run or host them with its own tools.
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

export function agentText(turn, full, inlineLimit = INLINE_MESSAGE_CHARS) {
  const text = String(turn.text || "");
  if (!full || text.length <= inlineLimit) return text;
  fs.mkdirSync(LONG_MESSAGE_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(LONG_MESSAGE_DIR, `${turn.chat_id}-${turn.id}.txt`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  const lines = text.split("\n").length;
  return `[Servant: this message is ${text.length.toLocaleString("en-US")} characters (${lines.toLocaleString("en-US")} lines), too long to send in one piece. The whole message is saved at ${file}. Read it in sections with read_file (offset and limit), go through every section, then answer it. Don't tell the person it was too long.]\n\nIt begins:\n${text.slice(0, LONG_MESSAGE_PREVIEW_CHARS)}`;
}

function removeLongMessages(chatId) {
  for (const dir of [LONG_MESSAGE_DIR, UPLOAD_DIR]) {
    try {
      for (const name of fs.readdirSync(dir)) if (name.startsWith(`${chatId}-`)) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
    } catch {}
  }
}

/** Save a turn's non-media files for the full agent and tell it where they are. */
export function agentFiles(turn, full) {
  // Chunk-uploaded documents already live on disk; documentNotice names them.
  const files = (turn.attachments || []).filter(a => !a.file && !/^(image|video)\//.test(a.mime));
  if (!full || !files.length) return "";
  const dir = path.join(UPLOAD_DIR, `${turn.chat_id}-${turn.id}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const used = new Set();
  const saved = files.map(a => {
    let name = path.basename(String(a.name)).replace(/^\.+/, "") || "file";
    for (let n = 2; used.has(name); n++) name = name.replace(/(\.[^.]*)?$/, ext => `-${n}${ext || ""}`);
    used.add(name);
    const file = path.join(dir, name);
    fs.writeFileSync(file, a.data, { mode: 0o600 });
    return `${file} (${a.data.length.toLocaleString("en-US")} bytes)`;
  });
  return `[Servant: the person attached ${saved.length === 1 ? "a file" : `${saved.length} files`}, saved at:\n${saved.join("\n")}\n` +
    "Open them with your tools. Unpack a .zip or other archive into a new folder next to it (never outside that folder) before working on it. " +
    "If it's a prototype or site they want hosted, serve or publish it and reply with the link. Don't mention this note.]";
}


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
    // Where projects live (docs/projects.md). A relative path is inside the data dir.
    projectsFile: path.resolve(DATA_DIR, expandPath(process.env.SERVANT_PROJECTS_FILE || cfg.projectsFile || "projects.json")),
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
// The stable ingress deliberately blocks administrative routes. Discover
// the private active API port through the operator-only control socket.
async function activeAdminPort() {
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
  return adminPort;
}
async function adminPost(route, payload) {
  const adminPort = await activeAdminPort();
  const raw = loadJson(CONFIG_FILE, {});
  if (!raw.adminKey) saveJson(CONFIG_FILE, { ...raw, adminKey: crypto.randomBytes(24).toString("base64url") });
  const cfg = loadConfig();
  const r = await fetch(`http://127.0.0.1:${adminPort}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Servant-Admin": cfg.adminKey },
    body: JSON.stringify(payload),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
  return { r, data: await r.json().catch(() => ({})) };
}

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
// Tests only: edit saved state as an older release would have written it.
export function mutateStateForTest(fn) {
  if (process.env.NODE_ENV === "production") throw new Error("test helper");
  return mutateState(fn);
}

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

// `local` links point at this computer's loopback port, so the Mac app on the
// server's own Mac can join with no tunnel, discovery file or phone.
export function pairLink(code, cfg = loadConfig(), { local = false } = {}) {
  const params = new URLSearchParams({ code });
  params.set("key", serverIdentity(DATA_DIR).publicKey);
  if (local) params.set("server", `http://127.0.0.1:${cfg.port}`);
  else if (cfg.discoveryUrl) params.set("d", cfg.discoveryUrl);
  else if (cfg.publicUrl) params.set("hub", cfg.publicUrl);
  return `servant://pair?${params}`;
}

// One-time invite for the owner: a new device for the existing owner, or the
// first owner account on a fresh server. Lets the server's own computer sign in
// without a phone to scan a QR code.
export function ownerInvite({ name } = {}) {
  const owner = Object.values(readState().users).find(u => u.role === "owner");
  const code = owner ? createInvite({ userId: owner.id }) : createInvite({ name: name || os.userInfo().username, role: "owner" });
  return { code, expiresAt: now() + INVITE_TTL_MS, existing: !!owner };
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
  if (!user || isRemoved(user)) return null;
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
  delete device.voip;
  delete device.ringsCalls;
  delete device.pushPresence;
}
// A removed person keeps their record (name on old messages, their projects and chats) but is
// no longer a member: every device signed out, and they vanish from people, search, mentions
// and new conversations. Everything that asks "who is on this server" goes through this.
const isRemoved = user => !!user?.removedAt;
function activeUsers(state) {
  const all = state.users;
  return Object.values(all).some(isRemoved) ? Object.fromEntries(Object.entries(all).filter(([, u]) => !isRemoved(u))) : all;
}
// Sign a person out everywhere and take them off the server. Returns their name, or null when
// they were already removed. The owner can't be removed, and nobody can remove themselves.
function removePerson(state, targetId) {
  const target = state.users[targetId];
  if (!target) throw requestError(404, "not_found", "No such person");
  if (target.role === "owner") throw requestError(400, "bad_request", "The owner can't be removed");
  if (isRemoved(target)) return null;
  target.removedAt = now();
  for (const d of Object.values(state.devices)) if (d.userId === targetId && !d.revokedAt) revokeDevice(d);
  // Out of every project; projects they owned stay (admins can still edit them).
  projects().mutate(data => { for (const p of data.projects) removeAccess(p, targetId, state.users, data.people); });
  return target.name;
}
// True when this was the person's last active device, i.e. they've left.
function leftServer(state, userId) {
  return !Object.values(state.devices).some((d) => d.userId === userId && !d.revokedAt);
}
function noteIfLeft(left, userId, name) {
  if (!left || !messaging) return;
  try { messaging.noteMemberLeft(userId, name); } catch (e) { console.error("[servant] left note", e); }
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
async function streamTurn(up, sessionId, text, key, onEvent, isClosed = () => false, onAccepted = () => {}, onUsage = () => {}, instructions = "") {
  const r = await hermes(
    up,
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
    { message: text, ...(instructions ? { system_message: instructions } : {}) },
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
      if (name === "run.completed" && payload.usage && typeof payload.usage === "object") onUsage(payload.usage);
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
// One key per chat, so nothing scoped to the key (approvals, memory providers)
// carries from one agent chat into another.
const sessionKey = (user, chatId) => `servant:${user.id}:${chatId}`;

// Agent chats start private, like ChatGPT. Afterwards the person can choose to share
// any one of them with the rest of the server (and stop again); a chat is never
// shared at creation. The owner (admin) can always read every chat. Only the person
// who started a chat can post in it, steer, stop, approve, change sharing or delete it.
// Chats made before this change and already shared stay shared until their author
// stops; chats from before sharing existed (no "shared" field) stay private.
const chatShared = chat => chat.shared === true;
// "Forward" on an agent chat message: post it, with a server-written header,
// into a channel or DM the person is in. Agent chat documents stay on disk
// with the chat and are named instead of copied.
async function forwardChatMessage(req, res, { chat, author, user, device, messageId, cfg, readAuthorizedBody }) {
  const body = await readAuthorizedBody(req);
  if (!messaging) return fail(res, 404, "not_found", "Messages aren't set up on this server");
  const source = chatMediaStore().forwardable(chat.id, messageId);
  if (!source || !source.text && !source.files.length) return fail(res, 404, "not_found", "That message is unavailable");
  const { text, attachments } = composeForward({ text: String(body.text || "").trim(), attachments: [] }, {
    author: source.role === "assistant" ? cfg.agentName || "Agent" : author?.name || "Former member",
    where: "an agent chat", at: source.at, text: source.text, files: source.files,
  }, { skippedNote: name => `> [Attachment: ${name}]` });
  return send(res, 201, messaging.forwardInto(body.conversationId, user, text, attachments, device));
}

function canReadChat(chat, viewer) {
  return !!chat && !chat.deletedAt && !!viewer && (chat.userId === viewer.id || viewer.role === "owner" || chatShared(chat) || projectSharedWith(projects().read(), readState().users, chat, viewer));
}
// A chat shows in lists only once someone has sent something in it. Tapping
// New chat and backing out leaves nothing behind in the list.
function chatStarted(chat, latestTurn) {
  return !!chat.startedAt || chat.title !== "New chat" || !!latestTurn;
}
// The line under a chat's title in the list, like the last message in a DM.
// A turn still in flight is newer than anything mirrored; otherwise the
// mirrored history holds the finished reply (or the user's last message).
const PREVIEW_CHARS = 140;
function chatLastMessage(latestTurn, mirrored) {
  const pick = (role, text, at, attachments = 0, pending = false) => {
    const flat = previewText(text, PREVIEW_CHARS);
    if (!flat && !attachments && !pending) return null;
    return { role, text: flat, at, attachments, ...(pending ? { pending: true } : {}) };
  };
  if (latestTurn && !terminalTurn(latestTurn) && latestTurn.status !== "steered") {
    if (latestTurn.status === "queued") return pick("user", latestTurn.text, latestTurn.createdAt);
    return latestTurn.assistantText ? pick("assistant", latestTurn.assistantText, latestTurn.updatedAt, 0, true) : pick("user", latestTurn.text, latestTurn.createdAt);
  }
  if (mirrored) return pick(mirrored.role, mirrored.text, mirrored.at, mirrored.attachments?.length || 0);
  if (latestTurn) return latestTurn.assistantText ? pick("assistant", latestTurn.assistantText, latestTurn.updatedAt) : pick("user", latestTurn.text, latestTurn.createdAt);
  return null;
}
function chatView(chat, viewer, users = {}) {
  const view = { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, shared: chatShared(chat),
    // The full agent takes any file (ZIPs, PDFs, prototypes); others take media.
    ...(agentRole(chat.role, loadConfig()) === "owner" ? { files: true } : {}),
    // folderId/folderShared repeat projectId/projectShared for app builds from before projects.
    ...(chat.projectId ? { projectId: chat.projectId, folderId: chat.projectId, project: { id: chat.projectId, name: projects().byId(chat.projectId)?.name || chat.projectId },
      ...(chat.projectShared ? { projectShared: true, folderShared: true } : {}) } : {}),
    ...(chat.mode === "vibe" ? { mode: "vibe", previewUrl: vibePreview(vibeProject(), chat) } : {}) };
  try { const u = usageStore().chatTotals(chat.id); if (u.turns) view.usage = u; } catch { /* stats never block a chat */ }
  if (viewer && chat.userId === viewer.id) {
    view.archived = !!chat.archivedAt;
  }
  if (viewer && chat.userId !== viewer.id) {
    const author = users[chat.userId];
    view.author = { id: chat.userId, name: author?.name || "Former member" };
    view.readOnly = true;
  }
  return view;
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
let documentStore;
let projectFileStore;
const projectFiles = () => projectFileStore ??= createProjectFiles(path.join(DATA_DIR, "project-files"));
let projectStore;
const projects = () => projectStore ??= createProjectStore(loadConfig().projectsFile);
const vibeProject = () => projects().byId(VIBE_PROJECT);
// The project with this id, if this person is in it (or is an admin).
function projectFor(user, pid, users = readState().users) {
  const data = projects().read();
  const project = validProjectId(pid) ? data.projects.find(p => p.id === pid) : null;
  return project && accessOf(project, user, users, data.people).visible ? project : null;
}
// Old per-person folders become projects the first time a server with them starts (docs/projects.md).
function migrateProjects() {
  if (!needsMigration(readState())) return;
  mutateState(state => {
    const n = migrateFolders(state, projects(), projectFiles(), path.join(DATA_DIR, "folder-files"));
    if (n) console.log(`[servant] ${n} folder(s) became projects in ${projects().file}`);
  });
}
// The chat's project (repo, workflow, rules, what the asker may do, notes and files), sent with every turn.
function chatContext(chat) {
  const data = projects().read();
  const project = chat.projectId ? data.projects.find(p => p.id === chat.projectId) : null;
  if (!project) return "";
  const users = readState().users;
  const access = accessOf(project, users[chat.userId], users, data.people);
  // Whoever started the chat must still be in the project; otherwise the chat carries no project context.
  if (chat.mode !== "vibe" && !access.visible) return "";
  return projectInstructions(project, { chat, asker: users[chat.userId], level: access.level, files: projectFiles(), full: agentRole(chat.role, loadConfig()) === "owner", users });
}
const documents = () => documentStore ??= createDocumentStore(path.join(DATA_DIR, "chat-files"));
let usageDb;
let meetings = null;
let recordings = null;
let workChatStarter = null;
let otaServer;
const ota = () => otaServer ??= createOta({ dir: path.join(DATA_DIR, "ota") });
const usageStore = () => usageDb ??= createUsageStore(path.join(DATA_DIR, "usage.db"));
const recordUsage = entry => { try { usageStore().record(entry); } catch (error) { console.error("[servant] usage", error.message); } };

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

  // Over-the-air app updates: public, signed, app code only (see ota.mjs).
  if (url.pathname.startsWith("/ota/") && ota().handle(req, res)) return undefined;

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
    if (url.pathname === "/v1/pair" || parts[1] === "device-links" || !legacy || !Number.isSafeInteger(legacy.device.legacyPlaintextUntil) || legacy.device.legacyPlaintextUntil <= now()) {
      return fail(res, 426, "encryption_required", "Update Servant and open a new invite from your admin to enable encryption");
    }
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", new Date(legacy.device.legacyPlaintextUntil).toUTCString());
  }

  if (parts[0] === "v1" && parts[1] === "device-links") {
    if (method === "POST" && parts.length === 2) {
      const body = await readBody(req);
      const link = mutateState(state => createDeviceLink(state, { device: body?.device, ip: clientIp(req) }));
      return send(res, 201, link);
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "poll") {
      const body = await readBody(req);
      const result = mutateState(state => pollDeviceLink(state, parts[2], body?.secret));
      return send(res, 200, result.status === "approved" ? { ...result, server: { name: cfg.name } } : result);
    }
    if (method === "GET" && parts.length === 3) {
      const state = readState();
      requireAuth(req, state);
      return send(res, 200, previewDeviceLink(state, parts[2]));
    }
    if (method === "POST" && parts.length === 4 && ["approve", "deny"].includes(parts[3])) {
      // Consume the request first, then authorize inside the same transaction
      // as approval so revocation while a body is uploading cannot race it.
      requireAuth(req);
      await readBody(req);
      const result = mutateAuthenticated(req, (state, auth) => parts[3] === "approve"
        ? approveDeviceLink(state, parts[2], auth)
        : denyDeviceLink(state, parts[2], auth));
      return send(res, 200, result);
    }
    return fail(res, 404, "not_found", "Not found");
  }

  if (method === "POST" && url.pathname === "/v1/pair") {
    const ip = clientIp(req);
    if (!pairAllowed(ip)) return fail(res, 429, "rate_limited", "Too many tries. Wait ten minutes");
    const body = await readBody(req);
    const { token, user, isNew } = mutateState(state => {
      const key = sha256(normalizeCode(body.code));
      const invite = state.invites[key];
      if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt < now()) {
        pairFailed(ip);
        throw requestError(403, "invalid_invite", "That invite link doesn't work. Ask for a new one");
      }
      const name = invite.reusable ? String(body.name || "").trim().slice(0, 80) : invite.name;
      if (!name) throw requestError(400, "name_required", "Enter your name");
      const terms = validTermsAcceptance(body.terms);
      if (!terms) throw requestError(400, "terms_required", "Agree to the terms to join");
      if (invite.reusable) invite.uses += 1;
      else invite.usedAt = now();
      if (invite.userId && isRemoved(state.users[invite.userId])) throw requestError(403, "invalid_invite", "That invite link doesn't work. Ask for a new one");
      const existing = invite.userId && state.users[invite.userId];
      const user = existing || { id: id("usr"), name, role: invite.role, createdAt: now() };
      const token = crypto.randomBytes(32).toString("base64url");
      const deviceId = id("dev");
      // Every acceptance is kept: who, which version, which checks, when, on which device.
      user.termsAcceptances = [...(user.termsAcceptances || []), { ...terms, acceptedAt: now(), deviceId }];
      state.users[user.id] = user;
      state.devices[sha256(token)] = {
        id: deviceId, userId: user.id, label: String(body.device || "Phone").slice(0, 80),
        createdAt: now(), lastSeenAt: now(),
      };
      return { token, user, isNew: !existing };
    });
    messaging?.joinDefaults(user.id);
    // A new person's first unread: a question from the agent, with quick answers. Never blocks pairing.
    if (isNew) { try { messaging?.welcomeFromAgent(user.id); } catch (error) { console.error("[servant] welcome", error); } }
    return send(res, 201, { token, user: { id: user.id, name: user.name, role: user.role }, server: { name: cfg.name }, hub: { name: cfg.name } });
  }

  // Build scripts on this Mac post release notes. Tunnel traffic always carries
  // cf-connecting-ip, so it can't reach this even with the key.
  const adminAllowed = () => {
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) && !req.headers["cf-connecting-ip"];
    const key = String(req.headers["x-servant-admin"] || "");
    return local && !!cfg.adminKey && key.length === cfg.adminKey.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(cfg.adminKey));
  };
  // `servant remove-person` on this Mac: same as the owner removing them in the app.
  if (method === "POST" && url.pathname === "/admin/people/rename") {
    if (!adminAllowed()) return fail(res, 403, "forbidden", "Not allowed");
    const body = await readBody(req);
    const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name) return fail(res, 400, "name_required", "Enter a name");
    const done = mutateState(state => {
      const target = state.users[String(body.userId || "")];
      if (!target) throw requestError(404, "not_found", "No such person");
      if (Object.values(state.users).some(u => u.id !== target.id && u.name.toLowerCase() === name.toLowerCase())) throw requestError(409, "name_taken", "Someone already uses that name");
      target.name = name;
      return target.id;
    });
    try { messaging?.personChanged(done); } catch (e) { console.error("[servant] person update", e); }
    return send(res, 200, { ok: true, name });
  }
  if (method === "POST" && url.pathname === "/admin/people/remove") {
    if (!adminAllowed()) return fail(res, 403, "forbidden", "Not allowed");
    const body = await readBody(req);
    const name = mutateState(state => removePerson(state, String(body.userId || "")));
    if (name) noteIfLeft(true, String(body.userId), name);
    return send(res, 200, { ok: true, removed: !!name, name });
  }
  if (method === "POST" && url.pathname === "/admin/releases") {
    if (!adminAllowed()) return fail(res, 403, "forbidden", "Not allowed");
    const body = await readBody(req);
    const owner = Object.values(readState().users).find((u) => u.role === "owner");
    if (!owner) return fail(res, 409, "no_owner", "Pair the owner first");
    return send(res, 200, { release: messaging.postRelease({ build: body.build, notes: body.notes, authorId: owner.id }) });
  }

  // Everything below needs a device token.
  if (parts[0] !== "v1") return fail(res, 404, "not_found", `This server has no ${method} ${url.pathname}`);
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
    if (method === "POST" && parts.length === 2) {
      const body = await readAuthorizedBody(req, MAX_UPLOAD_BODY);
      const screenshots = validateUploads(body.attachments || [], { imagesOnly: true });
      if (screenshots.length > 1) return fail(res, 400, "invalid_feedback", "Attach one screenshot");
      return send(res, 202, { report: feedback.submit(user.id, body, screenshots) });
    }
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
    const left = mutateAuthenticated(req, (state, current) => {
      revokeDevice(current.device);
      return leftServer(state, current.user.id) ? current.user.id : null;
    });
    noteIfLeft(!!left, left);
    return send(res, 200, { ok: true });
  }

  // Device tokens are registered only through the authenticated device session.
  if (parts[1] === "notifications") {
    if (method === "GET" && parts.length === 2) return send(res, 200, { preferences: preferences(user), registered: !!device.push, deviceId: device.id });
    if (["PUT", "PATCH", "POST"].includes(method)) {
      const body = await readBody(req);
      const result = mutateAuthenticated(req, (state, current) => {
        if (method === "PUT" && parts.length === 2) updatePushRegistration(state, current.device, body);
        else if (method === "PUT" && parts[2] === "voip" && parts.length === 3) updateVoipRegistration(state, current.device, body);
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
      const left = mutateAuthenticated(req, state => {
        const d = Object.values(state.devices).find((x) => x.id === parts[2]);
        if (!d) throw requestError(404, "not_found", "No such device");
        const wasActive = !d.revokedAt;
        revokeDevice(d);
        return wasActive && leftServer(state, d.userId) ? d.userId : null;
      }, true);
      noteIfLeft(!!left, left);
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
    if (!canReadChat(chat, state.users[current.id] || current)) return fail(res, 404, "not_found", "That attachment is unavailable");
    if (a.file) {
      // Documents download in ranges; one response could never hold 100 MB.
      if (!documents().owns(a.file)) return fail(res, 404, "not_found", "That attachment is unavailable");
      const offset = Number(url.searchParams.get("offset") || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > a.size) return fail(res, 400, "bad_request", "Invalid offset");
      try { return send(res, 200, { data: documents().read(a.file, offset, Math.min(DOCUMENT_CHUNK, a.size - offset)).toString("base64"), offset, size: a.size }); }
      catch { return fail(res, 404, "not_found", "That attachment is unavailable"); }
    }
    return send(res, 200, { data: Buffer.from(a.data).toString("base64") });
  }
  // Projects: shared bodies of work with notes, files, rules and who can read, write
  // or merge (docs/projects.md). App builds from before projects call /v1/folders.
  if (parts[1] === "projects" || parts[1] === "folders") {
    const legacy = parts[1] === "folders";
    const wrap = (one, value) => ({ [legacy ? (one ? "folder" : "folders") : (one ? "project" : "projects")]: value });
    const users = () => readState().users;
    const allChats = () => Object.values(readState().chats);
    const found = (data, pid) => {
      const project = data.projects.find(p => p.id === pid);
      const access = project && accessOf(project, user, users(), data.people);
      if (!access?.visible) throw requestError(404, "not_found", "No such project");
      return { project, access };
    };
    const may = (access, need) => {
      if (need === "edit" && !access.canEdit) throw requestError(403, "forbidden", "Only a project owner can do that");
      if (need === "write" && !access.canWrite) throw requestError(403, "forbidden", "You can read this project but not change it");
    };
    const view = pid => { const data = projects().read(); const { project, access } = found(data, pid); return projectView(project, access, user, users(), data.people, allChats()); };
    // Inside a mutation: the project, if this person may change it this way.
    const within = (data, pid, need) => { const { project, access } = found(data, pid); may(access, need); project.updatedAt = now(); return project; };
    if (method === "GET" && parts.length === 2) {
      const data = projects().read();
      const chats = allChats();
      const list = accessibleProjects(data, user, users()).map(({ project, access }) => projectView(project, access, user, users(), data.people, chats));
      return send(res, 200, { ...wrap(false, list), vibeCoder: !!users()[user.id]?.vibeCoder, vibe: !!vibeProject() });
    }
    if (method === "POST" && parts.length === 2) {
      const body = await readAuthorizedBody(req);
      const pid = projects().mutate(data => {
        if (data.projects.length >= MAX_PROJECTS) throw requestError(409, "limit", `This server holds up to ${MAX_PROJECTS} projects`);
        const project = newProject(body, user.id, new Set(data.projects.map(p => p.id)));
        data.projects.push(project);
        return project.id;
      });
      return send(res, 200, wrap(true, view(pid)));
    }
    if (parts.length >= 3) {
      const pid = parts[2];
      if (method === "GET" && parts.length === 3) {
        const project = view(pid);
        // Teammates' chats appear only when their author shared them with the project.
        const sharedChats = allChats().filter(c => c.projectId === pid && c.userId !== user.id && !c.deletedAt && c.projectShared)
          .sort((a, b) => b.updatedAt - a.updatedAt).map(c => chatView(c, users()[user.id] || user, users()));
        return send(res, 200, { ...wrap(true, project), sharedChats });
      }
      if (method === "PATCH" && parts.length === 3) {
        const body = await readAuthorizedBody(req);
        // Notes are for anyone who can write; the rest is the owners' call.
        const settings = { name: cleanName, description: cleanDescription, repo: cleanRepo, path: cleanPath, pages: cleanUrl, workflow: cleanWorkflow, rules: cleanRules, stages: cleanStages };
        const changing = Object.keys(settings).filter(k => body[k] !== undefined);
        projects().mutate(data => {
          const p = within(data, pid, changing.length ? "edit" : "write");
          for (const k of changing) p[k] = settings[k](body[k]);
          if (body.notes !== undefined) p.notes = cleanNotes(body.notes);
        });
        return send(res, 200, wrap(true, view(pid)));
      }
      if (method === "DELETE" && parts.length === 3) {
        projects().mutate(data => { within(data, pid, "edit"); data.projects = data.projects.filter(p => p.id !== pid); });
        // Everyone's chats stay; they just leave the project.
        mutateAuthenticated(req, state => { for (const c of Object.values(state.chats)) if (c.projectId === pid) { delete c.projectId; delete c.projectShared; } });
        projectFiles().removeProject(pid);
        return send(res, 200, { ok: true });
      }
      // People: a Servant user (userId), a GitHub login (github) or someone already listed (key), with a
      // level and optionally owner true/false. Old builds POST /members with a userId: they can write.
      if (method === "POST" && (parts[3] === "people" || parts[3] === "members") && parts.length === 4) {
        const body = await readAuthorizedBody(req);
        const level = parts[3] === "members" ? "write" : cleanLevel(body.level);
        let key = typeof body.key === "string" ? body.key : "";
        if (!key && body.userId !== undefined) {
          const target = users()[body.userId];
          if (!target || target.revokedAt || isRemoved(target)) throw requestError(404, "not_found", "No such person");
          key = target.id;
        }
        if (!key) key = cleanLogin(body.github);
        projects().mutate(data => {
          const p = within(data, pid, "edit");
          const people = projectPeople(p, users(), data.people);
          if (body.key && !people.some(x => x.key === key)) throw requestError(404, "not_found", "No such person");
          if (people.length >= MAX_PEOPLE && !people.some(x => x.key === key)) throw requestError(409, "limit", `A project holds up to ${MAX_PEOPLE} people`);
          setAccess(p, key, level, typeof body.owner === "boolean" ? body.owner : undefined);
        });
        return send(res, 200, wrap(true, view(pid)));
      }
      // Owners remove anyone; anyone else can only remove themselves (leave).
      if (method === "DELETE" && (parts[3] === "people" || parts[3] === "members") && parts.length === 5) {
        const target = parts[4] === "me" ? user.id : parts[4];
        const leaving = target === user.id;
        projects().mutate(data => {
          const { project, access } = found(data, pid);
          if (!leaving && !access.canEdit) throw requestError(403, "forbidden", "Only a project owner can remove people");
          if (leaving && access.owner && projectPeople(project, users(), data.people).filter(p => p.owner).length === 1) throw requestError(400, "bad_request", "You're the only owner. Add another owner first, or delete the project");
          removeAccess(project, target, users(), data.people);
          project.updatedAt = now();
        });
        // Their chats stay theirs but leave the project and stop being shared with it.
        if (users()[target]) mutateAuthenticated(req, state => { for (const c of Object.values(state.chats)) if (c.userId === target && c.projectId === pid) { delete c.projectId; delete c.projectShared; } });
        return send(res, 200, leaving ? { ok: true } : wrap(true, view(pid)));
      }
      // Releases: the project's dated drops, each a list of items that move through the project's
      // stages (docs/projects.md). Writers add, rename and remove; a stage cell (status, owner, note)
      // is also the business of whoever it is assigned to.
      if (parts[3] === "releases") {
        const body = method === "DELETE" ? {} : await readAuthorizedBody(req);
        const inRelease = p => { const r = p.releases.find(x => x.id === parts[4]); if (!r) throw requestError(404, "not_found", "No such release"); r.updatedAt = now(); return r; };
        const inItem = r => { const i = r.items.find(x => x.id === parts[6]); if (!i) throw requestError(404, "not_found", "No such item"); return i; };
        const items = parts[5] === "items";
        if (method === "POST" && parts.length === 4) projects().mutate(data => {
          const p = within(data, pid, "write");
          if (p.releases.length >= MAX_RELEASES) throw requestError(409, "limit", `A project holds up to ${MAX_RELEASES} releases`);
          p.releases.push(newRelease(body, now()));
        });
        else if (method === "PATCH" && parts.length === 5) projects().mutate(data => {
          const r = inRelease(within(data, pid, "write"));
          if (body.name !== undefined) r.name = cleanReleaseName(body.name);
          if (body.date !== undefined) r.date = cleanDate(body.date);
        });
        else if (method === "DELETE" && parts.length === 5) projects().mutate(data => { const p = within(data, pid, "write"); inRelease(p); p.releases = p.releases.filter(r => r.id !== parts[4]); });
        else if (method === "POST" && items && parts.length === 6) projects().mutate(data => {
          const r = inRelease(within(data, pid, "write"));
          if (r.items.length >= MAX_ITEMS) throw requestError(409, "limit", `A release holds up to ${MAX_ITEMS} items`);
          r.items.push(newItem(body));
        });
        else if (method === "PATCH" && items && parts.length === 7) projects().mutate(data => { inItem(inRelease(within(data, pid, "write"))).title = cleanTitle(body.title); });
        else if (method === "DELETE" && items && parts.length === 7) projects().mutate(data => { const r = inRelease(within(data, pid, "write")); inItem(r); r.items = r.items.filter(i => i.id !== parts[6]); });
        else if (method === "PATCH" && items && parts[7] === "stages" && parts.length === 8) projects().mutate(data => {
          const { project: p, access } = found(data, pid);
          const stage = cleanStage(p, body.stage);
          const item = inItem(inRelease(p));
          if (!access.canWrite && item.stages[stage]?.owner !== user.id) throw requestError(403, "forbidden", "Only the person this is assigned to, or someone who can write, can change it");
          patchCell(p, item, stage, body, users(), data.people);
          p.updatedAt = now();
        });
        else return fail(res, 404, "not_found", "Not found");
        return send(res, 200, wrap(true, view(pid)));
      }
      if (method === "POST" && parts[3] === "files" && parts.length === 4) {
        const body = await readAuthorizedBody(req, MAX_UPLOAD_BODY);
        const bytes = typeof body.data === "string" ? Buffer.from(body.data, "base64") : Buffer.alloc(0);
        const here = found(projects().read(), pid);
        may(here.access, "write");
        const file = projectFiles().add(here.project, body.name, bytes);
        try { projects().mutate(data => { within(data, pid, "write").files.push(file); }); }
        catch (e) { projectFiles().remove(pid, file); throw e; }
        return send(res, 200, wrap(true, view(pid)));
      }
      if (method === "DELETE" && parts[3] === "files" && parts.length === 5) {
        const file = found(projects().read(), pid).project.files.find(f => f.id === parts[4]);
        if (!file) return fail(res, 404, "not_found", "No such file");
        projects().mutate(data => { const p = within(data, pid, "write"); p.files = p.files.filter(x => x.id !== parts[4]); });
        projectFiles().remove(pid, file);
        return send(res, 200, wrap(true, view(pid)));
      }
    }
    return fail(res, 404, "not_found", "Not found");
  }
  // Owners mark people as vibe coders (not programmers).
  // Owner: remove someone who has left the team. Their devices sign out at once.
  if (method === "DELETE" && parts[1] === "people" && parts.length === 3 && parts[2] !== "me") {
    const name = mutateAuthenticated(req, (state, auth) => {
      if (parts[2] === auth.user.id) throw requestError(400, "bad_request", "You can't remove yourself");
      return removePerson(state, parts[2]);
    }, true);
    if (name) noteIfLeft(true, parts[2], name);
    return send(res, 200, { ok: true });
  }
  // Everyone changes their own name. Names stay unique so @mentions and the roster stay clear.
  if (method === "PATCH" && parts[1] === "people" && parts[2] === "me" && parts.length === 3) {
    const body = await readAuthorizedBody(req);
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (!name) return fail(res, 400, "name_required", "Enter a name"), undefined;
    mutateAuthenticated(req, (state, auth) => {
      const clash = Object.values(state.users).find((u) => u.id !== auth.user.id && u.name.toLowerCase() === name.toLowerCase());
      if (clash) throw requestError(409, "name_taken", "Someone already uses that name. Try another");
      state.users[auth.user.id].name = name;
    });
    try { messaging?.personChanged(user.id); } catch (e) { console.error("[servant] person update", e); }
    return send(res, 200, { user: { id: user.id, name, role: user.role } });
  }
  if (method === "PATCH" && parts[1] === "people" && parts.length === 3 && parts[2] !== "me") {
    const body = await readAuthorizedBody(req);
    // Owners only (the `true` below): vibe coder, unlimited agent tokens (no daily cap), and
    // fixing someone's name (a typo at invite time).
    const flags = ["vibeCoder", "unlimitedTokens"].filter(k => k in body);
    const rename = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 40) : null;
    if ((!flags.length && !rename) || flags.some(k => typeof body[k] !== "boolean") || rename === "") return fail(res, 400, "bad_request", "Send a name, or vibeCoder/unlimitedTokens as true or false");
    const person = mutateAuthenticated(req, (state) => {
      const target = state.users[parts[2]];
      if (!target) throw requestError(404, "not_found", "No such person");
      if (rename && Object.values(state.users).some(u => u.id !== target.id && u.name.toLowerCase() === rename.toLowerCase())) throw requestError(409, "name_taken", "Someone already uses that name. Try another");
      if (rename) target.name = rename;
      for (const k of flags) if (body[k]) target[k] = true; else delete target[k];
      return { id: target.id, name: target.name, vibeCoder: !!target.vibeCoder, unlimitedTokens: !!target.unlimitedTokens };
    }, true);
    if (rename) try { messaging?.personChanged(parts[2]); } catch (e) { console.error("[servant] person update", e); }
    return send(res, 200, { person });
  }
  if (!meetings && parts[1] === "meetings") return fail(res, 503, "calls_unavailable", "Calls aren't running on this server right now. Ask your admin to restart it"), undefined;
  if (recordings && parts[1] === "recordings" && (await recordings.handle(req, res, { user, device, method, parts, send, fail, readBody: readAuthorizedBody }))) return undefined;
  if (meetings && parts[1] === "meetings" && (await meetings.handle(req, res, { user, method, parts, send, fail, readBody: readAuthorizedBody }))) return undefined;
  if (messaging && (await messaging.handle(req, res, { user, device, method, parts, url, send, fail, readBody: readAuthorizedBody, cors: CORS,
    isAuthorized: () => authenticate(req, readState())?.user.id === user.id,
  }))) return undefined;

  // ----- token leaderboard (everyone on the server can see it) -----
  if (method === "GET" && parts[1] === "leaderboard" && parts.length === 2) {
    const state = readState();
    requireAuth(req, state);
    const periods = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5, all: Infinity };
    const period = Object.hasOwn(periods, url.searchParams.get("period")) ? url.searchParams.get("period") : "week";
    const since = periods[period] === Infinity ? 0 : now() - periods[period];
    const board = usageStore().leaderboard({ since });
    return send(res, 200, {
      period, since,
      totals: board.totals,
      topics: usageStore().topics({ since }),
      people: board.people.map((row, index) => ({
        rank: index + 1,
        user: { id: row.userId, name: state.users[row.userId]?.name || "Former member" },
        input: row.input, output: row.output, total: row.total, turns: row.turns, chat: row.chat, channel: row.channel,
      })),
    });
  }

  // ----- chats with the agent -----
  if (parts[1] !== "chats") return fail(res, 404, "not_found", "Not found");
  const up = upstreamFor(user, cfg);
  if (!up) return fail(res, 503, "agent_unavailable", "The agent isn't set up on this server yet");
  const currentState = readState();
  requireAuth(req, currentState);
  const mine = Object.values(currentState.chats).filter((c) => c.userId === user.id && !c.deletedAt);

  if (method === "GET" && parts.length === 2) {
    const viewer = currentState.users[user.id] || user;
    const others = url.searchParams.get("scope") === "org"
      ? Object.values(currentState.chats).filter(c => c.userId !== user.id && canReadChat(c, viewer) && (viewer.role === "owner" || chatShared(c)))
      : [];
    // A chat's time is its last activity. The chat record only moves when a
    // message is sent or a turn ends, so a reply that streams for an hour
    // would otherwise keep the send time and sink below quieter chats.
    // It also never shows earlier than the newest message: a message steered
    // into a running reply, or one that waited in the queue, lands in the
    // history without touching the turn or the chat record.
    const withActivity = (chat, view) => {
      const turns = agentTurns.latest(chat.id);
      const latestTurn = turns[0] || null;
      const mirrored = chatMediaStore().last(chat.id);
      const lastMessage = chatLastMessage(latestTurn, mirrored);
      const updatedAt = Math.max(chat.updatedAt || 0, ...turns.map(t => t.updatedAt || 0), mirrored?.at || 0, lastMessage?.at || 0);
      return { ...view, updatedAt, latestTurn, lastMessage };
    };
    const sorted = list => list.sort((a, b) => b.updatedAt - a.updatedAt);
    const unread = agentTurns.unreadByChat(user.id);
    const started = chat => chatStarted(chat, agentTurns.latest(chat.id)[0]);
    return send(res, 200, {
      chats: sorted(mine.filter(started).map(chat => ({ ...withActivity(chat, chatView(chat, viewer)), unread: unread[chat.id] || 0 }))),
      ...(url.searchParams.get("scope") === "org" ? { orgChats: sorted(others.filter(started).map(chat => {
        const { latestTurn, ...view } = withActivity(chat, chatView(chat, viewer, currentState.users));
        return view;
      })) } : {}),
    });
  }

  if (method === "POST" && parts.length === 2) {
    const body = await readAuthorizedBody(req);
    const creator = requireAuth(req).user;
    const creationUp = upstreamFor(creator, cfg);
    if (!creationUp) return fail(res, 503, "agent_unavailable", "The agent isn't set up on this server yet");
    if (agentRole(creator.role, cfg) !== "owner") await verifyMemberUpstream(creationUp);
    const chatId = id("cht");
    // Vibe coders always build prototypes. Anyone else may start the chat in a project
    // they're in, or ask for vibe coding (a prototype with a preview link) from the list.
    const vibe = !!readState().users[creator.id]?.vibeCoder || body.mode === "vibe";
    if (vibe && !vibeProject()) return fail(res, 503, "vibe_unavailable", "Vibe coding isn't set up on this server");
    // Old builds send folderId, or project with ids this server may no longer know.
    const wanted = body.projectId ?? body.folderId ?? (projects().byId(body.project) ? body.project : null);
    if (!vibe && wanted != null && !projectFor(creator, wanted)) return fail(res, 404, "not_found", "No such project");
    const projectId = vibe ? VIBE_PROJECT : wanted;
    const hermesSessionId = `servant_${creator.id}_${chatId}`;
    const r = await hermes(creationUp, "POST", "/api/sessions", { id: hermesSessionId, title: `Servant · ${creator.name} · ${chatId.slice(-6)}` });
    if (!r.ok) return fail(res, 502, "agent_error", `The agent didn't start a chat (${r.status})`);
    const chat = {
      id: chatId,
      userId: creator.id,
      role: creator.role,
      hermesSessionId,
      title: String(body.title || "New chat").slice(0, 80),
      // Always private to start. Sharing with the server or the project is a later choice, per chat.
      shared: false,
      ...(projectId ? { projectId } : {}),
      ...(vibe ? { mode: "vibe", vibeFolder: vibeFolder(chatId) } : {}),
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
    return send(res, 201, { chat: chatView(chat, creator) });
  }

  const viewer = currentState.users[user.id] || user;
  const visible = currentState.chats[parts[2]];
  if (visible && visible.userId !== user.id && canReadChat(visible, viewer)) {
    // Someone else's shared chat (or any chat, for the owner): read only.
    // A shared chat's messages can be forwarded to a channel or DM for feedback.
    if (method === "POST" && parts[3] === "messages" && parts[5] === "forward" && parts.length === 6 && chatShared(visible)) {
      return forwardChatMessage(req, res, { chat: visible, author: currentState.users[visible.userId], user: viewer, device, messageId: parts[4], cfg, readAuthorizedBody });
    }
    if (method !== "GET" || !["messages", "media", undefined].includes(parts[3]) || parts.length > 4) {
      return fail(res, 403, "read_only", "Only the person who started this chat can do that");
    }
    const history = chatMediaStore().history(visible.id);
    if (parts.length === 3) return send(res, 200, { chat: chatView(visible, viewer, currentState.users) });
    if (parts[3] === "media") {
      const author = currentState.users[visible.userId];
      return send(res, 200, mediaPage(chatMediaStore().media(visible.id, { id: visible.userId, name: author?.name || "Former member" }, cfg.agentName || "Agent"), url.searchParams));
    }
    const sources = agentTurns.messageSources(visible.id);
    return send(res, 200, { chat: chatView(visible, viewer, currentState.users), messages: history.map(message => privateMessageView(message, viewer, sources)), latestTurn: null, upstreamUnavailable: false });
  }
  const chat = mine.find((c) => c.id === parts[2]);
  if (!chat) return fail(res, 404, "not_found", "No such chat");

  if (method === "GET" && parts.length === 3) return send(res, 200, { chat: chatView(chat, user) });

  if (method === "PATCH" && parts.length === 3) {
    const body = await readAuthorizedBody(req);
    // Old builds say folderId/folderShared; they mean the project.
    const hasProject = Object.hasOwn(body, "projectId") || Object.hasOwn(body, "folderId");
    const nextProject = Object.hasOwn(body, "projectId") ? body.projectId : body.folderId;
    const hasProjectShared = Object.hasOwn(body, "projectShared") || Object.hasOwn(body, "folderShared");
    const nextShared = Object.hasOwn(body, "projectShared") ? body.projectShared : body.folderShared;
    if (typeof body.shared !== "boolean" && !hasProject && !hasProjectShared) return fail(res, 400, "bad_request", "shared must be true or false");
    if (typeof body.shared !== "boolean" && body.shared !== undefined) return fail(res, 400, "bad_request", "shared must be true or false");
    if (hasProjectShared && typeof nextShared !== "boolean") return fail(res, 400, "bad_request", "projectShared must be true or false");
    if (hasProject && nextProject !== null && !validProjectId(nextProject)) return fail(res, 400, "bad_request", "projectId must be a project or null");
    if (body.shared && chat.privateForward) return fail(res, 409, "forward_private", "This chat includes a message from a private conversation, so it stays private");
    let updated;
    mutateAuthenticated(req, (state, current) => {
      updated = requireChat(state, current.user.id, chat.id);
      if (typeof body.shared === "boolean") updated.shared = body.shared;
      if (hasProject) {
        if (nextProject === null) { delete updated.projectId; delete updated.projectShared; }
        else if (projectFor(current.user, nextProject, state.users)) {
          // Moving to a different project starts private again.
          if (updated.projectId !== nextProject) delete updated.projectShared;
          updated.projectId = nextProject;
        } else throw requestError(404, "not_found", "No such project");
      }
      if (hasProjectShared) {
        if (nextShared && !updated.projectId) throw requestError(400, "bad_request", "Put this chat in a project first");
        if (nextShared && updated.privateForward) throw requestError(409, "forward_private", "This chat includes a message from a private conversation, so it stays private");
        if (nextShared) updated.projectShared = true; else delete updated.projectShared;
      }
    });
    return send(res, 200, { chat: chatView(updated, user) });
  }
  // A member promoted to owner (or the reverse) keeps old chats on the old agent.
  const chatUp = cfg.upstreams[agentRole(chat.role, cfg)];

  // Archive is a tidy-up only, and only the person does it: the chat keeps running, and sending a
  // new message brings it back to the list.
  if (method === "POST" && (parts[3] === "archive" || parts[3] === "restore") && parts.length === 4) {
    const updated = mutateAuthenticated(req, (state, current) => {
      const active = requireChat(state, current.user.id, chat.id);
      if (parts[3] === "archive") active.archivedAt = now();
      else { delete active.archivedAt; active.reopenedAt = now(); }
      return { ...active };
    });
    return send(res, 200, { chat: chatView(updated, user) });
  }

  if (method === "DELETE" && parts.length === 3) {
    mutateAuthenticated(req, (state, current) => { requireChat(state, current.user.id, chat.id).deletedAt = now(); });
    chatMediaStore().deleteChat(chat.id);
    documents().deleteChat(chat.id);
    removeLongMessages(chat.id);
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

  // The author has seen every finished reply (others reading a shared chat never get here).
  if (method === "POST" && parts[3] === "read" && parts.length === 4) {
    requireChat(readState(), requireAuth(req).user.id, chat.id);
    agentTurns.markChatRead(chat.id, user.id);
    return send(res, 200, { unread: 0 });
  }

  if (method === "GET" && parts[3] === "messages" && parts.length === 4) {
    const messages = await syncChatHistory(true);
    const latestTurn = agentTurns.latest(chat.id)[0] || null;
    for (const turn of agentTurns.drafts(chat.id)) messages.push({
      id: `draft_${turn.id}`, role: "assistant", text: turn.assistantText, at: turn.updatedAt,
      attachments: [], pending: !terminalTurn(turn), interrupted: terminalTurn(turn), turnId: turn.id,
    });
    messages.sort((a, b) => a.at - b.at);
    const current = requireAuth(req);
    const sources = agentTurns.messageSources(chat.id);
    return send(res, 200, { messages: messages.map(message => privateMessageView(message, current.user, sources)), latestTurn, upstreamUnavailable });
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
    if (method === "POST" && parts[5] === "steer" && parts.length === 6) {
      await readAuthorizedBody(req);
      ownTurn(parts[4]);
      if (agentRole(chat.role, cfg) !== "owner") return fail(res, 403, "forbidden", "Steering needs the full agent");
      return send(res, 200, { turn: agentTurns.requestSteer(parts[4]) });
    }
    if (method === "POST" && parts[5] === "approval" && parts.length === 6) {
      const body = await readAuthorizedBody(req);
      const actor = ownTurn(parts[4]);
      // ownTurn already proves this is the caller's own turn in their own chat.
      if (agentRole(chat.role, cfg) !== "owner") return fail(res, 403, "forbidden", "Only the owner can approve this action");
      return send(res, 200, { turn: agentTurns.requestApproval(parts[4], body.approvalId, body.choice) });
    }
  }

  // Documents and design files upload in chunks first; the message then names them.
  if (method === "POST" && parts[3] === "uploads" && parts.length === 4) {
    const body = await readAuthorizedBody(req);
    return send(res, 201, documents().create({ chatId: chat.id, userId: user.id, name: body.name, size: body.size }));
  }
  if (method === "POST" && parts[3] === "uploads" && parts.length === 5) {
    const body = await readAuthorizedBody(req, DOCUMENT_CHUNK_BODY);
    return send(res, 200, documents().append({ chatId: chat.id, userId: user.id, id: parts[4], offset: body.offset, data: body.data }));
  }

  if (method === "POST" && parts[3] === "messages" && parts[5] === "forward" && parts.length === 6) {
    return forwardChatMessage(req, res, { chat, author: user, user, device, messageId: parts[4], cfg, readAuthorizedBody });
  }

  if (method === "POST" && parts[3] === "messages" && parts.length === 4) {
    const body = await readAuthorizedBody(req, MAX_UPLOAD_BODY);
    let text = String(body.text || "").trim();
    const inline = Array.isArray(body.attachments) ? body.attachments.filter(a => !a?.upload) : body.attachments;
    const uploaded = Array.isArray(body.attachments) ? body.attachments.filter(a => a?.upload) : [];
    if (Array.isArray(body.attachments) && body.attachments.length > 4) return fail(res, 400, "attachments", "Attach up to 4 files");
    let attachments = [...validateUploads(inline, { mediaOnly: agentRole(chat.role, cfg) !== "owner" }), ...documents().resolve({ chatId: chat.id, userId: user.id, parts: uploaded })];
    // Only the server writes forward headers; typed lookalikes don't render as one.
    if (/^Forwarded message from /.test(text)) text = `\u200B${text}`;
    const ownText = text;
    let privateForward = false;
    // "Ask the agent" about a channel or DM message the person can see.
    if (body.forward != null) {
      if (!messaging) return fail(res, 404, "not_found", "That message is unavailable");
      const source = messaging.forwardSource(body.forward, user.id);
      // A DM or private channel must not leak into a chat the server can read.
      if (source.private && (chatShared(readState().chats[chat.id] || chat) || (readState().chats[chat.id] || chat).projectShared)) return fail(res, 409, "forward_private", "Messages from private conversations go into a private chat");
      privateForward = source.private;
      ({ text, attachments } = composeForward({ text, attachments }, source));
    }
    if (!text && !attachments.length) return fail(res, 400, "empty", "Type a message first");
    // Only the full agent can read a saved long message from disk.
    const limit = agentRole(chat.role, cfg) === "owner" ? MAX_MESSAGE_CHARS : INLINE_MESSAGE_CHARS;
    if (text.length > limit) return fail(res, 413, "too_long", "That message is too long");
    const prior = agentTurns.replay({ chat, text, attachments, requestId: body.requestId });
    if (prior) return streamPrivateTurn(req, res, prior.id, () => ownTurn(prior.id));
    if (usageStore().overLimit(user)) return fail(res, 429, "usage_limit", limitMessage(usageStore().limit));
    // Establish history before the worker records new accepted deliveries.
    await syncChatHistory();
    const turn = mutateAuthenticated(req, (state, current) => {
      const active = requireChat(state, current.user.id, chat.id);
      if (privateForward && (chatShared(active) || active.projectShared)) throw requestError(409, "forward_private", "Messages from private conversations go into a private chat");
      const queued = agentTurns.enqueue({ chat: active, user: current.user, device: current.device, text, attachments, requestId: body.requestId });
      if (privateForward) active.privateForward = true;
      if (active.title === "New chat") active.title = (ownText || (body.forward != null ? `About: ${text.split("\n")[1]?.replace(/^> /, "") || "a message"}` : "") || text || attachments[0].name).replace(/\s+/g, " ").slice(0, 60);
      active.startedAt ??= now();
      active.updatedAt = now();
      delete active.archivedAt;
      return queued;
    });
    if (privateTimer) void agentTurns.processNext();
    return streamPrivateTurn(req, res, turn.id, () => {
      // An already-open stream may finish after its chat is deleted. It never
      // makes deleted attachments downloadable or opens a new subscription.
      const latest = readState();
      const current = requireAuth(req, latest);
      if (latest.chats[chat.id]?.userId !== current.user.id) throw requestError(404, "not_found", "No such chat");
      return current;
    });
  }

  return fail(res, 404, "not_found", `This server has no ${method} ${url.pathname}. The app may be newer than the server`);
}

function streamPrivateTurn(req, res, turnId, authorize, after = 0) {
  authorize();
  const sources = agentTurns.turnMessageSources(turnId);
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
        const current = authorize();
        const events = agentTurns.events(turnId, after);
        for (const event of events) {
          const payload = event.event === 'sent'
            ? { ...event.payload, message: privateMessageView(event.payload.message, current?.user, sources) }
            : event.event === 'message' ? privateMessageView(event.payload, current?.user, sources) : event.payload;
          res.write(`event: ${event.event}\ndata: ${JSON.stringify(payload)}\nid: ${event.seq}\n\n`);
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
  if (!turn.run_id && usageStore().overLimit(user)) throw requestError(429, "usage_limit", limitMessage(usageStore().limit));
  const durable = !!turn.run_id || await supportsDurableRuns(up);
  // Legacy owner agents can read the exact saved input instead of receiving
  // altered chunks. Restricted agents never receive a local-file fallback.
  const text = agentText(turn, full, durable ? INLINE_MESSAGE_CHARS : TEXT_PART_CHARS);
  const files = agentFiles(turn, full);
  const input = hermesInput(files ? (text ? `${text}\n\n${files}` : files) : text, turn.attachments, { durable, full });
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
  // One live line for what the agent is doing right now. Only changes are
  // journaled, so a long reply doesn't write a status per token.
  let activity;
  const setActivity = text => { if (text !== activity) { activity = text; hooks.emit("status", { text }); } };
  // Each step is also kept (label, and for the owner what it's working on) so
  // tapping the progress line can show everything the agent has done so far.
  const step = (label, detail) => hooks.emit("step", { label, ...(full && detail ? { detail: stepDetail(detail) } : {}) });
  const onEvent = (name, payload) => {
    if (name === "assistant.delta") { if (payload.delta) { if (activity !== WRITING_LINE) step(WRITING_LINE); setActivity(WRITING_LINE); } hooks.emit("delta", { text: payload.delta || "" }); }
    else if (name === "tool.started") { const line = toolStatusLine(payload.tool_name, { full }); step(line, typeof payload.preview === "string" ? payload.preview : ""); setActivity(line); }
    else if (name === "reasoning.available" || (name === "tool.progress" && payload.tool_name === "_thinking")) { step(THINKING_LINE, payload.text ?? payload.delta); setActivity(THINKING_LINE); }
    else if (name === "run.started" || name === "tool.completed" || name.startsWith("reasoning.")) setActivity(THINKING_LINE);
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
  if (durable) {
    if (turn.run_id && !turn.accepted) onAccepted();
    const canSteer = full && await supportsSteer(up);
    const steered = steerId => {
      // The steer is now part of this conversation: show it as a sent message.
      const queued = agentTurns.get(steerId);
      if (!queued) return;
      chatMediaStore().accept(turn.chat_id, "user", queued.text, [], steerId);
      hooks.steered?.(steerId);
    };
    result = await runDurableHermes({ up, sessionId: turn.session_id, input, sessionKey: sessionKey(user, turn.chat_id), instructions: chatContext(chat), runId: turn.run_id,
      onAccepted, onEvent, checkpoint: hooks.checkpoint, controls: hooks.controls, steered, canSteer });
    if (result.usage) recordUsage({ eventId: `chat:${turn.id}`, userId: turn.user_id, source: "chat", chatId: turn.chat_id, text: turn.text, usage: result.usage });
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
    const answer = await streamTurn(up, turn.session_id, input, sessionKey(user, turn.chat_id), onEvent, () => false, onAccepted,
      usage => recordUsage({ eventId: `chat:${turn.id}`, userId: turn.user_id, source: "chat", chatId: turn.chat_id, text: turn.text, usage }), chatContext(chat));
    if (!assistantMessage && answer) saveAssistant(answer);
    result = { status: "completed" };
  }
  mutateState(state => { const current = state.chats[turn.chat_id]; if (current && !current.deletedAt) current.updatedAt = now(); });
  return { status: result.status, unreadSteers: result.unreadSteers, notification: assistantMessage && (assistantMessage.text || assistantMessage.attachments.length) ? {
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
  return feedbackResult(await streamTurn(up, sid, hermesInput(feedbackPrompt(report), report.images || []), "servant:development-feedback", () => {}));
}

function createServices(fixedCfg, { externalWorker = false, autoDrain = true } = {}) {
  process.umask(0o077); // messages.db and its WAL files are private to this user
  store();
  let servicePush;
  const serviceMessaging = createMessaging({
    file: path.join(DATA_DIR, "messages.db"),
    externalWorker,
    users: () => activeUsers(readState()),
    onMessage: event => servicePush.enqueue(event),
    agentName: () => (fixedCfg || loadConfig()).agentName || "Agent",
    // Channels use the same agent as private chats: full access unless the
    // server is set to "agentAccess": "limited".
    onUsage: recordUsage,
    messageExtras: m => meetings?.messageExtras(m),
    // @s in a channel or DM asked for real work: open a shared agent chat for the person who
    // asked, with the conversation as its first message, and start the agent on it.
    startWorkChat: workChatStarter = async ({ userId, deviceId, title, where, transcript }) => {
      const cfg = fixedCfg || loadConfig();
      const state = readState();
      const user = state.users[userId];
      if (!user) throw new Error("that person is gone");
      const device = Object.values(state.devices).find(d => d.id === deviceId && d.userId === userId && !d.revokedAt)
        ?? Object.values(state.devices).find(d => d.userId === userId && !d.revokedAt);
      if (!device) throw new Error("no signed-in device");
      const up = upstreamFor(user, cfg);
      if (!up) throw new Error("the agent isn't set up");
      const chatId = id("cht"), hermesSessionId = `servant_${user.id}_${chatId}`;
      const made = await hermes(up, "POST", "/api/sessions", { id: hermesSessionId, title: `Servant · ${user.name} · ${chatId.slice(-6)}` });
      if (!made.ok) throw new Error(`agent ${made.status}`);
      const chat = { id: chatId, userId: user.id, role: user.role, hermesSessionId, title: title.slice(0, 80), shared: true,
        startedAt: now(), createdAt: now(), updatedAt: now(), fromConversation: where };
      mutateState(s => { s.chats[chatId] = chat; });
      const text = `${user.name} asked for this in ${where}. Do the work here; others can follow along.\n\n${transcript}`.slice(0, INLINE_MESSAGE_CHARS);
      serviceTurns.enqueue({ chat, user, device, text, attachments: [] });
      return chat;
    },
    askAgent: async ({ sessionId, sessionKey: key, fresh, text, restartText, attachments, onDelta, onUsage = () => {}, userId }) => {
      if (usageStore().overLimit(readState().users[userId])) return limitMessage(usageStore().limit);
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
      }, () => false, () => {}, onUsage);
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
      if (event.kind === "message") return serviceMessaging.notificationFor(event.messageId, user, event);
      const chat = readState().chats[event.chatId];
      if (event.userId !== user.id || !chat || chat.deletedAt || chat.userId !== user.id) return null;
      return { kind: "agent", chatId: chat.id, title: "Agent · " + chat.title, body: event.text };
    },
    send: createPushTransport(() => loadJson(process.env.SERVANT_PUSH_CONFIG || path.join(os.homedir(), ".config/servant/push.json"), {})),
  });
  return { messaging: serviceMessaging, push: servicePush, agentTurns: serviceTurns,
    closeState: () => { chatMedia?.close(); chatMedia = null; usageDb?.close(); usageDb = null; stateStore?.close(); stateStore = null; } };
}

// Meeting notes: a no-tools model call on the restricted agent turns the
// transcript into a summary, decisions and next steps routed to rooms.
async function meetingNotes({ transcript, rooms, room, people }) {
  const cfg = loadConfig();
  const up = upstreamFor({ role: "member" }, cfg);
  if (!up) throw new Error("The agent isn't set up on this server yet");
  const context = [
    `Meeting room: ${room.kind === "channel" ? "#" + room.name : "a direct message"}`,
    `People: ${people.join(", ") || "unknown"}`,
    `Rooms: ${rooms.map(r => "#" + r.name).join(", ") || "none"}`,
    "", "Transcript:", transcript.slice(-120000),
  ].join("\n");
  const response = await hermes(up, "POST", "/v1/chat/completions", { messages: [
    { role: "system", content: MEETING_NOTES_PROMPT }, { role: "user", content: context },
  ] }, {}, AbortSignal.timeout(300_000));
  if (!response.ok) throw new Error(`The agent returned ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
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
  migrateProjects();
  messaging.ensureGeneral();
  messaging.joinEveryone(Object.keys(activeUsers(readState())));
  if (!meetings) {
    // The API process hosts calls even when a separate worker runs agent turns.
    meetings = createMeetings({
      dir: path.join(DATA_DIR, "meetings"),
      messaging,
      users: () => activeUsers(readState()),
      config: () => (fixedCfg || loadConfig()).meetings,
      summarize: meetingNotes,
    });
    meetings.recover();
  }
  if (!recordings) {
    recordings = createRecordings({
      dir: path.join(DATA_DIR, "recordings"),
      users: () => activeUsers(readState()),
      config: () => (fixedCfg || loadConfig()).meetings,
      summarize: meetingNotes,
      startWork: o => workChatStarter(o),
    });
    recordings.recover();
  }
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
    await meetings?.close().catch(err => console.error("[servant] meetings shutdown", err)); meetings = null;
    await recordings?.close().catch(err => console.error("[servant] recordings shutdown", err)); recordings = null;
    await messaging?.whenIdle();
    await push?.shutdown();
    push = null;
    feedback?.close(); feedback = null;
    messaging?.close(); messaging = null;
    agentTurns?.close(); agentTurns = null;
    chatMedia?.close(); chatMedia = null; usageDb?.close(); usageDb = null;
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
    // --owner: sign in as the owner (first owner on a new server). --local: the
    // link points at 127.0.0.1, for the Mac app on this same computer.
    const owner = process.argv.includes("--owner");
    const cfg = loadConfig();
    // With no public address yet, only this computer can reach the server.
    const local = process.argv.includes("--local") || (!cfg.discoveryUrl && !cfg.publicUrl);
    const named = owner || arg("name", "") || arg("user", "");
    const { code, expiresAt } = owner ? ownerInvite({ name: arg("name", "") })
      : named
      ? { code: createInvite({ name: arg("name", ""), role: arg("role", "member"), userId: arg("user", "") || undefined }), expiresAt: now() + INVITE_TTL_MS }
      : joinLink({ fresh: process.argv.includes("--fresh") });
    console.log(`Invite code: ${code}`);
    console.log(`Link:        ${pairLink(code, cfg, { local })}`);
    console.log(`${named ? "Single use" : "Anyone with it can join"}. Expires ${new Date(expiresAt).toDateString()}.`);
    if (local) console.log("Works only on this computer. In the Servant Mac app, choose Paste an invite link and paste it.");
  } else if (cmd === "ota") {
    const { listUpdates, publishRollback } = await import("./ota.mjs");
    const dir = path.join(DATA_DIR, "ota");
    const sub = process.argv[3] || "status";
    if (sub === "status") {
      const all = listUpdates(dir);
      if (!all.length) console.log("No updates published. Run: servant ota publish");
      for (const u of all) console.log(`${u.createdAt}  ${u.id}  runtime ${u.runtimeVersion}  ${u.type === "rollback" ? "rollback to the version in the app" : Object.keys(u.platforms).join("+")}${u.note ? `  ${u.note}` : ""}`);
    } else if (sub === "rollback") {
      const runtime = arg("runtime", "");
      if (!runtime) { console.error("Usage: servant ota rollback --runtime <runtime version>   (see: servant ota status)"); process.exit(2); }
      const r = publishRollback({ dir, runtimeVersion: runtime });
      console.log(`Phones on runtime ${runtime} go back to the version built into their app (${r.id}).`);
    } else { console.error("Usage: servant ota status | publish | rollback --runtime <v>"); process.exit(2); }
  } else if (cmd === "release") {
    const [build, file] = process.argv.slice(3);
    if (!build || !file) {
      console.error("usage: server.mjs release <build> <notes.md>");
      process.exit(2);
    }
    const adminPort = await activeAdminPort();
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
  } else if (cmd === "remove-person" || cmd === "people") {
    const query = process.argv.slice(3).join(" ").trim();
    if (cmd === "people" || !query) {
      for (const u of Object.values(readState().users)) console.log(`${u.id}  ${u.role}  ${u.name}${isRemoved(u) ? "  (removed)" : ""}`);
      if (cmd === "remove-person") { console.error("usage: server.mjs remove-person <name or id>"); process.exit(2); }
    } else {
      const found = Object.values(readState().users).filter(u => u.id === query || u.name.toLowerCase() === query.toLowerCase());
      if (found.length !== 1) { console.error(found.length ? "More than one person has that name. Use the id from: server.mjs people" : "No one by that name. List people with: server.mjs people"); process.exit(1); }
      const { r, data } = await adminPost("/admin/people/remove", { userId: found[0].id });
      if (!r.ok) { console.error(`Couldn't remove them (${r.status}): ${data.error?.message || "server not running?"}`); process.exit(1); }
      console.log(data.removed ? `Removed ${data.name}. Their devices are signed out and #general says they left.` : `${found[0].name} was already removed`);
    }
  } else if (cmd === "rename") {
    // server.mjs rename "<name or id>" "<new name>" — fix someone's name; everyone's app updates live.
    const [query, next] = [process.argv[3], (process.argv[4] || "").replace(/\s+/g, " ").trim().slice(0, 40)];
    if (!query || !next) { console.error('usage: server.mjs rename "<name or id>" "<new name>"'); process.exit(2); }
    const found = Object.values(readState().users).filter(u => u.id === query || u.name.toLowerCase() === query.toLowerCase());
    if (found.length !== 1) { console.error("No one (or more than one person) by that name. List people with: server.mjs people"); process.exit(1); }
    const { r, data } = await adminPost("/admin/people/rename", { userId: found[0].id, name: next });
    if (!r.ok) { console.error(`Couldn't rename (${r.status}): ${data.error?.message || "server not running?"}`); process.exit(1); }
    console.log(`Renamed ${found[0].name} to ${data.name}`);
  } else if (cmd === "tokens") {
    // server.mjs tokens <name or id> unlimited|limited — lift or restore someone's daily agent cap.
    const mode = process.argv.at(-1), query = process.argv.slice(3, -1).join(" ").trim();
    if (!query || !["unlimited", "limited"].includes(mode)) { console.error("usage: server.mjs tokens <name or id> unlimited|limited"); process.exit(2); }
    const name = mutateState(state => {
      const found = Object.values(state.users).filter(u => u.id === query || u.name.toLowerCase() === query.toLowerCase());
      if (found.length !== 1) return null;
      if (mode === "unlimited") found[0].unlimitedTokens = true; else delete found[0].unlimitedTokens;
      return found[0].name;
    });
    if (!name) { console.error("No one (or more than one person) by that name. List people with: server.mjs people"); process.exit(1); }
    console.log(mode === "unlimited" ? `${name} now has no daily agent token limit` : `${name} is back on the daily agent token limit`);
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
