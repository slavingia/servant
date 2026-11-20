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
//   node server/server.mjs session-reset <name, user id or device id>   let someone back in when sessions expire (session-expiry.mjs)
//   node server/server.mjs release <build> <notes.md>   post a build's notes to #whats-new

import { joinPage } from "./join-page.mjs";
import { newFolder, removePrototype, savePrototypePage, servePrototype } from "./prototypes.mjs";
import { previewInfo, serveAppPreview } from "./app-preview.mjs";
import { privacyPage } from "./privacy-page.mjs";
import { landingPage, supportPage } from "./public-page.mjs";
import { termsPage } from "./terms-page.mjs";
import { createEmailVerifier, commandSender, emailAllowed, emailSettings, emailSetupWarning, normalizeEmail } from "./email-verify.mjs";
import { createSessions } from "./session-expiry.mjs";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMessaging } from "./messaging.mjs";
import { normalizeFeatures, featureOffMessage, socialFeature } from "./features.mjs";
import { normalizeBanner } from "./banner.mjs";
import { normalizeTheme } from "./theme.mjs";
import { piiWarningEnabled, screenText } from "./pii-gate.mjs";
import { screenMessage } from "./business-gate.mjs";
import { recordsPreservationEnabled, listPreserved, preservedFile, verifyChain } from "./records-preserve.mjs";
import { inDeepWork, setDeepWork } from "./deep-work.mjs";
import { createOta } from "./ota.mjs";
import { mailerSender } from "./mailer.mjs";
import { createSecureInbox, INBOX_BODY_LIMIT, secureInboxPublicUrl } from "./secure-inbox.mjs";
import { secureInboxPage, secureInboxScript } from "./secure-inbox-page.mjs";
import { createInboxNotices, inboxNoticeSettings } from "./secure-inbox-notices.mjs";
import { createRecordings } from "./recordings.mjs";
import { createFileDrop } from "./file-drop.mjs";
import { createTodos, readDoneTag } from "./todos.mjs";
import { NOTES_PROMPT as RECORDING_NOTES_PROMPT } from "./transcription.mjs";
import os from "node:os";
import { execFile } from "node:child_process";
import { createFeedback, fileIssue } from "./feedback.mjs";
import { createBusinessReports, reportFalseAlarm, reportingEnabled } from "./business-reports.mjs";
import { businessVerdict } from "./business-gate.mjs";
import { createPushService, preferences, previewText, updatePushRegistration, updatePreferences } from "./push.mjs";
import { createPushTransport } from "./push-transport.mjs";
import { vapidSubject, webPushIdentity } from "./web-push.mjs";
import { createLinkPreviews } from "./link-preview.mjs";
import { createSecureTransport, serverIdentity } from "./secure-transport.mjs";
import { createStateStore } from "./state-store.mjs";
import { createDeviceLink, previewDeviceLink, approveDeviceLink, denyDeviceLink, pollDeviceLink, createSignInLink } from "./device-links.mjs";
import { privateMessageView } from "./source-device.mjs";
import { createChatMediaStore } from "./chat-media.mjs";
import { createUsageStore, limitMessage, agentTierOf, startOfDay, AGENT_TIERS, RESEARCHER_TIER, TOKEN_LIMIT_CHOICES, MAX_AGENT_TIER } from "./usage.mjs";
import { tierCosts } from "./usage-cost.mjs";
import { jobRoleOf, validJobRole } from "./job-roles.mjs";
import { tourFacts } from "./tour.mjs";
import { createAgentTurns, terminalTurn } from "./agent-turns.mjs";
import { createEgressProxy, createEgressStore, egressSettings } from "./egress.mjs";
import { capabilitySettings, createEntitlements, grantDaysSetting, NATIVE, SOCIAL_ENTITLEMENT } from "./entitlements.mjs";
import { checkGithubToken, cleanValues, createConnections, createTextStream, publicTool, readConnectMarkers, redactor, stripConnectMarkers, tokenInChatMessage, tokenInText, toolCatalog } from "./connections.mjs";
import { AUTO_WORK_PER_HOUR, commentRequest, createPrototypeReviews, maskEmail, reviewDomains } from "./prototype-reviews.mjs";
import { reviewPage, reviewPageHeaders } from "./prototype-review-page.mjs";
import { createCodeRequests } from "./code-requests.mjs";
import { supportsDurableRuns, supportsEntitlementChecks, supportsSteer, runDurableHermes } from "./hermes-runs.mjs";
import { createReadmeCache } from "./project-readme.mjs";
import { createGlossaryStore } from "./glossary.mjs";
import { createLexiconStore } from "./lexicon.mjs";
import { withColloquialisms } from "./colloquialisms.mjs";
import { createWikiStore, WIKI_LIMITS } from "./wiki.mjs";
import { accessTokenSettings, createAccessTokens, DEFAULT_DAYS } from "./access-tokens.mjs";
import { apiGuide } from "./access-token-guide.mjs";
import { draftWikiPage } from "./wiki-draft.mjs";
import { createSocial, socialSettings, SOCIAL_LIMITS } from "./social.mjs";
import { createSocialRunner } from "./social-run.mjs";
import { addLesson, cleanInstruction, readLesson, readSocialDraft, socialDraftMessages, socialLessonMessages, socialPostMessages, SOCIAL_GUIDE, SOCIAL_GUIDE_KIND } from "./social-draft.mjs";
import { cleanOutsideReviewers, outsideReviewers, MAX_ITEMS, MAX_PARTS, MAX_PEOPLE, MAX_PROJECTS, MAX_RELEASES, VIBE_PROJECT, accessOf, configureProjects, accessibleProjects, cleanDate, cleanDescription, cleanLevel, cleanLogin, cleanName, cleanNotes, cleanPath, cleanReleaseName, cleanRepo, cleanRules, cleanReviewers, cleanStage, cleanStages, cleanTitle, ownsCell, cleanUrl, cleanWorkflow, createProjectFiles, createProjectStore, expandPath, migrateFolders, needsMigration, newItem, newPart, newProject, newRelease, patchCell, cleanPartTitle, releaseReady, setItemDone, projectInstructions, projectPeople, projectSharedWith, projectView, removeAccess, setAccess, validProjectId, vibeFolder, vibePreview } from "./projects.mjs";
import { validTermsAcceptance } from "./terms.mjs";
import { autoTitle, cleanChatTitle } from "./chat-title.mjs";
import { cleanGuessRequest, guessAbbreviations, learnAbbreviations, LEARN_SOURCE } from "./lexicon-guess.mjs";
import { verifyMemberUpstream, verifyResearcherUpstream } from "./member-policy.mjs";
import { composeForward } from "./forward.mjs";
import { stepDetail, THINKING_LINE, toolStatusLine, WRITING_LINE } from "./agent-status.mjs";
import { validateUploads, normalizeMediaContent, hermesInput, mediaPage, createMediaDeltaFilter, MAX_UPLOAD_BODY, TEXT_PART_CHARS } from "./media.mjs";
import { createDocumentStore, DOCUMENT_CHUNK, DOCUMENT_CHUNK_BODY } from "./documents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SERVANT_DATA_DIR || path.join(HERE, "data");
const PROTOTYPES_DIR = path.join(DATA_DIR, "prototypes");
// Each project's app exported for the web, served at /a/<project id>/ (app-preview.mjs, docs/app-preview.md).
const APP_PREVIEWS_DIR = path.join(DATA_DIR, "app-previews");
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
  const keep = recordsPreservationEnabled(loadConfig().recordsPreservation);
  for (const dir of [LONG_MESSAGE_DIR, UPLOAD_DIR]) {
    try {
      for (const name of fs.readdirSync(dir)) if (name.startsWith(`${chatId}-`)) {
        const from = path.join(dir, name);
        // Records preservation: long messages and files the agent produced are moved aside, not removed.
        if (keep) { const holding = path.join(dir, ".removed", String(Date.now())); fs.mkdirSync(holding, { recursive: true, mode: 0o700 }); fs.renameSync(from, path.join(holding, name)); }
        else fs.rmSync(from, { force: true, recursive: true });
      }
    } catch (e) { if (keep) console.error("[servant] records preservation: could not set aside", e?.message || e); }
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

// An absolute path, or one under the home folder ("~/Desktop"); anything else leaves file drop off.
export const fileDropFolder = value => { const dir = typeof value === "string" ? expandPath(value.trim()) : ""; return path.isAbsolute(dir) ? path.resolve(dir) : ""; };

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
    // The agent's way out to the network (docs/agent-egress.md). Off unless mode is "ask".
    agentEgress: egressSettings(cfg.agentEgress),
    // How many days an "allow always" lasts before it must be asked for again (docs/entitlements.md). 0: until taken back.
    entitlementGrantDays: grantDaysSetting(cfg.entitlementGrantDays),
    // Built-in entitlements checked before the agent reads or changes files or GitHub (docs/entitlements.md). Off unless mode is "ask".
    agentCapabilities: capabilitySettings(cfg.agentCapabilities),
    // Personal connections (docs/connections.md): an owner's own tool types ("types"), and `"verify": false` to save a GitHub token without asking GitHub whose it is.
    connections: cfg.connections && typeof cfg.connections === "object" ? cfg.connections : undefined,
    // Where new people start: 0 = no agent until an owner sets a tier (1 tester, 2 business owner, 3 software engineer, 4 researcher, 5 product manager).
    defaultAgentTier: [0, 1, 2, 3, 4, 5].includes(cfg.defaultAgentTier) ? cfg.defaultAgentTier : 0,
    // Email code sign-in (docs/email-sign-in.md). Off unless enabled.
    emailVerification: cfg.emailVerification || {},
    // The secure inbox's own settings (docs/secure-inbox.md): the mailer for reply emails and the wait before one is sent.
    secureInbox: cfg.secureInbox && typeof cfg.secureInbox === "object" ? cfg.secureInbox : {},
    // Sessions end after this many hours and need a code sent to the work email on file (session-expiry.mjs). 0/absent: never.
    sessionMaxHours: cfg.sessionMaxHours,
    sessionGraceHours: cfg.sessionGraceHours,
    // Where in-app feedback goes: a GitHub issue here, filed with the owner's gh login (no AI involved).
    feedbackRepo: typeof cfg.feedbackRepo === "string" ? cfg.feedbackRepo : "slavingia/servant",
    // Shown on the public /privacy page for data deletion and questions. Optional: without it the page says to ask whoever runs the server.
    contactEmail: typeof cfg.contactEmail === "string" ? cfg.contactEmail.trim() : "",
    // The server reads a posted link's page for its title (link-preview.mjs). `"linkPreviews": false` stops it.
    linkPreviews: cfg.linkPreviews !== false,
    // Optional one-line note shown at the bottom of the public join and privacy pages, for example who runs this server.
    footer: typeof cfg.footer === "string" ? cfg.footer.trim().slice(0, 300) : "",
    // Where the server can be reached from phones. Filled in by the tunnel script.
    publicUrl: process.env.SERVANT_PUBLIC_URL || cfg.publicUrl || "",
    // The website that serves the invite page (https://servant.com/join), and the download buttons it shows.
    joinUrl: cfg.joinUrl || "",
    // The browser app is hosted separately from an instance's API and join page.
    webUrl: cfg.webUrl || "https://servant.com",
    downloads: cfg.downloads || {},
    // Stable URL that always returns {"url": "<current publicUrl>"}.
    discoveryUrl: process.env.SERVANT_DISCOVERY_URL || cfg.discoveryUrl || "",
    // Which parts of the app this instance uses (features.mjs). Each is on unless set to exactly false.
    features: normalizeFeatures(cfg.features),
    // Personal access tokens and the plain HTTPS API they open at /api/v1/ (docs/access-tokens.md). Off unless enabled.
    accessTokens: accessTokenSettings(cfg.accessTokens),
    // Social media (docs/social.md): the X account's keys, the searches and the pace. Shown only once the keys are there,
    // and hidden again by `"features": { "social": false }`.
    social: cfg.social && typeof cfg.social === "object" ? cfg.social : undefined,
    socialHidden: cfg.features?.social === false,
    // One server-wide banner for signed-in apps (banner.mjs). Null when off.
    banner: normalizeBanner(cfg.banner),
    // Everyday shorthand (tmmrw, lmk, btw...) expanded as people type, as one group (colloquialisms.mjs). Off unless set.
    expandColloquialisms: cfg.expandColloquialisms,
    // Workspace primary color, refreshed by apps with their account metadata.
    theme: normalizeTheme(cfg.theme),
    piiWarning: cfg.piiWarning && typeof cfg.piiWarning === "object" ? cfg.piiWarning : undefined,
    recordsPreservation: cfg.recordsPreservation && typeof cfg.recordsPreservation === "object" ? cfg.recordsPreservation : undefined,
    // File drop (file-drop.mjs): the folder on this computer where files the owner drops on the app land. Off unless set.
    fileDropDir: fileDropFolder(process.env.SERVANT_FILE_DROP_DIR || cfg.fileDrop?.dir),
    // Lets build scripts on this Mac post release notes. Never leaves the Mac.
    adminKey: process.env.SERVANT_ADMIN_KEY || cfg.adminKey || "",
    // Where projects live (docs/projects.md). A relative path is inside the data dir.
    projectsFile: path.resolve(DATA_DIR, expandPath(process.env.SERVANT_PROJECTS_FILE || cfg.projectsFile || "projects.json")),
    // The project Prototyping chats build in (projects.mjs VIBE_PROJECT). Applied here so every reader sees the same id.
    prototypesProject: configureProjects({ prototypesProject: cfg.prototypesProject }),
    upstreams: cfg.upstreams || {
      owner: { url: "http://127.0.0.1:8642", key: process.env.SERVANT_OWNER_KEY || "" },
      member: { url: "http://127.0.0.1:8643", key: process.env.SERVANT_MEMBER_KEY || "" },
      researcher: { url: "http://127.0.0.1:8646", key: process.env.SERVANT_RESEARCHER_KEY || "" },
    },
  };
}

// Lazy initialization keeps the independent feedback worker from migrating or
// opening account storage just because it imports runFeedback.
let stateStore;
const store = () => stateStore ??= createStateStore({ directory: DATA_DIR });
// This server's signing key for browser push (web-push.mjs): made on first use, kept in the data directory.
let webPushKeys = null;
const webPush = () => webPushKeys ??= webPushIdentity(DATA_DIR);
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

/** Tests only: where the agent's network gate listens, and a token that makes traffic count as one person's. */
export const egressForTest = () => ({ port: egressProxy?.port, use: (body, config) => agentUse(body, config), mint: (userId, chatId) => egressStore().tokenFor(userId, chatId), working: userId => egressStore().working(userId) });
export function createInvite({ name, role = "member", userId, agentTier, createdBy }) {
  return mutateState(state => {
    if (!["owner", "member"].includes(role)) throw new Error("role must be owner or member");
    const existing = userId ? state.users[userId] : null;
    if (userId && !existing) throw new Error("No such user");
    const code = inviteCode();
    state.invites[sha256(normalizeCode(code))] = {
      name: existing ? existing.name : String(name || "").slice(0, 80) || "Guest",
      role: existing ? existing.role : role,
      ...(existing ? { userId: existing.id } : {}),
      // An owner inviting someone for a kind of work (a business owner reviewing a prototype) says where they
      // start, instead of the server's default; and who invited them decides their entitlement requests.
      ...(!existing && Number.isInteger(agentTier) ? { agentTier } : {}), ...(!existing && createdBy ? { createdBy } : {}),
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

function makeJoinLink(state, { fresh, createdBy }) {
  const live = Object.values(state.invites).find((i) => i.reusable && !i.revokedAt && i.expiresAt > now());
  if (live && !fresh) return { code: live.code, expiresAt: live.expiresAt };
  if (live) live.revokedAt = now();
  const code = inviteCode();
  state.invites[sha256(normalizeCode(code))] = { reusable: true, code, role: "member", uses: 0, createdAt: now(), expiresAt: now() + INVITE_TTL_MS, ...(createdBy ? { createdBy } : {}) };
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
// The same invite as a web address people can tap in any app: https://<server>/join?code=…&key=…&d=…
// The page prefills the invite and offers the web app first; see join-page.mjs.
export function joinWebLink(code, cfg = loadConfig(), opts = {}) {
  const origin = (cfg.joinUrl || cfg.publicUrl || "").replace(/\/+$/, "");
  const app = new URL(pairLink(code, cfg, opts));
  return origin && !opts.local ? `${origin}/join?${app.searchParams}` : null;
}


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
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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

const fail = (res, status, code, message, extra) => send(res, status, { error: { code, message, ...(extra || {}) } });

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

// Why an invite can't be used right now, or null if it can. The wording tells the person
// what to do next: a sign-in link is made on their other device, a team link by whoever invited them.
function inviteProblem(invite, users) {
  const mine = invite?.kind === "sign-in-link";
  const again = mine ? "Make a new one on your other device: You, then Link a computer" : "Ask the person who invited you for a new one";
  if (!invite) return requestError(403, "invalid_invite", "That invite link doesn't work. Ask for a new one");
  if (invite.usedAt) return requestError(403, "invite_used", mine ? `That sign-in link was already used. Each link works once. ${again}` : `That invite link was already used. ${again}`);
  if (invite.revokedAt) return requestError(403, "invite_replaced", mine ? `A newer link replaced that one. Use the newest link from your other device, or make another there` : `That invite link was replaced by a newer one. ${again}`);
  if (invite.expiresAt < now()) return requestError(403, "invite_expired", mine ? `That sign-in link expired. Links work for ten minutes. ${again}` : `That invite link expired. ${again}`);
  if (invite.userId && isRemoved(users?.[invite.userId])) return requestError(403, "invalid_invite", "That invite link doesn't work. Ask for a new one");
  return null;
}

// Per-IP limiter on failed pairing codes. Successful pairings don't count, so
const emailVerifier = createEmailVerifier({ now: () => now(), send: (m, settings) => (globalThis.__servantEmailSend || commandSender)(m, settings) });
const sessions = createSessions({ dir: DATA_DIR, now: () => now(), config: loadConfig, emailVerifier });

// a whole team can pair from one office network.
const pairFailures = new Map();
const PAIR_WINDOW_MS = 10 * 60 * 1000;
function pairAllowed(ip) {
  const list = (pairFailures.get(ip) || []).filter((t) => now() - t < PAIR_WINDOW_MS);
  pairFailures.set(ip, list);
  return list.length < 10;
}
// Sending a code mails a stranger, so every request counts (not only the failures): 20 per ten minutes per visitor.
const emailStarts = new Map();
function emailStartAllowed(ip) {
  const list = (emailStarts.get(ip) || []).filter((t) => now() - t < PAIR_WINDOW_MS);
  if (list.length >= 20) { emailStarts.set(ip, list); return false; }
  emailStarts.set(ip, [...list, now()]);
  if (emailStarts.size > 5000) for (const [k, v] of emailStarts) if (!v.some((t) => now() - t < PAIR_WINDOW_MS)) emailStarts.delete(k);
  return true;
}
function pairFailed(ip) {
  pairFailures.set(ip, [...(pairFailures.get(ip) || []), now()]);
  // Keep the map from growing with every address ever seen (emailStarts does the same).
  if (pairFailures.size > 5000) for (const [k, v] of pairFailures) if (!v.some((t) => now() - t < PAIR_WINDOW_MS)) pairFailures.delete(k);
}

function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "");
}

// A device whose session ended (sessionMaxHours) is not signed in: null here, unless the caller asks to see it.
function authenticate(req, state, { allowExpired = false } = {}) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;
  const device = state.devices[sha256(header.slice(7).trim())];
  if (!device || device.revokedAt) return null;
  const user = state.users[device.userId];
  if (!user || isRemoved(user)) return null;
  const expired = sessions.expired(req, device, user);
  if (expired && !allowExpired) return null;
  return { device, user, expired };
}

const requestError = (status, code, message) => Object.assign(new Error(message), { status, code });
function requireAuth(req, state = readState(), owner = false) {
  const auth = authenticate(req, state, { allowExpired: true });
  if (!auth) throw requestError(401, "unauthorized", "This device isn't paired, or was removed");
  if (auth.expired) throw sessions.error(req);
  if (owner && auth.user.role !== "owner") throw requestError(403, "forbidden", "Only the owner can do that");
  return auth;
}
const mutateAuthenticated = (req, fn, owner = false) => mutateState(state => {
  const auth = requireAuth(req, state, owner);
  auth.device.lastSeenAt = now();
  return fn(state, auth);
});
// The workspace owner may jump into any chat its author shared with everyone and take part: send messages and
// get the agent's replies. Everything else about someone's chat (rename, share, archive, delete) stays theirs.
function mayTakePart(chat, user) {
  return !!chat && !chat.deletedAt && !!user && (chat.userId === user.id || (user.role === "owner" && chat.shared === true));
}
function requireChatParticipant(state, userId, chatId) {
  const chat = state.chats[chatId];
  if (!mayTakePart(chat, state.users[userId])) throw requestError(404, "not_found", "No such chat");
  return chat;
}
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
  // Everything they held is revoked and their code requests are dropped. Their agent's network tokens stop counting because they are no longer on the server.
  entitlementStore().forget(targetId, "server"); codeRequests.forget(targetId); accessTokens().forget(targetId, "server");
  // The credentials they saved for their own agent go with them.
  connectionStore().forget(targetId);
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
  // A researcher (tier 4) is never promoted to the full agent, whatever agentAccess says.
  if (role === "researcher") return "researcher";
  return role === "owner" || fullAgentAccess(cfg) ? "owner" : "member";
}

// Which agent a person's chats run on: "researcher" for tier 4, otherwise the usual owner or member agent.
function agentLane(user, cfg) {
  if (user?.role === "researcher") return "researcher";
  if (user && user.role !== "owner" && agentTierOf(user) === RESEARCHER_TIER) return "researcher";
  return agentRole(user?.role, cfg);
}

function upstreamFor(user, cfg) {
  const up = cfg.upstreams[agentLane(user, cfg)];
  if (!up || !up.url || !up.key) return null;
  return up;
}

// Restricted agents prove what they can do before every turn: the member agent has no tools at all,
// the researcher has web, search, vision and read-only skills but no shell and no files (so no GitHub).
const verifyUpstream = (lane, up) => lane === "researcher" ? verifyResearcherUpstream(up) : lane === "owner" ? Promise.resolve() : verifyMemberUpstream(up);


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
async function streamTurn(up, sessionId, text, key, onEvent, isClosed = () => false, onAccepted = () => {}, onUsage = () => {}, instructions = "", extraHeaders = {}) {
  const r = await hermes(
    up,
    "POST",
    `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
    { message: text, ...(instructions ? { system_message: instructions } : {}) },
    { Accept: "text/event-stream", "X-Hermes-Session-Key": key, ...extraHeaders },
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
      if (["error", "run.failed", "run.cancelled", "run.canceled"].includes(name)) {
        throw requestError(502, "agent_error", "The agent run did not finish. Try again");
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
  return !!chat && !chat.deletedAt && !!viewer && (chat.userId === viewer.id || viewer.role === "owner" || chatShared(chat) || !!chatMember(chat, viewer) || projectSharedWith(projects().read(), readState().users, chat, viewer));
}
// People the author invited into one agent chat, Teams style. Each sees the chat read only, from
// \`since\` on: earlier messages are hidden from them, never removed.
const chatMember = (chat, viewer) => (Array.isArray(chat?.members) && viewer ? chat.members.find(m => m.userId === viewer.id) : null) || null;
const CHAT_HISTORY = { none: null, day: 86_400_000, week: 7 * 86_400_000, all: Infinity };
// The earliest message this person may see: 0 for anyone who can read the whole chat another way.
function chatVisibleFrom(chat, viewer) {
  if (!viewer || chat.userId === viewer.id || viewer.role === "owner" || chatShared(chat) || projectSharedWith(projects().read(), readState().users, chat, viewer)) return 0;
  return chatMember(chat, viewer)?.since ?? Infinity;
}
// Lists show a chat to the people it's shared with or who were invited into it.
const chatListedFor = (chat, viewer) => viewer.role === "owner" || chatShared(chat) || !!chatMember(chat, viewer);
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
  const view = { id: chat.id, title: chat.title, ...(chat.titledBy ? { titledBy: chat.titledBy } : {}), createdAt: chat.createdAt, updatedAt: chat.updatedAt, shared: chatShared(chat),
    // The full agent takes any file (ZIPs, PDFs, prototypes); others take media.
    ...(agentRole(chat.role, loadConfig()) === "owner" ? { files: true } : {}),
    // folderId/folderShared repeat projectId/projectShared for app builds from before projects.
    ...(chat.projectId ? { projectId: chat.projectId, folderId: chat.projectId, project: { id: chat.projectId, name: projects().byId(chat.projectId)?.name || chat.projectId },
      ...(chat.projectShared ? { projectShared: true, folderShared: true } : {}) } : {}),
    ...(chat.mode === "vibe" ? { mode: "vibe", previewUrl: prototypePreview(chat) } : {}) };
  try { const u = usageStore().chatTotals(chat.id); if (u.turns) view.usage = u; } catch { /* stats never block a chat */ }
  if (viewer && chat.userId === viewer.id) {
    view.archived = !!chat.archivedAt;
    if (chat.members?.length) {
      const people = users[chat.userId] ? users : readState().users;
      view.members = chat.members.filter(m => !isRemoved(people[m.userId])).map(m => ({ id: m.userId, name: people[m.userId]?.name || "Former member", since: m.since, invitedAt: m.invitedAt }));
    }
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
// A visitor's message reaches the team's phones the way a direct message does. The message is already saved, so a
// queue that cannot take the alert never fails the visitor's send. A resent request maps to the same event and alerts once.
function notifyTeamOfVisitor(message) {
  try { if (message?.sender === "visitor") push?.enqueue({ kind: "case", eventId: `${message.conversationId}:${message.sequence}`, caseId: message.conversationId, sequence: message.sequence }); }
  catch (error) { console.warn("[inbox] could not queue the team's alert:", error?.code || error?.name || "error"); }
}
let feedback;
let inboxStore;
const inbox = () => inboxStore ??= createSecureInbox({ directory: DATA_DIR, users: () => activeUsers(readState()) });
// Reply emails for visitors (secure-inbox-notices.mjs). The config is re-read like everywhere else; with the
// feature off, or with no mailer, nothing is sent.
let inboxConfig = () => loadConfig();
let inboxNoticeTimer;
const inboxNotices = createInboxNotices({
  inbox,
  config: () => { const cfg = inboxConfig(); return normalizeFeatures(cfg.features).secureInbox ? cfg : { ...cfg, publicUrl: "" }; },
  send: (message, settings) => (globalThis.__servantInboxEmailSend || mailerSender)(message, settings),
});
const withNotices = result => ({ ...result, notify: { available: inboxNotices.available(), ...result.notify } });
let businessReports;
const reports = () => businessReports ??= createBusinessReports({ file: path.join(DATA_DIR, "business-reports.db") });
let messaging = null;
let secureTransport = null;
let chatMedia;
let agentTurns;
let privateTimer;
const privateStreams = new Set();
const CHAT_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🎉", "✅", "👀", "🔥", "👏", "💯"];
const chatMediaStore = () => chatMedia ??= createChatMediaStore(path.join(DATA_DIR, "chat-media.db"), {
  // When Hermes stops returning a message, Servant used to delete its own copy. With records preservation on, archive it first.
  keepDropped: (chatId, rowId) => {
    if (!recordsPreservationEnabled(loadConfig().recordsPreservation)) return;
    const m = chatMediaStore().preservableOne(rowId);
    if (!m) return;
    messaging.keep({ conversation_id: chatId, conversation_kind: "agent_chat", author_id: readState().chats[chatId]?.userId ?? null, actor_id: null, event: "agent_chat_message_dropped_upstream", text: m.text, created_at: m.at, detail: { role: m.role, id: m.id } }, m.files.filter(f => !f.onDisk));
  },
});

// Copies an agent chat (messages, attachments, turns, uploaded documents) into the append-only records archive before it is
// deleted. Throws if anything cannot be saved, so the delete never goes ahead without its record.
function preserveAgentChat(chat, actor) {
  const base = { conversation_id: chat.id, conversation_kind: "agent_chat", conversation_name: chat.title ?? null, author_id: chat.userId, actor_id: actor.id, created_at: chat.createdAt };
  // One transaction for the whole chat: if any part cannot be saved, none of it is, the chat is not deleted, and a retry starts clean.
  const entries = [[{ ...base, event: "agent_chat_deleted", text: chat.title ?? null, detail: { shared: chat.shared === true, projectId: chat.projectId ?? null, hermesSessionId: chat.hermesSessionId ?? null } }, []]];
  for (const m of chatMediaStore().preservable(chat.id)) entries.push([{ ...base, event: "agent_chat_message", text: m.text, created_at: m.at, detail: { role: m.role, id: m.id } }, m.files.filter(f => !f.onDisk)]);
  for (const t of agentTurns?.preservable(chat.id) ?? []) entries.push([{ ...base, event: "agent_turn", text: t.text, created_at: t.created_at, detail: { id: t.id, status: t.status, reply: t.assistant_text, userId: t.user_id } }, []]);
  messaging.keepAll(entries);
}
let documentStore;
let projectFileStore;
const projectFiles = () => projectFileStore ??= createProjectFiles(path.join(DATA_DIR, "project-files"), { keep: () => recordsPreservationEnabled(loadConfig().recordsPreservation) });
let projectStore;
let glossaryStore;
let lexiconStore;
// Someone kept, fixed, added or deleted an abbreviation: their own to-do to check it is done. Ticking a box for
// work already finished is not worth anyone's time, and a to-do that cannot be ticked must never fail the save.
function checkedAbbreviation(user, entryId, abbreviation) {
  if (!todosStore) return;
  try {
    for (const source of [entryId, ...(abbreviation ? [`term:${abbreviation.toUpperCase()}`] : [])]) {
      for (const todo of todosStore.forSource(user, LEARN_SOURCE, source)) if (todo.status === "open") todosStore.update(user, todo.id, { status: "done" });
    }
  } catch (error) { console.warn("[lexicon] could not finish the to-do:", error?.code || error?.name || "error"); }
}
let glossaryConfig;
const glossary = () => glossaryStore ??= createGlossaryStore({ file: path.join(DATA_DIR, "messages.db"), keepRecords: () => recordsPreservationEnabled((glossaryConfig || loadConfig()).recordsPreservation) });
const lexicon = () => lexiconStore ??= createLexiconStore({ file: path.join(DATA_DIR, "messages.db"), keepRecords: () => recordsPreservationEnabled((glossaryConfig || loadConfig()).recordsPreservation) });
let wikiStore;
// A page's text may be up to WIKI_LIMITS.body characters, each up to four bytes, plus the JSON around it.
const WIKI_BODY_LIMIT = WIKI_LIMITS.body * 4 + 4096;
const wiki = () => wikiStore ??= createWikiStore({ file: path.join(DATA_DIR, "messages.db"), keepRecords: () => recordsPreservationEnabled((glossaryConfig || loadConfig()).recordsPreservation),
  names: () => Object.fromEntries(Object.values(readState().users).map(person => [person.id, person.name])) });
// Social media (docs/social.md). Posts from X and the replies to them live in their own file; the guide the agent
// drafts from is a marked page of the wiki.
let socialDb = null, socialRun = null, socialTimer = null, socialConfig = null;
const socialWork = new Set();
const socialCfg = cfg => socialSettings((cfg || socialConfig?.() || loadConfig()).social);
const socialOn = cfg => socialFeature({ social: cfg.socialHidden ? false : undefined }, socialCfg(cfg).configured);
/** The flags an app is sent: the ones that are on unless turned off, and social media, which is on only once it is set up. */
const featuresFor = cfg => ({ ...normalizeFeatures(cfg.features), social: socialOn(cfg) });
const maySocial = user => !!user && !isRemoved(user) && (user.role === "owner" || entitlementStore().holds(SOCIAL_ENTITLEMENT.id, user.id));
const social = () => socialDb ??= createSocial({ file: path.join(DATA_DIR, "social.db"),
  names: () => Object.fromEntries(Object.values(readState().users).map(person => [person.id, person.name])),
  mayApprove: userId => maySocial(readState().users[userId]) });
const socialRunner = () => socialRun ??= createSocialRunner({ store: social(), settings: () => socialCfg(), fetch: globalThis.__servantSocialFetch });
const socialGuide = () => wiki().ensureMarked(SOCIAL_GUIDE_KIND, SOCIAL_GUIDE);
let readmeCache;
const projectReadme = repo => (readmeCache ??= createReadmeCache(path.join(DATA_DIR, "readme-cache")))(repo);
const projects = () => projectStore ??= createProjectStore(loadConfig().projectsFile);
const vibeProject = () => projects().byId(VIBE_PROJECT);
// Where a prototype is served: this server, through its public address. Chats from before Prototyping moved onto the
// server (no `hosted`) keep their old GitHub Pages link.
function prototypePreview(chat) {
  if (!chat.vibeFolder) return "";
  if (chat.hosted === "server") { const origin = loadConfig().publicUrl.replace(/\/+$/, ""); return origin ? `${origin}/p/${chat.vibeFolder}/` : ""; }
  return vibePreview(vibeProject(), chat);
}
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
const RESEARCHER_RULES = "This person is a user researcher. You can search the web, read pages and files they attach, look at images, use skills and plan, and explain what you found with sources. You cannot use GitHub in any way: no gh, no git, no issues, no pull requests, no repositories. If they ask for that, say that GitHub is not available to them and offer to help another way, or to ask a software engineer. You cannot run commands or read or write files.";
const PRODUCT_MANAGER_RULES = "This person is a product manager. You can read and search the project's GitHub repo, issues, pull requests and discussions (with gh), file, label, comment on and close issues, write specs and release notes, research on the web, and plan. Don't change code, push, merge or open pull requests, and say so kindly if asked.";
const BUG_REPORTER_RULES = "This person is a tester. The only thing you do for them is file GitHub issues (with gh) in the project's repo: ask what happened, what they expected and the steps, then open one clear issue and share the link. Don't change code, push, or do any other work, and say so kindly if asked.";
function chatContext(chat) {
  const tier = agentTierOf(readState().users[chat.userId]);
  const tier1 = tier === 1 ? BUG_REPORTER_RULES : tier === 5 ? PRODUCT_MANAGER_RULES : "";
  // A researcher's chat never carries a project's repo, workflow or GitHub rules.
  if (chat.role === "researcher" || tier === RESEARCHER_TIER) return RESEARCHER_RULES;
  const base = chatContextBase(chat);
  return [base, tier1].filter(Boolean).join("\n\n");
}
function chatContextBase(chat) {
  const data = projects().read();
  const project = chat.projectId ? data.projects.find(p => p.id === chat.projectId) : null;
  if (!project) return "";
  const users = readState().users;
  const access = accessOf(project, users[chat.userId], users, data.people);
  // Whoever started the chat must still be in the project; otherwise the chat carries no project context.
  if (chat.mode !== "vibe" && !access.visible) return "";
  return projectInstructions(project, { chat, asker: users[chat.userId], level: access.level, files: projectFiles(), full: agentRole(chat.role, loadConfig()) === "owner", users, people: data.people, prototypes: { dir: PROTOTYPES_DIR, url: prototypePreview(chat), kit: expandPath(project.path), backup: agentRole(chat.role, loadConfig()) === "owner" } });
}
const documents = () => documentStore ??= createDocumentStore(path.join(DATA_DIR, "chat-files"), { keep: () => recordsPreservationEnabled(loadConfig().recordsPreservation) });
let usageDb;
let recordings = null;
let fileDropStore;
const fileDrop = () => fileDropStore ??= createFileDrop({ directory: path.join(DATA_DIR, "file-drop"), folder: () => loadConfig().fileDropDir });
let todosStore = null;
let workChatStarter = null;
let otaServer;
const ota = () => otaServer ??= createOta({ dir: path.join(DATA_DIR, "ota") });
let entitlementDb = null, egressDb = null, egressProxy = null, reviewDb = null, tokenDb = null;
const accessTokens = () => tokenDb ??= createAccessTokens(path.join(DATA_DIR, "access-tokens.db"));
// Prototypes shared with a business owner by email, and the comments they left (docs/prototype-reviews.md).
const prototypeReviews = () => reviewDb ??= createPrototypeReviews(path.join(DATA_DIR, "prototype-reviews.db"));
const sendMail = (message, settings) => (globalThis.__servantEmailSend || commandSender)(message, settings);
const publicOrigin = cfg => String(cfg.publicUrl || "").replace(/\/+$/, "");
// A handful of tries a minute per network address is plenty for one person reading a prototype, and stops guessing at links.
const reviewHits = new Map();
function reviewAllowed(ip, limit = 60) {
  const at = now();
  if (reviewHits.size > 5000) for (const [k, v] of reviewHits) if (at - v.start > 60_000) reviewHits.delete(k);
  const h = reviewHits.get(ip);
  if (!h || at - h.start > 60_000) { reviewHits.set(ip, { start: at, n: 1 }); return true; }
  return ++h.n <= limit;
}
/**
 * The business owner's side: /review/<link> and its calls, plain HTTPS, no account. The link alone shows who shared
 * what and a masked address; the prototype and the comments need a code confirmed from that address.
 */
async function handleReview(req, res, url, cfg) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "review" || parts.length < 2 || parts.length > 3) return false;
  const method = req.method || "GET";
  const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }); res.end(JSON.stringify(value)); return true; };
  const refuse = (status, code, message) => json(status, { error: { code, message } });
  if (!reviewAllowed(clientIp(req))) return refuse(429, "rate_limited", "Too many tries. Wait a minute");
  const reviews = prototypeReviews();
  const token = parts[1];
  const share = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? reviews.byToken(token) : null;
  const state = readState();
  const chat = share && state.chats[share.chatId];
  const sharer = share && state.users[share.createdBy];
  // The code of the invite that came with a share, while it can still be used; else "".
  const liveInvite = current => {
    const code = reviews.joinCode(current.id);
    const invite = code ? readState().invites[sha256(normalizeCode(code))] : null;
    return invite && !invite.usedAt && !invite.revokedAt && invite.expiresAt > now() ? code : "";
  };
  const ofApp = share?.kind === "app";
  // A share only works while its chat, its prototype and the person who shared it are all still here. A share of a
  // project's app works while the app is on the server and the person who shared it can still see the project.
  const open = !!share && !!sharer && !isRemoved(sharer) && (ofApp
    ? !!projectFor(sharer, share.projectId, state.users) && !!previewInfo(APP_PREVIEWS_DIR, share.projectId)
    : !!chat && !chat.deletedAt && chat.vibeFolder === share.folder);
  if (parts.length === 2) {
    if (method !== "GET" && method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return true; }
    const nonce = crypto.randomBytes(16).toString("base64");
    res.writeHead(open ? 200 : 404, reviewPageHeaders(nonce));
    res.end(method === "HEAD" ? undefined : reviewPage({ nonce, theme: cfg.theme, ended: !open, title: share?.title, sharedBy: sharer?.name, masked: share ? maskEmail(share.email) : "", serverName: cfg.name, app: ofApp,
      // The prototype shows as soon as the link is opened; the code is for commenting, and for joining when invited.
      prototype: open ? (ofApp ? `/a/${share.projectId}/` : `/p/${share.folder}/`) : "", invited: open && !!liveInvite(share) }));
    return true;
  }
  if (!open) return refuse(404, "not_found", `This link doesn't work. Ask for the ${ofApp ? "app" : "prototype"} to be shared with you again`);
  const body = async () => {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16384) throw requestError(413, "too_large", "That is too long"); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw requestError(400, "bad_request", "That request could not be read"); }
  };
  const settings = { ...emailSettings(cfg), domains: reviewDomains(emailSettings(cfg)) };
  const bearer = String(req.headers.authorization || "").startsWith("Bearer ") ? String(req.headers.authorization).slice(7).trim() : "";
  // The reviewer is told when their comment was handed to the agent, and nothing about what came of it.
  const view = c => ({ id: c.id, page: c.page, x: c.x, y: c.y, anchor: c.anchor, text: c.text, createdAt: c.createdAt, ...(c.askedAt ? { asked: true } : {}) });
  const what = ofApp ? "app preview" : "prototype";
  // An invite onto the server that came with the share (an owner's choice), offered only here, after the person has
  // confirmed the address is theirs, and only while it is unused and not out of date.
  const joinFor = current => { const code = liveInvite(current); return code ? joinWebLink(code, cfg) || pairLink(code, cfg) : null; };
  const opened = current => { const join = joinFor(current); return { prototype: ofApp ? `/a/${current.projectId}/` : `/p/${current.folder}/`, ...(ofApp ? { app: true } : {}), title: current.title, comments: reviews.comments({ shareId: current.id }).map(view), ...(join ? { join, team: cfg.name } : {}) }; };
  try {
    // The code always goes to the address the prototype was shared with. The visitor never chooses where it is sent.
    if (method === "POST" && parts[2] === "code") {
      const sent = await emailVerifier.start({ email: share.email, inviteKey: `review:${share.id}`, mail: (code, minutes) => ({
        subject: `Your code to see "${share.title}" is ${code}`,
        text: `Your code to see the ${what} "${share.title}" that ${sharer.name} shared with you is ${code}. It works for ${minutes} minutes. If you didn't ask for it, ignore this email.` }) }, settings);
      return json(200, { challenge: sent.id, expiresInSeconds: 600 });
    }
    if (method === "POST" && parts[2] === "verify") {
      const given = await body();
      emailVerifier.check({ id: given.challenge, code: given.code, inviteKey: `review:${share.id}` });
      const session = reviews.startSession(share.id);
      // They proved the address is theirs. An invite that came with the share remembers it, so joining with that
      // invite gives them an account with this work email on it and does not ask for a second code.
      const code = liveInvite(share);
      if (code) mutateState(s => { const invite = s.invites[sha256(normalizeCode(code))]; if (invite) invite.verifiedEmail = share.email; });
      return json(200, { session: session.secret, expiresAt: session.expiresAt, ...opened(share) });
    }
    if (parts[2] === "comments") {
      const current = reviews.session(token, bearer);
      if (!current) return refuse(401, "unauthorized", "Confirm your email again to carry on");
      if (method === "GET") return json(200, opened(current));
      if (method === "POST") {
        const given = await body();
        const comment = reviews.comment(current, given);
        if (ofApp) appCommented(current, comment, sharer); else reviewCommented(current, comment, sharer, cfg);
        return json(201, { comment: view(reviews.commentOf(comment.id, current.chatId) || comment) });
      }
    }
  } catch (error) {
    if (!error.status) throw error;
    return refuse(error.status, error.code || "bad_request", error.message);
  }
  return refuse(404, "not_found", "No such route");
}
// A comment on a project's app preview from an outside reviewer. An app preview has no chat of its own, so the comment
// comes back to the preview screen of the person who shared it, who decides what to do with it there, and they are
// told. Nothing is filed as a to-do and nothing goes to the agent by itself. The comment is already saved.
function appCommented(share, comment, sharer) {
  try { push?.enqueue({ kind: "note", eventId: id("rev"), to: [sharer.id], projectId: share.projectId, title: `Comment on ${share.title}`, body: `${share.email}: ${comment.text}` }); }
  catch (error) { console.error("[servant] app review comment alert", error.message); }
}
/**
 * Hand a reviewer's comment to the agent, as a message in the prototype's own chat from the person who shared it.
 * `by` is "auto" (the sharer switched that on for this reviewer) or the sharer's id (they pressed the button).
 * A comment is handed over once. Returns { turn } or { refused: why }, and never throws for an ordinary refusal.
 */
function askAgentAboutComment(share, comment, sharer, by, cfg) {
  const reviews = prototypeReviews();
  const state = readState();
  const chat = state.chats[share.chatId];
  if (!chat || chat.deletedAt || chat.userId !== sharer.id || !chat.hermesSessionId) return { refused: "This prototype's chat can't take a message right now" };
  if (noAgent(sharer) || usageStore().overLimit(sharer)) return { refused: limitText(sharer) };
  // The turn runs as the sharer, from a device of theirs that is still signed in, like any message they send.
  const device = Object.values(state.devices).find(d => d.userId === sharer.id && !d.revokedAt);
  if (!device) return { refused: "You have no signed-in device for the agent to work from" };
  if (!agentTurns) return { refused: "The agent isn't running" };
  if (!reviews.claimForAgent(comment.id, by)) return { refused: "The agent was already asked to work on this comment" };
  try {
    const link = publicOrigin(cfg) ? `${publicOrigin(cfg)}/p/${share.folder}/${comment.page === "index.html" ? "" : comment.page}` : "";
    const turn = agentTurns.enqueue({ chat, user: sharer, device, text: commentRequest({ share, comment, link }).slice(0, INLINE_MESSAGE_CHARS), attachments: [], requestId: `review-${comment.id}` });
    reviews.linkTurn(comment.id, turn.id);
    mutateState(s => { const active = s.chats[chat.id]; if (active) { active.updatedAt = now(); delete active.archivedAt; } });
    if (privateTimer) void agentTurns.processNext();
    return { turn };
  } catch (error) {
    reviews.releaseClaim(comment.id);
    if (!error?.status) console.error("[servant] review comment to agent", error?.message || error);
    return { refused: error?.status ? error.message : "The agent couldn't be asked. Try again" };
  }
}
// A reviewer's comment is an outsider's words. With nobody reading it first, it may start the agent only when that
// agent has to ask before it reads or changes files or GitHub (the built-in entitlement checks, docs/entitlements.md)
// and the sharer is not an owner, whose agent is never held back. Otherwise the comment waits in the chat for the
// sharer, who reads it and presses "Ask Agent to work on this" themselves.
const autoWorkChecked = (cfg, sharer) => capabilitiesOn(cfg) && sharer?.role !== "owner";
// A comment arrived: it shows in the prototype's own chat, where the person who shared it reads it and decides what
// to do (answer the reviewer themselves, change the prototype, hand it to the agent, or nothing), and they are told.
// When they switched it on for this reviewer, the agent starts on it straight away. Nothing is filed anywhere else:
// the chat is the one place a prototype's work happens. The comment itself is already saved.
function reviewCommented(share, comment, sharer, cfg) {
  // A reviewer can't run up the sharer's agent use: past a number of comments an hour, the rest wait for the sharer.
  let started = false;
  if (share.autoWork && autoWorkChecked(cfg, sharer) && prototypeReviews().autoWorkedSince(share.id, now() - 3_600_000) < AUTO_WORK_PER_HOUR) {
    try { started = !!askAgentAboutComment(share, comment, sharer, "auto", cfg).turn; } catch (error) { console.error("[servant] review comment auto-work", error?.message || error); }
  }
  try { push?.enqueue({ kind: "note", eventId: id("rev"), to: [sharer.id], chatId: share.chatId, title: started ? `Agent is working on a comment on ${share.title}` : `Comment on ${share.title}`, body: `${share.email}: ${comment.text}` }); }
  catch (error) { console.error("[servant] review comment alert", error.message); }
}
/**
 * Share one chat's prototype with one address and send the link. `asker` is who pressed the button or made the
 * request; the share belongs to the chat's own person, so comments arrive in their chat whoever sent the link.
 * Resolves to the share, or throws { status, code, message }.
 */
/**
 * A footnote for someone who has never seen Servant: what it is, in two or three sentences, at the end of a message
 * or an email that invites them to review a prototype. With `joining`, it also says what joining would add.
 */
export const servantFootnote = (team, joining) => `What is Servant? It is where ${team} works: secure team messaging with an AI agent that builds and changes prototypes like this one. Reviewing needs no account or install; your comments go straight to the person who built it.${joining ? " If you join, you can ask the agent for changes yourself, build prototypes of your own and talk with the team, in a browser or the phone and Mac apps." : ""}`;
// The access level called "Business owner" (usage.mjs AGENT_TIERS): where someone invited to review a prototype starts.
const BUSINESS_OWNER_TIER = 2;
async function sharePrototype(chat, email, asker, cfg, { autoWork = false, name = "", joinCode = "" } = {}) {
  const reviews = prototypeReviews();
  const origin = publicOrigin(cfg), settings = emailSettings(cfg);
  if (!origin) throw requestError(400, "not_set_up", "This server has no public address yet, so there is no link to send. Ask an owner to set it up");
  if (!settings.mailer?.command && !globalThis.__servantEmailSend) throw requestError(400, "not_set_up", "This server can't send email yet, so the link can't be sent. Ask an owner to set up email");
  const made = reviews.share({ chatId: chat.id, folder: chat.vibeFolder, title: chat.title, email, by: chat.userId, domains: reviewDomains(settings), autoWork, joinCode });
  try {
    await sendMail({ to: made.share.email, code: "", minutes: 0, subject: `${asker.name} shared a prototype with you: ${made.share.title}`,
      text: `${name ? `Hi ${name},\n\n` : ""}${asker.name} shared the prototype "${made.share.title}" with you on ${cfg.name} and would like your comments.\n\nOpen it here: ${origin}/review/${made.token}\n\nIt opens straight away, with nothing to install. To leave a comment, confirm this email address with the code that page offers to send you, then right-click anywhere on the prototype.${joinCode ? `\n\nYou have also been invited to join the team in Servant. Once you have typed that code, Join ${cfg.name} is on the same page if you would like to do more than review. The invitation is good for a week.` : ""}\n\n${servantFootnote(cfg.name, !!joinCode)}\n\nIf you weren't expecting this, ignore this email.` }, settings);
  } catch (error) {
    // A link nobody received is ended, so it can't be found later by someone else.
    reviews.end(made.share.id, chat.id, asker.id);
    console.error("[servant] review share email failed:", error?.message || error);
    throw requestError(502, "email_send_failed", "Couldn't send the email. Try again, or ask an owner to check email setup");
  }
  // The link is handed back for one use only: a message the asker sends the person themselves (the token API). It
  // opens nothing by itself; the prototype still needs a code confirmed from the address it was shared with.
  return { ...made.share, link: `${origin}/review/${made.token}` };
}

/**
 * /api/v1/: what a personal access token can do (docs/access-tokens.md). Plain HTTPS with `Authorization: Bearer
 * svt_…`, for a shell or a script where the app and its encryption can't run. It is a short list on purpose: who
 * you are, the prototypes you can see, sharing one for review, and a message to your own agent with its answer.
 */
async function handleTokenApi(req, res, url, parts, cfg) {
  const method = req.method || "GET";
  const settings = accessTokenSettings(cfg.accessTokens);
  // Shut means absent: the same answer as any address this server doesn't have.
  if (!settings.enabled) return fail(res, 404, "not_found", `This server has no ${method} ${url.pathname}`);
  // How to use it, for a person or a coding agent to read. No token needed, and nothing about this server's people in it.
  if (method === "GET" && parts.length === 2) {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
    return res.end(apiGuide({ origin: publicOrigin(cfg) || `http://${req.headers.host || "127.0.0.1"}`, name: cfg.name })), undefined;
  }
  const presented = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ""))?.[1] || "";
  const held = accessTokens().check(presented);
  const state = readState();
  const user = held && state.users[held.userId];
  if (!held || !user || isRemoved(user)) return fail(res, 401, "unauthorized", "That token isn't valid. It may have expired or been revoked. Make a new one in Servant under You, then Access tokens");
  if (!accessTokens().allow(held.id, settings.requestsPerMinute)) { res.setHeader("Retry-After", "60"); return fail(res, 429, "rate_limited", "Too many requests with this token. Wait a minute"); }
  const users = state.users;
  // A prototype someone built on this server. You can see your own, ones shared with everyone, and (as an owner) all.
  const isPrototype = chat => chat && !chat.deletedAt && chat.mode === "vibe" && chat.hosted === "server" && !!chat.vibeFolder && !!users[chat.userId] && !isRemoved(users[chat.userId]);
  const canSee = chat => chat.userId === user.id || user.role === "owner" || chat.shared === true;
  // Sharing is the chat's own person's, and a server owner's on their behalf.
  const canShare = chat => chat.userId === user.id || user.role === "owner";
  const prototypeView = chat => {
    const shares = canShare(chat) ? prototypeReviews().forChat(chat.id).filter(share => !share.endedAt).map(share => ({ email: share.email, opened: !!share.verifiedAt, comments: prototypeReviews().comments({ shareId: share.id }).length })) : undefined;
    return { id: chat.id, title: chat.title, by: users[chat.userId].name, mine: chat.userId === user.id, url: prototypePreview(chat), updatedAt: chat.updatedAt, canShare: canShare(chat), ...(shares ? { sharedWith: shares } : {}) };
  };
  const body = async () => {
    const raw = await readBody(req, 64 * 1024);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw requestError(400, "bad_request", "Send a JSON object");
    return raw;
  };
  try {
    if (method === "GET" && parts[2] === "me" && parts.length === 3) return send(res, 200, { name: user.name, role: user.role, server: cfg.name });
    if (method === "GET" && parts[2] === "prototypes" && parts.length === 3) {
      const q = (url.searchParams.get("q") || "").toLowerCase().trim();
      const found = Object.values(state.chats).filter(chat => isPrototype(chat) && canSee(chat)).map(prototypeView)
        .filter(p => !q || `${p.title} ${p.by}`.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
      return send(res, 200, { prototypes: found });
    }
    // Send a prototype to one or more work addresses for review. Each gets the same emailed link and code as from the app.
    if (method === "POST" && parts[2] === "prototypes" && parts[4] === "shares" && parts.length === 5) {
      const given = await body();
      const chat = state.chats[parts[3]];
      if (!isPrototype(chat) || !canSee(chat)) return fail(res, 404, "not_found", "No such prototype. GET /api/v1/prototypes lists the ones you can see");
      if (!canShare(chat)) return fail(res, 403, "forbidden", `Only ${users[chat.userId].name}, who made this prototype, or a server owner can share it`);
      // Addresses alone, or people with a name to greet them by: { "people": [{ "name": "Jo Park", "email": "…" }] }.
      const asked = Array.isArray(given.people) ? given.people : Array.isArray(given.emails) ? given.emails.map(email => ({ email })) : typeof given.email === "string" ? [{ email: given.email }] : null;
      if (!asked || !asked.length || asked.length > 10 || asked.some(p => !p || typeof p !== "object" || typeof p.email !== "string" || (p.name !== undefined && typeof p.name !== "string"))) {
        return fail(res, 400, "bad_request", 'Send emails: a list of one to ten work addresses, or people: a list of { "name", "email" }');
      }
      // "invite": true also invites each person onto the server, as a business owner, so they can go past the full
      // screen prototype if they wish. Only a server owner brings people onto the server, here as in the app.
      const inviting = given.invite === true;
      if (given.invite !== undefined && typeof given.invite !== "boolean") return fail(res, 400, "bad_request", "invite is true or false");
      if (inviting && user.role !== "owner") return fail(res, 403, "forbidden", "Only a server owner can invite someone onto the server. Share the prototype without invite, or ask an owner");
      if (inviting && asked.some(p => !String(p.name ?? "").trim())) return fail(res, 400, "bad_request", 'To invite someone, give their name: people: [{ "name", "email" }]');
      const results = [];
      for (const person of asked) {
        const name = String(person.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
        try {
          const address = normalizeEmail(person.email);
          const member = inviting && address ? Object.values(users).find(u => !isRemoved(u) && u.email && u.email.toLowerCase() === address) : null;
          // A single-use invite in their name, good for a week. Made only once the address is known to be allowed.
          let joinCode = "";
          if (inviting && !member && address && emailAllowed(address, reviewDomains(emailSettings(cfg)))) joinCode = createInvite({ name, role: "member", agentTier: BUSINESS_OWNER_TIER, createdBy: user.id });
          const share = await sharePrototype(chat, person.email, user, cfg, { name, joinCode });
          // Something to paste into a chat or an email of your own, beside the one Servant sent. The name is used
          // here and in the greeting of that email; it is not kept.
          const message = `${name ? `Hi ${name.split(" ")[0]}, ` : ""}I've shared the prototype "${chat.title}" with you for review: ${share.link}\n\nIt opens straight away. To leave a comment, confirm your email (${share.email}) with the code that page offers to send you, then right-click anywhere on the prototype.${joinCode ? `\n\nYou're also invited to join the team in Servant. Once you've typed that code, "Join ${cfg.name}" is on the same page if you'd like to do more than review. The invitation is good for a week.` : ""}\n\n${servantFootnote(cfg.name, !!joinCode)}`;
          // One link. The invite onto the server is not in the message: it is offered on the review page, after the code.
          results.push({ email: share.email, ...(name ? { name } : {}), sent: true, link: share.link, ...(joinCode ? { invited: true } : {}), ...(member ? { alreadyMember: true } : {}), message });
        } catch (error) { if (!error?.status) throw error; results.push({ email: String(person.email).slice(0, 254), ...(name ? { name } : {}), sent: false, error: error.message }); }
      }
      return send(res, results.some(r => r.sent) ? 201 : 400, { prototype: { id: chat.id, title: chat.title, by: users[chat.userId].name }, results });
    }
    // A message to your own agent: a new chat, or one more message in a chat of yours. The answer is read back below.
    if (method === "POST" && parts[2] === "agent" && parts.length === 3) {
      const given = await body();
      const text = typeof given.text === "string" ? given.text.trim() : "";
      if (!text) return fail(res, 400, "bad_request", "Send text: what you want to ask or tell your agent");
      if (text.length > INLINE_MESSAGE_CHARS) return fail(res, 413, "too_long", "That message is too long");
      if (noAgent(user) || usageStore().overLimit(user)) return fail(res, 429, "usage_limit", limitText(user));
      // The same two checks a message typed in the app gets: no credentials in chat, and a warning before personal information.
      const typed = tokenRefusal(text);
      if (typed) return fail(res, 400, "secret_in_chat", typed);
      if (given.confirmPii !== true && piiWarningEnabled(cfg.piiWarning)) {
        const warn = await screenMessage(text, cfg.piiWarning);
        if (warn) return fail(res, 409, "pii_warning", `${warn.message} Send again with "confirmPii": true to send it anyway`, { types: warn.types || [] });
      }
      const device = Object.values(state.devices).find(d => d.userId === user.id && !d.revokedAt);
      if (!device) return fail(res, 409, "no_device", "Sign in to Servant on a phone or computer once before using a token: the agent works from a signed-in device of yours");
      if (given.chatId !== undefined) {
        const chat = state.chats[String(given.chatId)];
        if (!chat || chat.deletedAt || chat.userId !== user.id || !chat.hermesSessionId) return fail(res, 404, "not_found", "No such chat of yours");
        const turn = agentTurns.enqueue({ chat, user, device, text, attachments: [] });
        mutateState(s => { const active = s.chats[chat.id]; if (active) { active.updatedAt = now(); delete active.archivedAt; } });
        if (privateTimer) void agentTurns.processNext();
        return send(res, 202, { chatId: chat.id, turnId: turn.id, status: turn.status, read: `/api/v1/agent/${chat.id}` });
      }
      if (!workChatStarter) return fail(res, 503, "agent_unavailable", "The agent isn't running on this server");
      let chat;
      try { chat = await workChatStarter({ userId: user.id, deviceId: device.id, title: text.replace(/\s+/g, " ").slice(0, 60), where: "an access token", transcript: text, shared: false, asWritten: true }); }
      catch (error) { if (error?.status) throw error; return fail(res, 503, "agent_unavailable", "The agent didn't take the message. Try again in a moment"); }
      if (privateTimer) void agentTurns.processNext();
      return send(res, 202, { chatId: chat.id, turnId: chat.firstTurnId, status: "queued", read: `/api/v1/agent/${chat.id}` });
    }
    // Where a chat of yours stands: whether the agent is still working, and what was said, newest last.
    if (method === "GET" && parts[2] === "agent" && parts.length === 4) {
      const chat = state.chats[parts[3]];
      if (!chat || chat.deletedAt || chat.userId !== user.id) return fail(res, 404, "not_found", "No such chat of yours");
      const turns = agentTurns.latest(chat.id).reverse();
      const working = turns.some(t => ["queued", "running", "waiting_for_approval", "stopping"].includes(t.status));
      return send(res, 200, { chatId: chat.id, title: chat.title, working, needsApproval: turns.some(t => t.status === "waiting_for_approval"),
        turns: turns.map(t => ({ id: t.id, status: t.status, text: t.text, ...(t.assistantText ? { reply: t.assistantText } : {}) })) });
    }
  } catch (error) {
    if (!error?.status) throw error;
    return fail(res, error.status, error.code || "bad_request", error.message);
  }
  return fail(res, 404, "not_found", `This server has no ${method} ${url.pathname}. GET /api/v1 says what there is`);
}

// One-time codes an automation asks its own person for (docs/code-requests.md). Memory only: a restart forgets them.
const codeRequests = createCodeRequests({ clock: () => now() });
// Entitlements (docs/entitlements.md): who holds which named access, and who decides. The agent's outbound gate asks here.
const entitlementStore = () => entitlementDb ??= createEntitlements(path.join(DATA_DIR, "entitlements.db"), {
  known: userId => { const u = readState().users[userId]; return !!u && !isRemoved(u); },
  isOwner: userId => readState().users[userId]?.role === "owner",
  manages: (by, userId) => { const state = readState(); return managerOf(state, state.users[userId])?.id === by; },
  grantDays: () => loadConfig().entitlementGrantDays,
});
// Everyone but an owner has a manager, who decides their entitlement requests: whoever was chosen for them, else
// whoever invited them, else the server's first owner. Someone who has left is skipped.
function managerOf(state, user) {
  if (!user || user.role === "owner" || isRemoved(user)) return null;
  const here = userId => { const m = userId && state.users[userId]; return m && !isRemoved(m) && m.id !== user.id ? m : null; };
  return here(user.managerId) || here(user.invitedBy) || Object.values(state.users).filter(u => u.role === "owner" && !isRemoved(u)).sort((a, b) => a.createdAt - b.createdAt)[0] || null;
}
// Following managers upward from `candidate` must never come back to `user`: nobody is, even indirectly, their own manager.
function wouldLoop(state, user, candidate) {
  const seen = new Set();
  for (let at = candidate; at && !seen.has(at.id); at = managerOf(state, at)) { if (at.id === user.id) return true; seen.add(at.id); }
  return false;
}
function setManager(state, user, manager) {
  if (user.role === "owner") throw requestError(400, "bad_request", "An owner has no manager");
  if (!manager || isRemoved(manager)) throw requestError(400, "bad_request", "A manager must be someone on this server");
  if (manager.id === user.id) throw requestError(400, "bad_request", "Nobody is their own manager");
  if (wouldLoop(state, user, manager)) throw requestError(400, "manager_loop", `${manager.name} reports up to ${user.name}, so can't also be their manager`);
  user.managerId = manager.id;
}
const egressStore = () => egressDb ??= createEgressStore(path.join(DATA_DIR, "egress.db"));
const egressOn = cfg => egressSettings(cfg?.agentEgress).mode === "ask";
// With the gate on, each turn tells the bridge whose it is: a token the sandboxed commands of that chat present to the
// gate (hermes_egress.py). `scope` is the chat or thread; its token never changes for the same person.
const capabilitiesOn = cfg => capabilitySettings(cfg?.agentCapabilities).mode === "ask";
// The same token also lets the bridge ask, before a tool call, whether this person may read or change files or GitHub
// (agentUse below). `X-Servant-Door` is where to ask: the local listener the network gate uses.
const doorPort = cfg => egressProxy?.port || egressSettings(cfg?.agentEgress).port;
const egressHeaders = (cfg, userId, scope) => (egressOn(cfg) || capabilitiesOn(cfg)) && userId
  ? { "X-Servant-Egress-Token": egressStore().tokenFor(userId, scope), ...(capabilitiesOn(cfg) ? { "X-Servant-Door": String(doorPort(cfg)) } : {}) } : {};
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
// A full agent that can't ask before acting must not be handed a turn while the checks are on.
async function requireEntitlementChecks(cfg, up, user) {
  if (!capabilitiesOn(cfg) || user?.role === "owner") return;
  if (!(await supportsEntitlementChecks(up))) throw requestError(502, "agent_error", "The agent on this server can't check entitlements before acting, so it can't work for you yet. Ask an owner to update the agent's bridge");
}
/**
 * The bridge asks, just before a tool call: may this person's agent do this? `needs` are built-in entitlements, the
 * weightiest first. Each is allowed when the person holds it or an "allow once" is waiting; otherwise their manager
 * is asked (once per request) and this waits a while for the answer. Owners are the ones who answer, so their own
 * agent is not held back. Every checked call is written to the agent action log first; one that can't be recorded is
 * refused. Answers { verdict: "allow" | "deny" | "wait", message } for the agent to read.
 */
/** The project a chat's work belongs to, as { id, name }, or null. A project that no longer exists scopes nothing. */
function agentProject(chat) {
  if (!chat?.projectId || !validProjectId(chat.projectId)) return null;
  const found = projects().byId(chat.projectId);
  return found ? { id: found.id, name: found.name } : null;
}
async function agentUse(body, config = loadConfig) {
  const who = egressStore().whose(body?.token);
  const state = readState();
  const person = who && state.users[who.userId];
  if (!person || isRemoved(person)) return { status: 403, answer: { verdict: "deny", message: "Servant doesn't know whose turn this is, so it can't be allowed." } };
  const needs = (Array.isArray(body.needs) ? body.needs : []).filter(c => NATIVE.some(n => n.capability === c)).slice(0, NATIVE.length);
  if (!capabilitiesOn(config()) || !needs.length) return { status: 200, answer: { verdict: "allow" } };
  const store = entitlementStore();
  const detail = typeof body.detail === "string" ? body.detail : "";
  // Every checked tool call goes in the action log with how it ended, the owner's own included.
  const logged = (verdict, answer) => {
    try { store.logAction({ userId: person.id, chatId: who.chatId, needs, verdict, detail }); }
    catch (error) {
      // An action that can't be recorded doesn't happen.
      console.error("[servant] agent action log", error.message);
      return { status: 200, answer: { verdict: "deny", message: "Servant couldn't record this, so it wasn't done. Tell the person, and try again in a moment." } };
    }
    return { status: 200, answer };
  };
  if (person.role === "owner") return logged("allowed-owner", { verdict: "allow" });
  // Work in a project's chat is asked about, allowed and recorded for that project: holding "Filesystem write" for
  // one project says nothing about another. A chat outside any project uses the entitlement for every project.
  const project = agentProject(state.chats[who.chatId]);
  const until = Date.now() + capabilitySettings(config().agentCapabilities).waitSeconds * 1000;
  let told = false;
  for (;;) {
    // Look at everything the action needs before spending anything: a single allowance for one entitlement is not
    // used up while another is still waiting. Whatever is missing is asked for together.
    const looked = needs.map(capability => ({ capability, ...store.use(person.id, capability, detail, { consume: false, project }) }));
    const manager = managerOf(readState(), person);
    const refused = looked.find(r => r.verdict === "deny");
    if (refused) return logged("denied", { verdict: "deny", capability: refused.capability, message: `Servant blocked this: ${person.name} asked for ${refused.entitlement.name} and was declined. Tell them so, and don't look for another way to do it. They can ask again in Servant under Entitlements.` });
    const missing = looked.filter(r => r.verdict === "wait");
    for (const r of missing) if (r.fresh) tellAbout([manager?.id], "Entitlement request", `${person.name}'s agent needs ${r.entitlement.name}`);
    // The person watching the reply sees why it has stopped, not "Working".
    if (missing.length && !told) { told = true; try { agentTurns?.noteForChat(who.chatId, `Waiting for ${manager?.name || "an owner"} to allow ${missing.map(r => r.entitlement.name).join(" and ")}`); } catch { /* the wait still happens */ } }
    if (!missing.length) {
      const used = needs.map(capability => store.use(person.id, capability, detail, { project }));
      // Something changed between looking and using (taken back in that instant): look again.
      if (used.some(r => r.verdict !== "allow")) continue;
      return logged(used.some(r => r.once) ? "allowed-once" : "allowed", { verdict: "allow" });
    }
    if (Date.now() >= until || !capabilitiesOn(config())) {
      const names = missing.map(r => r.entitlement.name).join(" and ");
      return logged("waiting", { verdict: "wait", capability: missing[0].capability, message: `Servant is holding this: ${manager?.name || "An owner"} has been asked to allow ${names} for ${person.name} and hasn't answered yet. Tell ${person.name} you are waiting for that, and try again once it is allowed. Don't look for another way to do it.` });
    }
    await sleepMs(Math.min(1000, Math.max(50, until - Date.now())));
  }
}
// Requests the bridge makes to the local listener itself: POST /use (may this person's agent do this?) and
// POST /connections (this person's own credentials, for this turn's commands). The token in the body says whose turn it is.
async function agentDoor(req, res, config) {
  const reply = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  if (req.method !== "POST" || (req.url !== "/use" && req.url !== "/connections")) return reply(404, { verdict: "deny", message: "Servant has no such check." });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) return reply(413, { verdict: "deny", message: "That check was too large." }); chunks.push(chunk); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return reply(400, { verdict: "deny", message: "That check could not be read." }); }
  const { status, answer } = req.url === "/connections" ? agentConnections(body, config) : await agentUse(body, config);
  return reply(status, answer);
}
// The agent working for someone outside an agent chat (a reply to @agent, a wiki page): counted while it lasts, so
// the gate can judge traffic that carries no token.
async function whileWorkingFor(cfg, userId, fn) {
  const done = egressOn(cfg) && userId ? egressStore().working(userId) : null;
  try { return await fn(); } finally { done?.(); }
}
// One alert to named people about an entitlement: who asked, what was decided, or what the agent was refused.
function tellAbout(to, title, body) {
  const people = [...new Set(to)].filter(Boolean);
  if (!people.length) return;
  try { push?.enqueue({ kind: "entitlement", eventId: id("ent"), to: people, title, body }); } catch (error) { console.error("[servant] entitlement alert", error.message); }
}
const ownerIds = state => Object.values(activeUsers(state)).filter(u => u.role === "owner").map(u => u.id);
// What the app shows for one entitlement: your own standing, and that of the people whose requests are yours to decide
// (your reports; everyone for an owner).
function entitlementView(entitlement, viewer, users) {
  const store = entitlementStore();
  const person = userId => ({ id: userId, name: users[userId]?.name || (userId === "server" ? "Servant" : "Former member") });
  const people = store.grants(entitlement.id).filter(g => g.userId !== viewer.id && store.decides(viewer.id, g.userId));
  return { id: entitlement.id, name: entitlement.name, description: entitlement.description, hosts: entitlement.hosts, confirmation: entitlement.confirmation,
    ...(entitlement.native ? { native: true, capability: entitlement.capability, ...(entitlement.projectId ? { projectId: entitlement.projectId } : {}), ...(entitlement.byRequest ? { byRequest: true } : {}) } : {}),
    mine: store.grant(entitlement.id, viewer.id), people: people.map(g => ({ ...g, name: person(g.userId).name, ...(g.decidedBy ? { decidedByName: person(g.decidedBy).name } : {}) })) };
}
// The agent was refused a host: tell whoever can do something about it, once (egress.mjs repeats at most daily).
function egressBlocked(attempt) {
  const state = readState();
  const who = state.users[attempt.userId]?.name || "Someone";
  const covering = entitlementStore().covering(attempt.host);
  if (covering.length) return tellAbout([attempt.userId], "Agent · access needed", `The agent couldn't reach ${attempt.host}. Ask for ${covering.map(e => e.name).join(" or ")} in Entitlements`);
  tellAbout(ownerIds(state), "Agent · blocked", `${who}'s agent tried ${attempt.host}, which no entitlement covers`);
}
const egressHint = host => {
  const covering = entitlementStore().covering(host);
  return covering.length ? `it needs the entitlement ${covering.map(e => JSON.stringify(e.name)).join(" or ")}, which the person you are working for does not hold. They can ask for it in Servant under Entitlements.`
    : "no entitlement covers it. The person can ask an owner to add it to one.";
};
// ---------- personal connections (docs/connections.md) ----------
// Each person's own credentials for the tools their agent works with. The values stay in connections.db, encrypted,
// and leave one way: the bridge asks for them at the start of that person's turn (agentConnections below) and puts
// them in the environment of that turn's commands.
let connectionDb = null, connectionDoor = null, toolsCache = null;
const connectionTools = () => {
  const raw = (glossaryConfig || loadConfig()).connections;
  const key = JSON.stringify(raw?.types ?? null);
  if (toolsCache?.key !== key) {
    const problems = [];
    toolsCache = { key, tools: toolCatalog(raw, problems) };
    for (const problem of problems) console.warn(`[servant] connections: tool type ${problem}. It was left out`);
  }
  return toolsCache.tools;
};
const connectionStore = () => connectionDb ??= createConnections({ file: path.join(DATA_DIR, "connections.db"), tools: connectionTools,
  known: userId => { const u = readState().users[userId]; return !!u && !isRemoved(u); } });
// Hides these people's saved values, and anything shaped like a known token, in text the agent wrote.
const replyCleaner = userIds => { const store = connectionStore(); return redactor(connectionTools(), [...new Set(userIds)].filter(Boolean).flatMap(userId => store.secrets(userId))); };
// A person's message with a token in it is not stored: what to tell them, or null.
const tokenRefusal = text => { const tool = tokenInText(text, connectionTools()); return tool ? tokenInChatMessage(tool) : null; };
// Which agent a person has, for connections: only the full agent runs commands, so only it can use one.
const connectionAgent = (user, cfg) => noAgent(user) ? "none" : agentLane(user, cfg) === "owner" ? "full" : "restricted";
/**
 * Where the bridge asks for a person's connection environment. With the network gate or the entitlement checks on
 * it is the listener they already use (inside the sandbox it is the only one the bridge can reach). Otherwise this
 * process starts a small listener of its own on localhost, the first time anyone needs it.
 */
async function connectionsDoorPort(cfg) {
  if (egressOn(cfg) || capabilitiesOn(cfg)) return doorPort(cfg);
  connectionDoor ??= new Promise((resolve, reject) => {
    const door = http.createServer((req, res) => { agentDoor(req, res, () => glossaryConfig || loadConfig()).catch(() => { if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }); res.end('{"error":"Servant could not answer"}'); }); });
    door.once("error", reject);
    door.listen(0, "127.0.0.1", () => { door.unref(); resolve(door); });
  });
  try { return (await connectionDoor).address().port; }
  catch (error) { connectionDoor = null; throw error; }
}
/**
 * What a full-agent turn is sent with: the gate's and the checks' headers, and for someone with a connection of
 * their own, where the bridge fetches it. The token says whose turn it is, so it is sent then even with the gate
 * and the checks off. A turn never fails over this: without it the agent simply starts without their credentials.
 */
async function turnHeaders(cfg, userId, scope) {
  const headers = egressHeaders(cfg, userId, scope);
  try {
    if (!userId || !connectionStore().has(userId)) return headers;
    const port = await connectionsDoorPort(cfg);
    return { ...headers, "X-Servant-Egress-Token": egressStore().tokenFor(userId, scope), "X-Servant-Connections-Door": String(port) };
  } catch (error) {
    console.error("[servant] connections: this turn starts without the person's own credentials:", error.message);
    return headers;
  }
}
const listed = words => words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0] || "";
/**
 * What the agent is told, each turn, about this person's connections: which ones its commands have, and how to ask
 * for one that is missing (only where Servant can show the form: an agent chat). Never a value.
 */
function connectionNotes(userId, chatId, { ask = true } = {}) {
  // An owner's agent is not held back (docs/entitlements.md) and already works with the server's own logins, so it is
  // told what is connected but never prompted to ask for a token.
  if (readState().users[userId]?.role === "owner") ask = false;
  const store = connectionStore();
  const declined = ask ? store.declinedIn(userId, chatId) : [];
  const lines = [];
  for (const tool of connectionTools()) {
    const mine = store.status(userId, tool.id);
    const what = tool.fields.length > 1 ? "credentials" : "token";
    if (mine) lines.push(`Your commands have this person's own ${tool.name} ${what} in ${listed(Object.keys(tool.env))}${mine.account ? ` (connected as ${mine.account})` : ""}. Use ${what === "token" ? "it" : "them"}; don't use any other ${tool.name} login. Never print or repeat the value.`);
    else if (declined.includes(tool.id)) lines.push(`This person declined to connect ${tool.name} in this chat. Don't ask again here; carry on without it, and say plainly what you can't do.`);
    else if (ask) lines.push(`Only when a task needs ${tool.name} for this person, ask for their ${what} by writing [[connect:${tool.id}]] on its own line; Servant shows them a secure form. Never ask them to paste a token in chat.`);
  }
  return lines.join("\n");
}
/**
 * The bridge asks, at the start of a turn: what does this person's environment hold? The token says whose turn it
 * is; nobody else's values are ever in the answer. Someone whose agent can't run commands gets nothing.
 */
function agentConnections(body, config = loadConfig) {
  const who = egressStore().whose(body?.token);
  const person = who && readState().users[who.userId];
  if (!person || isRemoved(person)) return { status: 403, answer: { error: "Servant doesn't know whose turn this is." } };
  if (connectionAgent(person, config()) !== "full") return { status: 200, answer: { env: {}, connections: [] } };
  const { env, types } = connectionStore().envFor(person.id, { chatId: who.chatId });
  return { status: 200, answer: { env, connections: types } };
}
// The "connect" parts of a chat's messages: the form the agent asked for, and where it stands. The person it was
// asked of sees the last four characters once saved; anyone else reading the chat sees only that it was asked.
function connectParts(chatId, viewer, cfg) {
  const store = connectionStore();
  const parts = new Map();
  for (const request of store.requestsForChat(chatId)) {
    const tool = request.messageId && store.tool(request.type);
    if (!tool) continue;
    const mine = request.userId === viewer?.id;
    const saved = mine ? store.status(request.userId, request.type) : null;
    // Saved and later removed: neither a form nor "saved".
    const status = saved ? "saved" : request.status === "saved" ? (mine ? "removed" : "saved") : request.status;
    const part = { requestId: request.id, mine, status, ...(saved ? { last4: saved.last4, ...(saved.account ? { account: saved.account } : {}) } : {}),
      ...(mine ? { agent: connectionAgent(viewer, cfg) } : {}), tool: publicTool(tool) };
    parts.set(request.messageId, [...(parts.get(request.messageId) || []), part]);
  }
  return parts;
}
const withConnect = (message, parts) => parts.has(message?.id) ? { ...message, connect: parts.get(message.id) } : message;
// A reply as Hermes keeps it, cleaned the way the copy saved here was: saved values hidden, markers taken out.
function cleanUpstreamMessage(message, hide) {
  if (!message || message.role !== "assistant") return message;
  const clean = text => readConnectMarkers(hide(text), connectionTools()).text;
  const mapped = value => typeof value === "string" ? clean(value) : Array.isArray(value) ? value.map(part => part && typeof part === "object" && typeof part.text === "string" ? { ...part, text: clean(part.text) } : typeof part === "string" ? clean(part) : part) : value;
  return { ...message, ...("content" in message ? { content: mapped(message.content) } : {}), ...("text" in message ? { text: mapped(message.text) } : {}) };
}
export const connectionsForTest = () => ({ store: connectionStore(), doorPort: cfg => connectionsDoorPort(cfg), headers: (cfg, userId, scope) => turnHeaders(cfg, userId, scope), notes: connectionNotes });
const usageStore = () => usageDb ??= createUsageStore(path.join(DATA_DIR, "usage.db"));
// Tier 0 has no agent; otherwise the message names this person's own daily limit.
const limitText = user => agentTierOf(user) === 0 ? noAgentMessage : limitMessage(usageStore().limitFor(user));
const noAgentMessage = "You don't have agent access yet. Ask an owner to turn it on";
const noAgent = user => !!user && agentTierOf(user) === 0;
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

  if (["/contact", "/contact/", "/contact/inbox.js"].includes(url.pathname)) {
    if (!normalizeFeatures(cfg.features).secureInbox) return fail(res, 404, "feature_off", featureOffMessage("secureInbox"));
    if (method !== "GET" && method !== "HEAD") return fail(res, 404, "not_found", "Not found");
    const script = url.pathname === "/contact/inbox.js";
    res.writeHead(200, { "Content-Type": script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    return res.end(method === "HEAD" ? undefined : script ? secureInboxScript() : secureInboxPage({ name: cfg.name, publicKey: secureTransport.publicKey, notices: inboxNotices.available() }));
  }

  // Over-the-air app updates: public, signed, app code only (see ota.mjs).
  // Invite entry points share an editable form and continue to the hosted web app.
  if (method === "GET" && (["/join", "/join/", "/welcome"].includes(url.pathname) || (url.pathname === "/" && url.searchParams.has("code")))) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
    return res.end(joinPage(cfg.downloads, cfg.webUrl, cfg.footer, cfg.theme));
  }
  if (url.pathname === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("User-agent: *\nDisallow: /p/\nDisallow: /a/\nDisallow: /review/\n"); return undefined; }
  // A prototype shared with a business owner (prototype-reviews.mjs): the page at /review/<link> and its calls.
  if (url.pathname.startsWith("/review/") && (await handleReview(req, res, url, cfg))) return undefined;
  // Prototypes built in Prototyping chats (prototypes.mjs): public by unguessable folder name, sandboxed.
  if (url.pathname.startsWith("/p/") && servePrototype(req, res, url, { dir: PROTOTYPES_DIR, kitDir: expandPath(vibeProject()?.path), ip: clientIp(req) })) return undefined;
  // A project's app, running in the browser for App preview (app-preview.mjs): public by project id, sandboxed, sample data only.
  if (url.pathname.startsWith("/a/") && serveAppPreview(req, res, url, { dir: APP_PREVIEWS_DIR, ip: clientIp(req) })) return undefined;
  // Public app-store pages remain readable without an account or JavaScript.
  const publicPages = { "/": landingPage, "/support": supportPage, "/privacy": privacyPage, "/terms": termsPage };
  const pagePath = url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "");
  if ((method === "GET" || method === "HEAD") && Object.hasOwn(publicPages, pagePath)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300, no-transform", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "Referrer-Policy": "no-referrer" });
    return res.end(method === "HEAD" ? undefined : publicPages[pagePath](cfg));
  }
  if (url.pathname.startsWith("/ota/") && ota().handle(req, res)) return undefined;
  // The plain HTTPS API for personal access tokens (docs/access-tokens.md). Its own prefix and its own credential:
  // nothing under /v1/ takes a token, and nothing here takes a device's.
  if (parts[0] === "api" && parts[1] === "v1") return handleTokenApi(req, res, url, parts, cfg);

  // Lets the app check a server address before pairing (and re-discover it later).
  if (method === "GET" && (url.pathname === "/v1/server" || url.pathname === "/v1/hub")) {
    return send(res, 200, { name: cfg.name, publicUrl: cfg.publicUrl || null, theme: normalizeTheme(cfg.theme) });
  }

  if (method === "POST" && url.pathname === "/v1/secure" && !req.encryptedTransport) {
    return secureTransport.handle(req, res, (innerReq, innerRes) => handle(innerReq, innerRes, cfg));
  }
  if (url.pathname.startsWith("/v1/") && !req.encryptedTransport) {
    // Only an operator can grandfather an already-paired device during the
    // initial rollout. New devices/pairing remain encrypted, and the grant is
    // bounded by an explicit expiry stored in private transactional state.
    const legacy = authenticate(req, readState());
    if (url.pathname === "/v1/pair" || url.pathname === "/v1/pair/email" || parts[1] === "device-links" || !legacy || !Number.isSafeInteger(legacy.device.legacyPlaintextUntil) || legacy.device.legacyPlaintextUntil <= now()) {
      return fail(res, 426, "encryption_required", "Update Servant and open a new invite from your admin to enable encryption");
    }
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", new Date(legacy.device.legacyPlaintextUntil).toUTCString());
  }

  // Inbox credentials are restricted to this surface and always encrypted,
  // including devices grandfathered into the legacy plaintext transport.
  if (parts[0] === "v1" && parts[1] === "inbox") {
    if (!req.encryptedTransport) return fail(res, 426, "encryption_required", "Open the secure inbox using an encrypted connection");
    if (!normalizeFeatures(cfg.features).secureInbox) return fail(res, 404, "feature_off", featureOffMessage("secureInbox"));
    if (parts[2] === "guest") {
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(String(req.headers.authorization || ""))?.[1] || "";
      if (method === "POST" && parts[3] === "start" && parts.length === 4) {
        const body = await readBody(req, INBOX_BODY_LIMIT);
        // Never use client-controlled forwarding headers for this public quota.
        const { created, ...started } = inbox().start(body, { ip: req.socket.remoteAddress || "" });
        // An address given with the first message is sent its code straight away. If that fails the
        // conversation still stands, and the page offers to send the code again.
        if (created && typeof body?.email === "string" && body.email.trim() && inboxNotices.available()) {
          try { started.notify = (await inboxNotices.begin(started.token, { email: body.email })).notify; } catch { /* Offered again on the page. */ }
        }
        if (created) notifyTeamOfVisitor(started.messages[0]);
        return send(res, 201, withNotices(started));
      }
      if (method === "GET" && parts[3] === "conversation" && parts.length === 4) return send(res, 200, withNotices(inbox().guestDetail(token, url.searchParams.get("after"))));
      if (method === "POST" && parts[3] === "notify" && parts.length === 4) {
        const body = await readBody(req);
        return send(res, 200, withNotices(await inboxNotices.begin(token, body)));
      }
      if (method === "POST" && parts[3] === "notify" && parts[4] === "confirm" && parts.length === 5) {
        const body = await readBody(req);
        return send(res, 200, withNotices(inbox().guestNotifyConfirm(token, body)));
      }
      if (method === "POST" && parts[3] === "notify" && parts[4] === "stop" && parts.length === 5) return send(res, 200, withNotices(inbox().guestNotifyStop(token)));
      if (method === "POST" && parts[3] === "messages" && parts.length === 4) {
        const body = await readBody(req, INBOX_BODY_LIMIT);
        const posted = inbox().guestPost(token, body);
        notifyTeamOfVisitor(posted.message);
        return send(res, 201, posted);
      }
      if (method === "POST" && parts[3] === "read" && parts.length === 4) {
        const body = await readBody(req);
        return send(res, 200, inbox().guestRead(token, body?.through));
      }
      if (method === "GET" && parts[3] === "files" && parts.length === 5) return send(res, 200, inbox().guestFile(token, parts[4]));
      return fail(res, 404, "not_found", "Not found");
    }
  }

  if (parts[0] === "v1" && parts[1] === "device-links") {
    if (method === "POST" && parts.length === 2) {
      const body = await readBody(req);
      const link = mutateState(state => createDeviceLink(state, { device: body?.device, ip: clientIp(req), agent: body?.agent === true }));
      return send(res, 201, link);
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "poll") {
      const body = await readBody(req);
      const result = mutateState(state => pollDeviceLink(state, parts[2], body?.secret));
      return send(res, 200, result.status === "approved" ? { ...result, server: { name: cfg.name }, features: featuresFor(cfg), banner: cfg.banner ?? null, theme: normalizeTheme(cfg.theme), deepWork: inDeepWork(readState().users[result.user?.id]) } : result);
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

  if (method === "GET" && url.pathname === "/v1/pair/email") {
    const s = emailSettings(cfg);
    return send(res, 200, { required: s.enabled, domains: s.enabled ? s.domains : [] });
  }
  if (method === "POST" && url.pathname === "/v1/pair/email") {
    const ip = clientIp(req);
    const settings = emailSettings(cfg);
    if (!settings.enabled) return fail(res, 404, "not_found", "Email codes are off");
    if (!pairAllowed(ip) || !emailStartAllowed(ip)) return fail(res, 429, "rate_limited", "Too many tries. Wait ten minutes");
    const body = await readBody(req);
    const inviteKey = sha256(normalizeCode(body.code));
    const state = readState();
    const invite = state.invites[inviteKey];
    const problem = inviteProblem(invite, state.users);
    if (problem) {
      pairFailed(ip);
      return fail(res, problem.status, problem.code, problem.message);
    }
    try {
      const out = await emailVerifier.start({ email: body.email, inviteKey }, settings);
      return send(res, 200, { challenge: out.id, email: out.email, expiresInSeconds: 600 });
    } catch (error) {
      if (!error.status) throw error;
      return fail(res, error.status, error.code, error.message);
    }
  }

  if (method === "POST" && url.pathname === "/v1/pair") {
    const ip = clientIp(req);
    if (!pairAllowed(ip)) return fail(res, 429, "rate_limited", "Too many tries. Wait ten minutes");
    const body = await readBody(req);
    const emailSettingsNow = emailSettings(cfg);
    let verifiedEmail = null;
    if (emailSettingsNow.enabled) {
      const inviteKey = sha256(normalizeCode(body.code));
      const inv = readState().invites[inviteKey];
      // Only check the code for a live invite; a bad invite falls through to its own error.
      // An invite for an existing person (a sign-in link made on their signed-in device, or a
      // second-device invite) already proves who they are: no email step, which they may not
      // be able to pass. A code sent anyway (older apps) is still checked and the email kept.
      if (inv && !inv.usedAt && !inv.revokedAt && inv.expiresAt >= now() && (body.emailChallenge || !inv.userId)) {
        if (!body.emailChallenge) return fail(res, 400, "email_required", "Confirm your work email to join");
        try { verifiedEmail = emailVerifier.check({ id: body.emailChallenge, code: body.emailCode, inviteKey }, { keep: true }); }
        catch (error) { if (!error.status) throw error; pairFailed(ip); return fail(res, error.status, error.code, error.message); }
      }
    }
    const { token, user, isNew } = mutateState(state => {
      const key = sha256(normalizeCode(body.code));
      const invite = state.invites[key];
      const problem = inviteProblem(invite, state.users);
      if (problem) {
        pairFailed(ip);
        throw problem;
      }
      // A confirmed work email that already belongs to someone signs in as them (a new device), not a second person (#41).
      // An invite from a prototype review whose reviewer confirmed their address there carries that address.
      if (!verifiedEmail && typeof invite.verifiedEmail === "string" && !invite.userId && !invite.reusable) verifiedEmail = invite.verifiedEmail;
      const byEmail = verifiedEmail && !invite.userId
        ? Object.values(state.users).find(u => !isRemoved(u) && u.email && u.email.toLowerCase() === verifiedEmail.toLowerCase())
        : null;
      const existing = (invite.userId && state.users[invite.userId]) || byEmail || null;
      const name = invite.reusable ? String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 80) : invite.name;
      if (!existing && !name) throw requestError(400, "name_required", "Enter your name");
      const terms = validTermsAcceptance(body.terms);
      if (!terms) throw requestError(400, "terms_required", "Agree to the terms to join");
      // The team link never makes a second person with a name that's already here (#41). The name
      // alone never hands that account over: `existing.hasEmail` lets the app say whether the
      // account can be reached with its work email or only from a device that is signed in.
      const sameName = !existing && invite.reusable ? Object.values(state.users).find(u => !isRemoved(u) && String(u.name).replace(/\s+/g, " ").trim().toLowerCase() === name.toLowerCase()) : null;
      if (sameName) {
        throw Object.assign(requestError(409, "name_taken", "That name is taken here. Try adding an initial. If you already belong to this team, sign in from a device you already use: You, then Link a computer."), { extra: { existing: { hasEmail: !!sameName.emailVerifiedAt } } });
      }
      if (invite.reusable) invite.uses += 1;
      else invite.usedAt = now();
      // The phone that made a sign-in link can show where it was used.
      if (invite.kind === "sign-in-link") invite.usedDevice = String(body.device || "Phone").slice(0, 80);
      const user = existing || { id: id("usr"), name, role: invite.role, createdAt: now(), tourDue: true, ...(invite.role === "owner" ? {} : { agentTier: Number.isInteger(invite.agentTier) ? invite.agentTier : loadConfig().defaultAgentTier ?? 0, ...(invite.agentTier === 2 ? { vibeCoder: true } : {}) }) };
      const token = crypto.randomBytes(32).toString("base64url");
      const deviceId = id("dev");
      // Every acceptance is kept: who, which version, which checks, when, on which device.
      user.termsAcceptances = [...(user.termsAcceptances || []), { ...terms, acceptedAt: now(), deviceId }];
      if (verifiedEmail) { user.email = verifiedEmail; user.emailVerifiedAt = now(); }
      // Who decides this person's entitlement requests starts as whoever invited them (managerOf falls back to an owner).
      if (!existing && invite.createdBy && !invite.managerFor) user.invitedBy = invite.createdBy;
      state.users[user.id] = user;
      // "Invite your manager": the person who sent this invite now reports to whoever accepted it. Skipped quietly
      // when it can't hold (they left, became an owner, or it would make a loop); joining never fails over it.
      const report = invite.managerFor && state.users[invite.managerFor];
      if (report && !isRemoved(report) && report.role !== "owner") { try { setManager(state, report, user); } catch { /* the join still stands */ } }
      state.devices[sha256(token)] = {
        id: deviceId, userId: user.id, label: String(body.device || "Phone").slice(0, 80),
        createdAt: now(), lastSeenAt: now(), ...(verifiedEmail ? { sessionVerifiedAt: now() } : {}),
      };
      return { token, user, isNew: !existing };
    });
    messaging?.joinDefaults(user.id);
    // A new person's first unread: a question from the agent, with quick answers. Never blocks pairing.
    if (verifiedEmail) emailVerifier.consume(body.emailChallenge);
    if (isNew) { try { messaging?.welcomeFromAgent(user.id); } catch (error) { console.error("[servant] welcome", error); } }
    return send(res, 201, { token, user: { id: user.id, name: user.name, role: user.role }, server: { name: cfg.name }, hub: { name: cfg.name }, banner: cfg.banner ?? null, features: featuresFor(cfg), theme: normalizeTheme(cfg.theme), deepWork: inDeepWork(user), tour: { due: user.tourDue === true } });
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
  // Scripts on this Mac (cron jobs, alerts) notify someone through the agent: `servant notify`.
  if (method === "POST" && url.pathname === "/admin/notify") {
    if (!adminAllowed()) return fail(res, 403, "forbidden", "Not allowed");
    const body = await readBody(req, MAX_UPLOAD_BODY);
    const people = readState().users;
    const target = body.userId ? people[String(body.userId)] : Object.values(people).find((u) => u.role === "owner");
    if (!target) return fail(res, 404, "not_found", "No such person");
    const attachments = validateUploads(body.attachments || [], { mediaOnly: true });
    return send(res, 200, messaging.notifyFromAgent(target.id, body.text, { attachments }));
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
  if (parts[1] === "inbox") {
    if (method === "GET" && parts.length === 2) return send(res, 200, { ...inbox().list(user, { status: url.searchParams.get("status") || "open", q: url.searchParams.get("q") || "", before: url.searchParams.get("offset"), scope: url.searchParams.get("scope") || "all" }), publicUrl: secureInboxPublicUrl(cfg.publicUrl) });
    if (method === "POST" && parts.length === 2) {
      const body = await readAuthorizedBody(req);
      return send(res, 201, inbox().staffStart(requireAuth(req).user, body));
    }
    if (method === "GET" && parts.length === 3) return send(res, 200, inbox().staffDetail(user, parts[2], url.searchParams.get("after")));
    if (method === "PATCH" && parts.length === 3) {
      const body = await readAuthorizedBody(req);
      return send(res, 200, inbox().update(requireAuth(req).user, parts[2], body));
    }
    if (method === "POST" && parts[3] === "messages" && parts.length === 4) {
      const body = await readAuthorizedBody(req, INBOX_BODY_LIMIT);
      return send(res, 201, inbox().staffPost(requireAuth(req).user, parts[2], body));
    }
    if (method === "POST" && parts[3] === "read" && parts.length === 4) {
      const body = await readAuthorizedBody(req);
      return send(res, 200, inbox().staffRead(requireAuth(req).user, parts[2], body?.through));
    }
    if (method === "GET" && parts[3] === "files" && parts.length === 5) return send(res, 200, inbox().staffFile(user, parts[2], parts[4]));
    if (method === "POST" && parts[3] === "visitor-link" && parts.length === 4) {
      await readAuthorizedBody(req);
      return send(res, 200, inbox().visitorLink(requireAuth(req).user, parts[2], cfg.publicUrl));
    }
    if (method === "GET" && parts[3] === "case" && parts.length === 4) return send(res, 200, withNotices(inbox().caseDetail(user, parts[2])));
    if (method === "GET" && parts[3] === "notes" && parts.length === 4) return send(res, 200, inbox().notes(user, parts[2], url.searchParams.get("after")));
    if (method === "POST" && parts[3] === "notes" && parts.length === 4) {
      const body = await readAuthorizedBody(req, INBOX_BODY_LIMIT);
      return send(res, 201, inbox().addNote(requireAuth(req).user, parts[2], body));
    }
    if (method === "GET" && parts[3] === "notes" && parts[4] === "files" && parts.length === 6) return send(res, 200, inbox().noteFile(user, parts[2], parts[5]));
    if (method === "POST" && parts[3] === "tasks" && parts.length === 4) {
      const body = await readAuthorizedBody(req);
      return send(res, 201, inbox().addTask(requireAuth(req).user, parts[2], body));
    }
    if (method === "PATCH" && parts[3] === "tasks" && parts.length === 5) {
      const body = await readAuthorizedBody(req);
      return send(res, 200, inbox().changeTask(requireAuth(req).user, parts[2], parts[4], body));
    }
    if (method === "GET" && parts[3] === "activity" && parts.length === 4) return send(res, 200, inbox().activity(user, parts[2], url.searchParams.get("after")));
    return fail(res, 404, "not_found", "Not found");
  }
  // Re-entry after a session ends: a code to the email on file, then this same device is fresh again.
  if (parts[1] === "session" && (await sessions.handle(req, res, { auth, ip: clientIp(req), settings: emailSettings(cfg), send, fail, readBody: readAuthorizedBody, pairAllowed, emailStartAllowed, pairFailed, mutateAuthenticated: fn => mutateAuthenticated(req, fn) }))) return undefined;

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
    return send(res, 200, { user: { id: user.id, name: user.name, role: user.role, ...(user.emailVerifiedAt ? { emailVerified: true } : {}), ...(jobRoleOf(user) ? { jobRole: jobRoleOf(user) } : {}) },
      // The onboarding tour (tour.mjs): due once for someone who joined since it existed, until they finish or skip it.
      tour: { due: user.tourDue === true }, emailRequired: emailSettings(cfg).enabled && !user.emailVerifiedAt, device: { id: device.id, label: device.label }, session: sessions.view(device, user), server: { name: cfg.name }, hub: { name: cfg.name }, features: featuresFor(cfg), banner: cfg.banner ?? null, theme: normalizeTheme(cfg.theme), deepWork: inDeepWork(user), ...(recordsPreservationEnabled(cfg.recordsPreservation) ? { recordsKept: true } : {}), ...(user.role === "owner" && cfg.fileDropDir ? { fileDrop: true } : {}) });
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
    if (method === "GET" && parts.length === 2) return send(res, 200, { preferences: preferences(user), registered: !!device.push, deviceId: device.id, webPushKey: webPush().publicKey });
    if (["PUT", "PATCH", "POST"].includes(method)) {
      const body = await readBody(req);
      const result = mutateAuthenticated(req, (state, current) => {
        if (method === "PUT" && parts.length === 2) updatePushRegistration(state, current.device, body);
        else if (method === "PATCH" && parts.length === 2) updatePreferences(current.user, body);
        else if (method === "POST" && parts[2] === "presence") {
          const conversation = typeof body.conversation === "string" && /^(ch|dm|cht|inbox)_[A-Za-z0-9_-]+$/.test(body.conversation) ? body.conversation : null;
          current.device.pushPresence = { conversation, until: body.active === true ? now() + 75000 : 0 };
        } else throw requestError(404, "not_found", "Not found");
        return { preferences: preferences(current.user), registered: !!current.device.push, deviceId: current.device.id, webPushKey: webPush().publicKey };
      });
      return send(res, 200, result);
    }
    return fail(res, 404, "not_found", "Not found");
  }

  // ----- owner-only admin -----
  if (method === "POST" && parts[1] === "sign-in-links" && parts.length === 2) {
    await readBody(req);
    const { code, expiresAt } = mutateAuthenticated(req, (state, auth) => createSignInLink(state, auth, inviteCode, c => sha256(normalizeCode(c))));
    return send(res, 200, { code, link: pairLink(code, cfg), expiresAt });
  }
  // The newest sign-in link this person made: live, used (and on what), expired, or none. Never the code again.
  if (method === "GET" && parts[1] === "sign-in-links" && parts.length === 2) {
    const mine = Object.values(state.invites).filter(i => i.kind === "sign-in-link" && i.userId === user.id && !i.revokedAt).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!mine) return send(res, 200, { link: null });
    const status = mine.usedAt ? "used" : mine.expiresAt < now() ? "expired" : "live";
    return send(res, 200, { link: { status, createdAt: mine.createdAt, expiresAt: mine.expiresAt, ...(mine.usedAt ? { usedAt: mine.usedAt, device: mine.usedDevice || "Computer" } : {}) } });
  }
  if (parts[1] === "invites" || parts[1] === "devices") {
    if (user.role !== "owner") return fail(res, 403, "forbidden", "Only the owner can do that");
    if (method === "POST" && parts[1] === "invites" && parts.length === 2) {
      const body = await readBody(req);
      const { code, expiresAt } = mutateAuthenticated(req, (state, auth) => makeJoinLink(state, { fresh: body.fresh === true, createdBy: auth.user.id }), true);
      return send(res, 200, { code, link: pairLink(code, cfg), webLink: joinWebLink(code, cfg), expiresAt });
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
  // Shared definitions are available to active members. Mutations recheck the
  // device after awaiting the body; author/owner rights are checked by the store.
  if (parts[1] === "lexicon") {
    if (method === "POST" && parts.length === 3 && parts[2] === "guess") {
      const request = cleanGuessRequest(await readAuthorizedBody(req));
      requireAuth(req);
      return send(res, 200, { guesses: await guessAbbreviations(request, askMemberAgent()) });
    }
    // Undefined abbreviations in a message someone just sent: add Agent's guesses and a to-do for the sender.
    if (method === "POST" && parts.length === 3 && parts[2] === "learn") {
      const request = cleanGuessRequest(await readAuthorizedBody(req));
      const current = requireAuth(req).user;
      const todos = todosStore ? {
        has: source => todosStore.forSource(current, LEARN_SOURCE, source).length > 0,
        add: (text, source) => todosStore.create(current, { text }, { source: { kind: LEARN_SOURCE, id: source, title: "Abbreviations" } }),
      } : null;
      return send(res, 200, await learnAbbreviations({ request, user: current, lexicon: { ...lexicon(), list: person => withColloquialisms(lexicon().list(person), cfg.expandColloquialisms), guess: (...args) => lexicon().guess(...args) }, todos, ask: globalThis.__servantLexiconAsk || askMemberAgent() }));
    }
    if (method === "GET" && parts.length === 2) return send(res, 200, { entries: withColloquialisms(lexicon().list(user), cfg.expandColloquialisms), canWrite: true });
    if ((method === "POST" && parts.length === 2) || (method === "PATCH" && parts.length === 3)) {
      const body = await readAuthorizedBody(req);
      const current = requireAuth(req).user;
      const entry = method === "POST" ? lexicon().create(body, current) : lexicon().update(parts[2], body, current);
      checkedAbbreviation(current, entry.id, entry.abbreviation);
      return send(res, method === "POST" ? 201 : 200, { entry });
    }
    if (method === "DELETE" && parts.length === 3) {
      const current = requireAuth(req).user;
      lexicon().remove(parts[2], current);
      checkedAbbreviation(current, parts[2], "");
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, "not_found", "Not found");
  }
  // Social media (docs/social.md): everyone on the server reads the posts and writes replies; approving one needs
  // the Social media entitlement. Mutations recheck the device after awaiting the body.
  if (parts[1] === "social") {
    if (!socialOn(cfg)) return fail(res, 404, "feature_off", featureOffMessage("social"));
    const store = social(), settings = socialCfg(cfg);
    const guard = async work => { try { return await work(); } catch (error) { if (!error?.status || !error?.code) throw error; return fail(res, error.status, error.code, error.message), undefined; } };
    // Each answers the request itself when the person may not, and says so by returning true.
    const refusedApprover = person => maySocial(person) ? false : (fail(res, 403, "needs_entitlement", "Approving what goes out needs the Social media entitlement. Ask for it in Entitlements"), true);
    const refusedAgent = person => noAgent(person) || usageStore().overLimit(person) ? (fail(res, 429, "usage_limit", limitText(person)), true) : false;
    if (method === "GET" && parts.length === 2) {
      const guide = socialGuide();
      return send(res, 200, { ...socialRunner().status(), canApprove: maySocial(user), entitlementId: SOCIAL_ENTITLEMENT.id, guidePageId: guide.id, searches: settings.searches,
        spacingMinutes: settings.spacingMs / 60_000, limit: SOCIAL_LIMITS.post, counts: store.counts(), ownDrafts: store.ownDrafts() });
    }
    if (method === "GET" && parts[2] === "posts" && parts.length === 3) {
      const [filter, source] = [url.searchParams.get("filter") || "open", url.searchParams.get("source") || "all"];
      if (!["open", "drafted", "skipped"].includes(filter) || !["all", "mentions", "search"].includes(source)) return fail(res, 400, "bad_request", "filter is open, drafted or skipped; source is all, mentions or search");
      return send(res, 200, store.posts({ filter, source, before: url.searchParams.get("before"), limit: url.searchParams.get("limit") }));
    }
    if (method === "GET" && parts[2] === "schedule" && parts.length === 3) {
      return send(res, 200, { replies: store.schedule({ from: Number(url.searchParams.get("from")) || 0, to: Number(url.searchParams.get("to")) || undefined }) });
    }
    // Look at X now rather than at the next turn of the clock.
    if (method === "POST" && parts[2] === "sync" && parts.length === 3) {
      await readAuthorizedBody(req);
      const out = await socialRunner().sync();
      return send(res, 200, { added: out.added, ...socialRunner().status(), counts: store.counts() });
    }
    // Ask the agent for a reply to a post, written from the guide. Nothing goes out: the draft waits to be read and approved.
    if (method === "POST" && parts[2] === "posts" && parts[4] === "draft" && parts.length === 5) {
      const body = await readAuthorizedBody(req);
      const current = requireAuth(req).user;
      return guard(async () => {
        if (refusedAgent(current)) return undefined;
        const instruction = cleanInstruction(body?.instruction, SOCIAL_LIMITS.instruction);
        const { post, reply } = store.raw(parts[3]);
        if (reply && !["draft", "failed"].includes(reply.status)) throw requestError(409, "conflict", "This reply was already approved. Cancel it before asking for another draft");
        const messages = socialDraftMessages({ guide: socialGuide(), post, account: socialRunner().status().account?.handle, instruction, previous: instruction && reply ? reply.text : "" });
        const drafted = readSocialDraft(await askSocial(messages, current, cfg, `social:draft:${post.id}`));
        return send(res, 200, { post: drafted.skip ? store.suggestSkip(post.id, drafted.skip) : store.draftByAgent(post.id, drafted.text, current.id) });
      });
    }
    // A person writes the reply themselves, or changes the one that is there.
    if (method === "PUT" && parts[2] === "posts" && parts[4] === "reply" && parts.length === 5) {
      const body = await readAuthorizedBody(req);
      const current = requireAuth(req).user;
      return guard(() => { store.write(store.raw(parts[3]).post.id, body?.text, current.id); return send(res, 200, { post: store.post(parts[3]) }); });
    }
    if (method === "POST" && parts[2] === "posts" && ["skip", "restore"].includes(parts[4]) && parts.length === 5) {
      await readAuthorizedBody(req);
      const current = requireAuth(req).user;
      return guard(() => send(res, 200, { post: parts[4] === "skip" ? store.skip(parts[3], current.id) : store.restore(parts[3]) }));
    }
    // A post of the team's own: written by hand, or by the agent from a note. It is approved the same way.
    if (method === "POST" && parts[2] === "replies" && parts.length === 3) {
      const body = await readAuthorizedBody(req);
      const current = requireAuth(req).user;
      return guard(async () => {
        if (typeof body?.note === "string" && body.note.trim()) {
          if (refusedAgent(current)) return undefined;
          const drafted = readSocialDraft(await askSocial(socialPostMessages({ guide: socialGuide(), note: cleanInstruction(body.note, SOCIAL_LIMITS.instruction) }), current, cfg, "social:post"));
          if (drafted.skip) throw requestError(502, "agent_empty", "The agent didn't write a post. Say more about what it should say, or write it yourself");
          return send(res, 201, { reply: store.write(null, drafted.text, current.id, "agent") });
        }
        return send(res, 201, { reply: store.write(null, body?.text, current.id) });
      });
    }
    if (method === "PUT" && parts[2] === "replies" && parts.length === 4) {
      const body = await readAuthorizedBody(req);
      const current = requireAuth(req).user;
      return guard(() => send(res, 200, { reply: store.edit(parts[3], body?.text, current.id) }));
    }
    if (method === "POST" && parts[2] === "replies" && ["approve", "cancel", "discard"].includes(parts[4]) && parts.length === 5) {
      const body = await readAuthorizedBody(req);
      const current = requireAuth(req).user;
      return guard(() => {
        if (parts[4] === "discard") return send(res, 200, store.discard(parts[3], current.id));
        // Approving, and taking an approval back, are for people who hold the entitlement.
        if (refusedApprover(current)) return undefined;
        if (parts[4] === "cancel") return send(res, 200, { reply: store.cancel(parts[3]) });
        const reply = store.approve(parts[3], current.id, { at: body?.at ?? null, gap: settings.spacingMs });
        // What a person changed in the agent's draft before approving it is what the guide learns from.
        const fix = store.correction(reply.id);
        if (fix && !noAgent(current) && !usageStore().overLimit(current)) {
          const work = learnFromEdit(reply.id, fix, current, cfg).catch(error => console.error("[servant] social guide", error?.message || error)).finally(() => socialWork.delete(work));
          socialWork.add(work);
        }
        return send(res, 200, { reply });
      });
    }
    return fail(res, 404, "not_found", "Not found");
  }
  // Your own personal access tokens (docs/access-tokens.md): made, listed and revoked from the app, over the app's
  // own encrypted API. A token is returned once, when it is made.
  if (parts[1] === "tokens") {
    const settings = accessTokenSettings(cfg.accessTokens);
    if (method === "GET" && parts.length === 2) return send(res, 200, { enabled: settings.enabled, tokens: accessTokens().list(user.id), defaultDays: DEFAULT_DAYS, address: publicOrigin(cfg) ? `${publicOrigin(cfg)}/api/v1` : null });
    if (!settings.enabled) return fail(res, 404, "feature_off", "This server doesn't use access tokens. An owner can turn them on in config.json");
    if (method === "POST" && parts.length === 2) {
      const body = await readAuthorizedBody(req);
      const current = requireAuth(req).user;
      try { const made = accessTokens().create(current.id, { name: body?.name, days: body?.days ?? DEFAULT_DAYS }); return send(res, 201, { token: made.token, record: made.record }); }
      catch (e) { if (!e.status) throw e; return fail(res, e.status, e.code, e.message); }
    }
    if (method === "DELETE" && parts.length === 3) {
      const current = requireAuth(req).user;
      if (!accessTokens().revoke(parts[2], current.id)) return fail(res, 404, "not_found", "That token was already revoked");
      return send(res, 200, { tokens: accessTokens().list(current.id) });
    }
    return fail(res, 404, "not_found", "Not found");
  }
  // The wiki: every signed-in person reads and edits pages; the store checks who may delete. Mutations recheck
  // the device after awaiting the body.
  if (parts[1] === "wiki") {
    if (method === "GET" && parts.length === 2) return send(res, 200, { pages: wiki().list(user), limits: WIKI_LIMITS });
    if (method === "GET" && parts.length === 3) return send(res, 200, { page: wiki().get(parts[2], user) });
    if ((method === "POST" && parts.length === 2) || (method === "PATCH" && parts.length === 3)) {
      const body = await readAuthorizedBody(req, WIKI_BODY_LIMIT);
      const current = requireAuth(req).user;
      try { return send(res, method === "POST" ? 201 : 200, { page: method === "POST" ? wiki().create(body, current) : wiki().update(parts[2], body, current) }); }
      catch (error) {
        // Someone else saved first: send their version so the page can show it beside what this person wrote.
        if (error?.code === "stale") return fail(res, 409, "stale", error.message, { page: error.page });
        throw error;
      }
    }
    // Ask the agent for the page with a change made. Nothing is saved: the draft goes back to be read first.
    if (method === "POST" && parts[3] === "draft" && parts.length === 4) {
      const body = await readAuthorizedBody(req, WIKI_BODY_LIMIT);
      const current = requireAuth(req).user;
      if (noAgent(current) || usageStore().overLimit(current)) return fail(res, 429, "usage_limit", limitText(current));
      const page = wiki().get(parts[2], current);
      const { draft, usage, instruction } = await draftWikiPage({ page, request: body, ask: messages => (globalThis.__servantWikiAsk || askWikiAgent)(messages, current, cfg) });
      // Counted like any other use of the agent. Only the token counts are kept, never the request or the page.
      if (usage) recordUsage({ eventId: `wiki:${page.id}:${crypto.randomUUID()}`, userId: current.id, source: "chat", text: instruction, usage });
      return send(res, 200, { draft, version: page.version });
    }
    if (method === "DELETE" && parts.length === 3) {
      wiki().remove(parts[2], requireAuth(req).user);
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, "not_found", "Not found");
  }
  // A project's glossary is visible only to its members, and maintained by its writers.
  if (parts[1] === "projects" && parts[3] === "glossary") {
    const authorize = write => {
      // Read fresh credentials and project access after the body arrives: a writer
      // can lose their role or project membership while a request is uploading.
      const currentState = readState();
      const current = requireAuth(req, currentState).user;
      const data = projects().read();
      const project = data.projects.find(p => p.id === parts[2]);
      const access = project && accessOf(project, current, currentState.users, data.people);
      if (!access?.visible) throw requestError(404, "not_found", "No such project");
      if (write && !access.canWrite) throw requestError(403, "forbidden", "You can read this project's abbreviations but not change them");
      return { project, access, current };
    };
    const initial = authorize(false);
    if (method === "GET" && parts.length === 4) return send(res, 200, { entries: glossary().list(initial.project), canWrite: initial.access.canWrite, projectRepo: initial.project.repo || "" });
    if ((method === "POST" && parts.length === 4) || (method === "PATCH" && parts.length === 5)) {
      const body = await readAuthorizedBody(req);
      const { project, current } = authorize(true);
      const entry = method === "POST" ? glossary().create(project, body, current.id) : glossary().update(project, parts[4], body, current.id);
      return send(res, method === "POST" ? 201 : 200, { entry });
    }
    if (method === "DELETE" && parts.length === 5) {
      const { project, current } = authorize(true);
      glossary().remove(project, parts[4], current.id);
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, "not_found", "Not found");
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
      return send(res, 200, { ...wrap(false, list), vibeCoder: agentTierOf(users()[user.id]) === 2, agentTier: agentTierOf(users()[user.id]), vibe: !!vibeProject(),
        // Prototyping is this project: the new-chat list shows it once, as Prototyping, not twice.
        ...(vibeProject() ? { vibeProject: VIBE_PROJECT, vibeLinks: { primary: loadConfig().publicUrl ? `${loadConfig().publicUrl.replace(/\/+$/, "")}/p/` : "", backup: vibeProject().pages || "" } } : {}) });
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
        // The project's app in the browser (docs/app-preview.md), when one has been exported for it.
        const preview = previewInfo(APP_PREVIEWS_DIR, pid);
        const appPreview = preview ? { ...preview, url: `${publicOrigin(cfg) || ""}${preview.path}` } : null;
        return send(res, 200, { ...wrap(true, project), sharedChats, appPreview });
      }
      // The repo's README from GitHub (cached; stale copy while GitHub is unreachable). Anyone who can see the project.
      if (method === "GET" && parts.length === 4 && parts[3] === "readme") {
        const { project } = found(projects().read(), pid);
        if (!project.repo) return send(res, 200, { readme: null });
        return send(res, 200, { readme: await projectReadme(project.repo) });
      }
      // Share the project's app preview with an outside reviewer (docs/app-preview.md): the same emailed link and
      // code as a prototype. Anyone who can see the project can share it; each person sees and ends their own shares.
      // The person who shared the preview has dealt with one of its comments: it leaves their waiting list.
      if (parts[3] === "app-preview" && parts[4] === "comments" && parts[6] === "set-aside" && parts.length === 7 && method === "POST") {
        await readAuthorizedBody(req);
        const current = requireAuth(req).user;
        found(projects().read(), pid);
        if (!prototypeReviews().setAsideApp(parts[5], pid, current.id)) return fail(res, 404, "not_found", "That comment is no longer waiting");
        return send(res, 200, { ok: true });
      }
      if (parts[3] === "app-preview" && parts[4] === "shares" && (parts.length === 5 || parts.length === 6)) {
        const { project } = found(projects().read(), pid);
        const reviews = prototypeReviews();
        const listing = person => {
          const mine = reviews.forApp(pid, person.id);
          const comments = reviews.comments({ shareIds: mine.map(share => share.id) });
          const open = new Set(mine.filter(share => !share.endedAt).map(share => share.email));
          return { suggested: outsideReviewers(project).filter(r => !open.has(r.email)), shares: mine.map(share => ({ id: share.id, email: share.email, createdAt: share.createdAt, ...(share.verifiedAt ? { verifiedAt: share.verifiedAt } : {}), ...(share.lastSeenAt ? { lastSeenAt: share.lastSeenAt } : {}), ...(share.endedAt ? { endedAt: share.endedAt } : {}),
            comments: comments.filter(c => c.shareId === share.id).map(c => ({ id: c.id, page: c.page, x: c.x, y: c.y, anchor: c.anchor, text: c.text, createdAt: c.createdAt, ...(c.setAsideAt ? { setAsideAt: c.setAsideAt } : {}) })) })) };
        };
        if (method === "GET" && parts.length === 5) return send(res, 200, listing(user));
        if (method === "POST" && parts.length === 5) {
          const body = await readAuthorizedBody(req);
          const current = requireAuth(req).user;
          const origin = publicOrigin(cfg), settings = emailSettings(cfg);
          if (!previewInfo(APP_PREVIEWS_DIR, pid)) return fail(res, 404, "not_found", "This project has no app preview to share yet");
          if (!origin) return fail(res, 400, "not_set_up", "This server has no public address yet, so there is no link to send. Ask an owner to set it up");
          if (!settings.mailer?.command && !globalThis.__servantEmailSend) return fail(res, 400, "not_set_up", "This server can't send email yet, so the link can't be sent. Ask an owner to set up email");
          const title = `${project.name} preview`;
          let made;
          try { made = reviews.shareApp({ projectId: pid, title, email: body.email, by: current.id, domains: reviewDomains(settings) }); }
          catch (e) { if (!e.status) throw e; return fail(res, e.status, e.code, e.message); }
          try {
            await sendMail({ to: made.share.email, code: "", minutes: 0, subject: `${current.name} shared an app preview with you: ${title}`,
              text: `${current.name} shared the app preview "${title}" with you on ${cfg.name} and would like your comments. It runs in your browser with sample data.\n\nOpen it here: ${origin}/review/${made.token}\n\nIt opens straight away. To leave a comment, confirm this email address with the code that page offers to send you, then right-click anywhere on the app.\n\nIf you weren't expecting this, ignore this email.` }, settings);
          } catch (error) {
            reviews.endApp(made.share.id, pid, current.id);
            console.error("[servant] app review share email failed:", error?.message || error);
            return fail(res, 502, "email_send_failed", "Couldn't send the email. Try again, or ask an owner to check email setup");
          }
          return send(res, 201, listing(current));
        }
        if (method === "DELETE" && parts.length === 6) {
          const current = requireAuth(req).user;
          if (!reviews.endApp(parts[5], pid, current.id)) return fail(res, 404, "not_found", "That share has already ended");
          return send(res, 200, listing(current));
        }
        return fail(res, 404, "not_found", "Not found");
      }
      if (method === "PATCH" && parts.length === 3) {
        const body = await readAuthorizedBody(req);
        // Notes are for anyone who can write; the rest is the owners' call.
        const settings = { name: cleanName, description: cleanDescription, repo: cleanRepo, path: cleanPath, pages: cleanUrl, workflow: cleanWorkflow, rules: cleanRules, stages: cleanStages, reviewers: cleanReviewers,
          // Outside reviewers must be at addresses a prototype could be shared to (prototype-reviews.mjs).
          outsideReviewers: value => cleanOutsideReviewers(value, reviewDomains(emailSettings(cfg))) };
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
          // The final box: it stays locked until every feature is checked. Unticking it is always allowed.
          if (body.shipped !== undefined) {
            if (typeof body.shipped !== "boolean") throw requestError(400, "bad_request", "shipped is true or false");
            if (body.shipped && !releaseReady(r, within(data, pid, "write").stages)) throw requestError(409, "not_ready", "Check off every feature first");
            if (body.shipped) r.shipped = r.shipped || { at: now(), by: user.id }; else delete r.shipped;
          }
        });
        else if (method === "DELETE" && parts.length === 5) projects().mutate(data => { const p = within(data, pid, "write"); inRelease(p); p.releases = p.releases.filter(r => r.id !== parts[4]); });
        else if (method === "POST" && items && parts.length === 6) projects().mutate(data => {
          const r = inRelease(within(data, pid, "write"));
          if (r.items.length >= MAX_ITEMS) throw requestError(409, "limit", `A release holds up to ${MAX_ITEMS} items`);
          r.items.push(newItem(body));
        });
        else if (method === "PATCH" && items && parts.length === 7) projects().mutate(data => {
          const p = within(data, pid, "write");
          const item = inItem(inRelease(p));
          if (body.title !== undefined) item.title = cleanTitle(body.title);
          if (body.done !== undefined) {
            if (typeof body.done !== "boolean") throw requestError(400, "bad_request", "done is true or false");
            setItemDone(p, item, body.done);
          }
        });
        // A feature's parts: its sub-checkboxes.
        else if (items && parts[7] === "parts" && (parts.length === 8 || parts.length === 9)) projects().mutate(data => {
          const item = inItem(inRelease(within(data, pid, "write")));
          if (!Array.isArray(item.parts)) item.parts = [];
          if (method === "POST" && parts.length === 8) {
            if (item.parts.length >= MAX_PARTS) throw requestError(409, "limit", `A feature holds up to ${MAX_PARTS} parts`);
            item.parts.push(newPart(body));
            return;
          }
          const part = parts.length === 9 ? item.parts.find(x => x.id === parts[8]) : null;
          if (!part) throw requestError(404, "not_found", "No such part");
          if (method === "PATCH") {
            if (body.title !== undefined) part.title = cleanPartTitle(body.title);
            if (body.done !== undefined) { if (typeof body.done !== "boolean") throw requestError(400, "bad_request", "done is true or false"); part.done = body.done; }
          } else if (method === "DELETE") item.parts = item.parts.filter(x => x.id !== part.id);
          else throw requestError(404, "not_found", "Not found");
        });
        else if (method === "DELETE" && items && parts.length === 7) projects().mutate(data => { const r = inRelease(within(data, pid, "write")); inItem(r); r.items = r.items.filter(i => i.id !== parts[6]); });
        else if (method === "PATCH" && items && parts[7] === "stages" && parts.length === 8) projects().mutate(data => {
          const { project: p, access } = found(data, pid);
          const stage = cleanStage(p, body.stage);
          const item = inItem(inRelease(p));
          // A stage's reviewers own its cells until someone is assigned; they can tick their own.
          if (!access.canWrite && !ownsCell(p, item, stage, user, users(), data.people)) throw requestError(403, "forbidden", "Only the person this is assigned to, or someone who can write, can change it");
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
  // "Invite your manager": a one-use invite for someone who isn't here yet. When they join, they become the manager of
  // the person who sent it, so the chart fills in from the bottom up. Their own manager is an owner until someone says otherwise.
  if (method === "POST" && parts[1] === "people" && parts[2] === "me" && parts[3] === "manager-invite" && parts.length === 4) {
    const body = await readAuthorizedBody(req);
    const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) return fail(res, 400, "name_required", "Enter your manager's name");
    try {
      const code = mutateAuthenticated(req, (state, auth) => {
        if (auth.user.role === "owner") throw requestError(400, "bad_request", "An owner has no manager");
        if (Object.values(state.users).some(u => !isRemoved(u) && u.name.toLowerCase() === name.toLowerCase())) throw requestError(409, "name_taken", `${name} is already on this server. Ask your manager or an owner to make them your manager`);
        const made = inviteCode();
        state.invites[sha256(normalizeCode(made))] = { name, role: "member", createdAt: now(), expiresAt: now() + INVITE_TTL_MS, createdBy: auth.user.id, managerFor: auth.user.id };
        return made;
      });
      return send(res, 201, { code, link: pairLink(code, cfg), webLink: joinWebLink(code, cfg), expiresAt: now() + INVITE_TTL_MS });
    } catch (error) { if (!error.status) throw error; return fail(res, error.status, error.code, error.message); }
  }
  // Change who someone's manager is: an owner, or their current manager handing them on.
  if (method === "PUT" && parts[1] === "people" && parts[3] === "manager" && parts.length === 4) {
    const body = await readAuthorizedBody(req);
    try {
      const out = mutateAuthenticated(req, (state, auth) => {
        const target = state.users[parts[2]];
        if (!target || isRemoved(target)) throw requestError(404, "not_found", "No such person");
        if (auth.user.role !== "owner" && managerOf(state, target)?.id !== auth.user.id) throw requestError(403, "forbidden", `Only ${target.name}'s manager or an owner can change their manager`);
        setManager(state, target, state.users[String(body.managerId || "")]);
        return { id: target.id, name: target.name, manager: { id: target.managerId, name: state.users[target.managerId].name } };
      });
      if (out.manager.id !== user.id) tellAbout([out.manager.id], "Entitlements", `You now decide ${out.name}'s entitlement requests`);
      return send(res, 200, { person: out });
    } catch (error) { if (!error.status) throw error; return fail(res, error.status, error.code, error.message); }
  }
  // Code requests (docs/code-requests.md): an automation signed in as you asks for a one-time code; your phone answers.
  if (parts[1] === "code-requests") {
    const guard = fn => { try { return fn(); } catch (error) { if (!error.status) throw error; return fail(res, error.status, error.code, error.message), undefined; } };
    if (method === "GET" && parts.length === 2) return send(res, 200, { requests: codeRequests.list(user) });
    if (method === "POST" && parts.length === 2) {
      const body = await readAuthorizedBody(req);
      const made = guard(() => codeRequests.create(user, device, body));
      if (!made) return;
      // The alert names the device and what the code is for; the worker that sends it cannot see this process's memory.
      try { push?.enqueue({ kind: "code", eventId: made.id, to: user.id, requestId: made.id, device: made.device, label: made.label, expiresAt: made.expiresAt }); } catch (error) { console.error("[servant] code request alert", error.message); }
      // And straight onto the screen of any Servant app they have open.
      try { messaging?.codeRequested(user.id, made.id); } catch (error) { console.error("[servant] code request live event", error.message); }
      return send(res, 201, { request: made });
    }
    if (method === "GET" && parts.length === 3) return guard(() => send(res, 200, { request: codeRequests.get(parts[2], user) }));
    if (method === "POST" && parts.length === 4 && parts[3] === "answer") {
      const body = await readAuthorizedBody(req);
      return guard(() => send(res, 200, { request: codeRequests.answer(parts[2], user, device, body?.code) }));
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "claim") {
      await readAuthorizedBody(req);
      return guard(() => send(res, 200, codeRequests.claim(parts[2], user, device)));
    }
    if (method === "POST" && parts.length === 4 && parts[3] === "cancel") {
      await readAuthorizedBody(req);
      return guard(() => send(res, 200, { request: codeRequests.cancel(parts[2], user) }));
    }
    return fail(res, 404, "not_found", "Not found");
  }
  // Personal connections (docs/connections.md): a person's own credentials for the tools their agent works with.
  // Everyone sees the tool types and where they stand themselves. No route returns a value, to anyone.
  if (parts[1] === "connections") {
    const store = connectionStore();
    const view = tool => ({ ...publicTool(tool), mine: store.status(user.id, tool.id) });
    const agent = connectionAgent(user, cfg);
    if (method === "GET" && parts.length === 2) return send(res, 200, { tools: store.tools().map(view), agent });
    // What happened to your own connections; an owner sees everyone's. Actions and times only.
    if (method === "GET" && parts[2] === "history" && parts.length === 3) {
      const users = readState().users;
      const everyone = user.role === "owner" && url.searchParams.get("all") === "1";
      return send(res, 200, { history: store.history(everyone ? {} : { userId: user.id }).map(h => ({ ...h, name: users[h.userId]?.name || "Former member", tool: store.tool(h.type)?.name || h.type })) });
    }
    if (method === "POST" && parts[2] === "requests" && parts[4] === "decline" && parts.length === 5) {
      await readAuthorizedBody(req);
      const declined = store.decline(parts[3], user.id);
      return send(res, 200, { request: { id: declined.id, status: declined.status } });
    }
    const tool = parts.length === 3 ? store.tool(parts[2]) : null;
    if (!tool) return fail(res, 404, "not_found", "No such tool to connect");
    if (method === "PUT") {
      const body = await readAuthorizedBody(req);
      // Only the full agent runs commands, and commands are the only place a connection is used.
      if (agent !== "full") return fail(res, 403, "agent_restricted", agent === "none" ? "You don't have an agent yet, so nothing could use this. Ask an owner to give you the full agent first" : "Your agent can't run commands, so it can't use this yet. Ask an owner to give you the full agent first");
      const values = cleanValues(tool, body.values);
      let account = "", checked = false;
      if (tool.check === "github" && cfg.connections?.verify !== false) {
        const result = await (globalThis.__servantConnectionCheck || checkGithubToken)(values);
        if (!result.ok) return fail(res, 400, "token_rejected", "GitHub didn't accept that token. Check that it hasn't expired and that you copied all of it, then try again");
        account = result.account || ""; checked = !result.unreachable;
      }
      const saved = store.save(user.id, tool.id, values, { account });
      return send(res, 200, { tool: view(tool), replaced: saved.replaced, checked });
    }
    if (method === "DELETE") {
      if (!store.remove(requireAuth(req).user.id, tool.id)) return fail(res, 404, "not_found", `You haven't connected ${tool.name}`);
      return send(res, 200, { tool: view(tool) });
    }
    return fail(res, 404, "not_found", "Not found");
  }
  // Entitlements (docs/entitlements.md): named access people ask for and their manager grants. Everyone sees the list and
  // their own standing; a manager also sees their reports'; owners see everyone's and make, edit and retire them.
  if (parts[1] === "entitlements") {
    const store = entitlementStore();
    // An entitlement for one project has "@" in its id ("native-fs-write@example-app"), which apps send encoded.
    if (parts[2]?.includes("%")) { try { parts[2] = decodeURIComponent(parts[2]); } catch { return fail(res, 404, "not_found", "No such entitlement"); } }
    const guard = fn => { try { return fn(); } catch (error) { if (!error.status) throw error; return fail(res, error.status, error.code, error.message), undefined; } };
    const users = readState().users;
    if (method === "GET" && parts.length === 2) {
      const state = readState();
      const brief = u => u && ({ id: u.id, name: u.name });
      const everyone = Object.values(activeUsers(state));
      return send(res, 200, { entitlements: store.list().filter(e => e.id !== SOCIAL_ENTITLEMENT.id || socialOn(cfg)).map(e => entitlementView(e, user, users)), canCreate: user.role === "owner", waiting: store.waitingOn(user.id).length,
        manager: brief(managerOf(state, user)) || null, reports: everyone.filter(u => managerOf(state, u)?.id === user.id).map(brief),
        // Owners see the whole chart: each person and who decides for them.
        ...(user.role === "owner" ? { org: everyone.map(u => ({ ...brief(u), role: u.role, manager: brief(managerOf(state, u)) || null })) } : {}),
        // Whether built-in entitlements are checked before the agent reads or changes files or GitHub.
        capabilities: { mode: capabilitySettings(cfg.agentCapabilities).mode },
        egress: { mode: egressSettings(cfg.agentEgress).mode, ...(user.role === "owner" ? { always: egressSettings(cfg.agentEgress).always, refused: egressStore().recent(50).map(a => ({ ...a, name: users[a.userId]?.name || "Former member" })),
          // What agents did reach: per person (or the agent itself), host and day.
          reached: egressStore().recentReached(100).map(a => ({ ...a, name: a.userId ? users[a.userId]?.name || "Former member" : "The agent itself" })) } : {}) } });
    }
    if (method === "POST" && parts.length === 2) {
      const body = await readAuthorizedBody(req);
      if (user.role !== "owner") return fail(res, 403, "forbidden", "Only an owner can make an entitlement");
      const made = guard(() => store.create(body, user.id));
      return made && send(res, 201, { entitlement: entitlementView(made, user, users) });
    }
    // Owners: what agents did or were stopped from doing, newest first (docs/entitlements.md, "The agent action log").
    if (method === "GET" && parts.length === 3 && parts[2] === "actions") {
      if (user.role !== "owner") return fail(res, 403, "forbidden", "Only an owner can see the agent action log");
      const before = Number(url.searchParams.get("before")), of = url.searchParams.get("user");
      const actions = store.actions({ userId: of || undefined, before: Number.isInteger(before) && before > 0 ? before : undefined, limit: Number(url.searchParams.get("limit")) || 100 });
      return send(res, 200, { actions: actions.map(a => ({ ...a, name: users[a.userId]?.name || "Former member" })) });
    }
    if (method === "GET" && parts.length === 4 && parts[3] === "history") {
      const entitlement = store.get(parts[2]);
      if (!entitlement) return fail(res, 404, "not_found", "No such entitlement");
      if (user.role !== "owner") return fail(res, 403, "forbidden", "Only an owner can see an entitlement's history");
      return send(res, 200, { history: store.history(entitlement.id).map(h => ({ ...h, byName: users[h.by]?.name || (h.by === "server" ? "Servant" : "Former member"), ...(h.userId ? { name: users[h.userId]?.name || "Former member" } : {}) })) });
    }
    if ((method === "PATCH" || method === "DELETE") && parts.length === 3) {
      const body = method === "PATCH" ? await readAuthorizedBody(req) : (requireAuth(req), {});
      if (user.role !== "owner") return fail(res, 403, "forbidden", "Only an owner can change an entitlement");
      if (method === "DELETE") return guard(() => store.retire(parts[2], user.id)) && send(res, 200, { ok: true });
      const changed = guard(() => store.update(parts[2], body, user.id));
      return changed && send(res, 200, { entitlement: entitlementView(changed, user, users) });
    }
    // The person asks, confirming they have this access themselves. Their manager is told once.
    if (method === "POST" && parts.length === 4 && parts[3] === "request") {
      const body = await readAuthorizedBody(req);
      const asked = guard(() => store.request(parts[2], user.id, { confirmed: body.confirmed, note: body.note }));
      if (!asked) return;
      if (asked.fresh) tellAbout([managerOf(readState(), user)?.id], "Entitlement request", `${user.name} asked for ${asked.entitlement.name}`);
      return send(res, asked.fresh ? 201 : 200, { entitlement: entitlementView(asked.entitlement, user, users) });
    }
    // The person's manager (or an owner) grants or declines a request, or takes the entitlement back. The person is told.
    if (method === "POST" && parts.length === 5 && parts[3] === "people") {
      const body = await readAuthorizedBody(req);
      const decided = guard(() => store.decide(parts[2], parts[4], { decision: body.decision, by: user.id, reason: body.reason }));
      if (!decided) return;
      const { entitlement, grant } = decided;
      if (parts[4] !== user.id) tellAbout([parts[4]], "Entitlements", grant.status === "granted" ? `You now have ${entitlement.name}` : grant.status === "once" ? `${entitlement.name} was allowed once` : grant.status === "denied" ? `Your request for ${entitlement.name} was declined` : `${entitlement.name} was taken back`);
      return send(res, 200, { entitlement: entitlementView(entitlement, user, users) });
    }
    return fail(res, 404, "not_found", "No such route");
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
  // The same route flips their own deep work switch (deep-work.mjs): `deepWork: true|false`, with or without a name.
  // Only the person themself can set it; the owner's PATCH /v1/people/:id below doesn't take it.
  if (method === "PATCH" && parts[1] === "people" && parts[2] === "me" && parts.length === 3) {
    const body = await readAuthorizedBody(req);
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    const focus = "deepWork" in body;
    if (focus && typeof body.deepWork !== "boolean") return fail(res, 400, "bad_request", "deepWork is true or false"), undefined;
    // The role someone says they have (job-roles.mjs): one from the list, or null for none. It only describes them.
    const roleSet = "jobRole" in body;
    if (roleSet && body.jobRole !== null && !validJobRole(body.jobRole)) return fail(res, 400, "bad_role", "Choose a role from the list"), undefined;
    if (!name && !focus && !roleSet) return fail(res, 400, "name_required", "Enter a name"), undefined;
    const since = mutateAuthenticated(req, (state, auth) => {
      const me = state.users[auth.user.id];
      if (roleSet) { if (body.jobRole === null) delete me.jobRole; else me.jobRole = body.jobRole; }
      if (name) {
        const clash = Object.values(state.users).find((u) => u.id !== auth.user.id && u.name.toLowerCase() === name.toLowerCase());
        if (clash) throw requestError(409, "name_taken", "Someone already uses that name. Try another");
        me.name = name;
      }
      const was = me.deepWorkSince;
      if (focus) setDeepWork(me, body.deepWork, now());
      return was;
    });
    try { if (name || roleSet) messaging?.personChanged(user.id); if (focus) messaging?.presenceChanged(user.id); } catch (e) { console.error("[servant] person update", e); }
    const deepWork = focus ? body.deepWork : inDeepWork(user);
    const jobRole = jobRoleOf(roleSet ? { jobRole: body.jobRole } : user);
    return send(res, 200, { user: { id: user.id, name: name || user.name, role: user.role, ...(jobRole ? { jobRole } : {}) }, deepWork });
  }
  // The onboarding tour (tour.mjs): what is true for this person on this server. Read only.
  if (method === "GET" && parts[1] === "tour" && parts.length === 2) {
    res.setHeader("Cache-Control", "no-store");
    const state = readState();
    const costs = tierCosts({ upstreams: cfg.upstreams, laneOf: tier => agentLane({ agentTier: tier }, cfg), mix: usageStore().mix({ since: now() - 30 * 24 * 60 * 60 * 1000 }) });
    return send(res, 200, tourFacts({ user, lane: agentLane(user, cfg), limitFor: person => usageStore().limitFor(person), costs, today: usageStore().leaderboard({ since: startOfDay(now()) }),
      tierOf: userId => agentTierOf(state.users[userId]), manager: managerOf(state, user), capabilities: capabilitySettings(cfg.agentCapabilities).mode, egress: egressSettings(cfg.agentEgress).mode, serverName: cfg.name, agentName: cfg.agentName }));
  }
  // Finished or skipped: the tour is not shown by itself again, on this device or any other. It stays in Settings.
  if (method === "POST" && parts[1] === "tour" && parts[2] === "seen" && parts.length === 3) {
    await readAuthorizedBody(req);
    mutateAuthenticated(req, (state, auth) => { delete state.users[auth.user.id].tourDue; });
    return send(res, 200, { tour: { due: false } });
  }
  // Someone who joined before email codes attaches a confirmed work email to their account. Once it is on file,
  // joining with that email on a new device signs in as them, and no one else can claim the address.
  if (method === "POST" && parts[1] === "people" && parts[2] === "me" && parts[3] === "email" && (parts.length === 4 || (parts.length === 5 && parts[4] === "confirm"))) {
    const body = await readAuthorizedBody(req);
    const settings = emailSettings(cfg);
    if (!settings.enabled) return fail(res, 404, "not_found", "Email codes are off"), undefined;
    const ip = clientIp(req);
    if (!pairAllowed(ip)) return fail(res, 429, "rate_limited", "Too many tries. Wait ten minutes"), undefined;
    const scope = `me:${user.id}`;
    const takenBy = (email) => Object.values(readState().users).some(u => u.id !== user.id && !isRemoved(u) && u.email && u.email.toLowerCase() === email.toLowerCase());
    try {
      if (parts.length === 4) {
        const wanted = normalizeEmail(body.email);
        if (wanted && takenBy(wanted)) return fail(res, 409, "email_taken", "That email already belongs to someone here"), undefined;
        const out = await emailVerifier.start({ email: body.email, inviteKey: scope }, settings);
        return send(res, 200, { challenge: out.id, email: out.email, expiresInSeconds: 600 });
      }
      const confirmed = emailVerifier.check({ id: body.challenge, code: body.code, inviteKey: scope });
      if (takenBy(confirmed)) return fail(res, 409, "email_taken", "That email already belongs to someone here"), undefined;
      mutateAuthenticated(req, (state, auth) => { state.users[auth.user.id].email = confirmed; state.users[auth.user.id].emailVerifiedAt = now(); sessions.verifiedNow(auth.device); });
      return send(res, 200, { ok: true, email: confirmed });
    } catch (error) {
      if (!error.status) throw error;
      return fail(res, error.status, error.code, error.message), undefined;
    }
  }
  if (method === "PATCH" && parts[1] === "people" && parts.length === 3 && parts[2] !== "me") {
    const body = await readAuthorizedBody(req);
    // Owners only (the `true` below): vibe coder, unlimited agent tokens (no daily cap), and
    // fixing someone's name (a typo at invite time).
    const flags = ["vibeCoder", "unlimitedTokens"].filter(k => k in body);
    const tierSet = "agentTier" in body;
    if (tierSet && (!Number.isInteger(body.agentTier) || body.agentTier < 0 || body.agentTier > MAX_AGENT_TIER)) return fail(res, 400, "bad_request", "agentTier is 0 (no agent), 1 (tester), 2 (business owner), 3 (software engineer), 4 (user researcher) or 5 (product manager)"), undefined;
    const rename = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 40) : null;
    const limitSet = "tokenLimit" in body;
    if (limitSet && body.tokenLimit !== null && !TOKEN_LIMIT_CHOICES.includes(body.tokenLimit)) return fail(res, 400, "bad_request", `tokenLimit is null (the tier's limit) or one of ${TOKEN_LIMIT_CHOICES.join(", ")}`), undefined;
    if ((!flags.length && !rename && !tierSet && !limitSet) || flags.some(k => typeof body[k] !== "boolean") || rename === "") return fail(res, 400, "bad_request", "Send a name, or vibeCoder/unlimitedTokens as true or false");
    // The daily limit someone actually has: none for the owner or "no limit", else their step or their tier's.
    const dailyLimit = u => u.role === "owner" || u.unlimitedTokens ? Infinity : agentTierOf(u) === 0 ? 0 : usageStore().limitFor(u);
    let raised = null;
    const person = mutateAuthenticated(req, (state) => {
      const target = state.users[parts[2]];
      if (!target) throw requestError(404, "not_found", "No such person");
      const before = dailyLimit(target);
      raised = () => { const after = dailyLimit(target); return after > before ? after : null; };
      if (rename && Object.values(state.users).some(u => u.id !== target.id && u.name.toLowerCase() === rename.toLowerCase())) throw requestError(409, "name_taken", "Someone already uses that name. Try another");
      if (rename) target.name = rename;
      if (tierSet) { target.agentTier = body.agentTier; if (body.agentTier === 2) target.vibeCoder = true; else delete target.vibeCoder; }
      if (!tierSet && "vibeCoder" in body) target.agentTier = body.vibeCoder ? 2 : Math.min(agentTierOf(target), 1);
      for (const k of flags) if (body[k]) target[k] = true; else delete target[k];
      if (limitSet) { if (body.tokenLimit === null) delete target.tokenLimit; else target.tokenLimit = body.tokenLimit; }
      raised = raised();
      return { id: target.id, name: target.name, agentTier: agentTierOf(target), vibeCoder: !!target.vibeCoder, unlimitedTokens: !!target.unlimitedTokens, tokenLimit: target.tokenLimit ?? null };
    }, true);
    if (rename) try { messaging?.personChanged(parts[2]); } catch (e) { console.error("[servant] person update", e); }
    // Only when it goes up: the agent congratulates them in their own conversation with it. Never blocks the change.
    if (raised) try { messaging?.congratulateLimit(parts[2], raised); } catch (e) { console.error("[servant] limit note", e); }
    return send(res, 200, { person });
  }
  if (method === "GET" && parts[1] === "work-log" && parts.length === 2) {
    res.setHeader("Cache-Control", "no-store");
    const items = [
      ...(messaging?.workLog(user) ?? []),
      ...(todosStore?.workLog(user) ?? []),
      ...(recordings?.workLog(user) ?? []),
    ].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    return send(res, 200, { items });
  }
  if (todosStore && parts[1] === "todos" && (await todosStore.handle(req, res, { user, device, method, parts, url, send, fail, readBody: readAuthorizedBody }))) return undefined;
  if (parts[1] === "file-drop" && (await fileDrop().handle(req, res, { user, method, parts, send, fail, readBody: readAuthorizedBody }))) return undefined;
  if (recordings && parts[1] === "recordings" && (await recordings.handle(req, res, { user, device, method, parts, send, fail, readBody: readAuthorizedBody }))) return undefined;
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
      ? Object.values(currentState.chats).filter(c => c.userId !== user.id && canReadChat(c, viewer) && chatListedFor(c, viewer))
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
      ...(url.searchParams.get("scope") === "org" ? { orgChats: (() => {
        const shown = others.filter(started), theirUnread = agentTurns.unreadOthers(user.id, shown.map(chat => chat.id));
        return sorted(shown.map(chat => {
          const { latestTurn, ...view } = withActivity(chat, chatView(chat, viewer, currentState.users));
          return { ...view, unread: theirUnread[chat.id] || 0 };
        }));
      })() } : {}),
    });
  }

  // Mark all as read: your own conversations and everyone else's you can see.
  if (method === "POST" && parts[2] === "read-all" && parts.length === 3) {
    requireAuth(req, readState());
    const viewer = currentState.users[user.id] || user;
    const seen = Object.values(currentState.chats).filter(c => c.userId !== user.id && !c.deletedAt && canReadChat(c, viewer) && chatListedFor(c, viewer));
    agentTurns.markAllChatsRead(user.id);
    agentTurns.markViewed(user.id, seen.map(c => c.id));
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && parts.length === 2) {
    const body = await readAuthorizedBody(req);
    const creator = requireAuth(req).user;
    const creationUp = upstreamFor(creator, cfg);
    if (!creationUp) return fail(res, 503, "agent_unavailable", "The agent isn't set up on this server yet");
    const lane = agentLane(creator, cfg);
    if (lane !== "owner") await verifyUpstream(lane, creationUp);
    // The phone may name the chat itself, so it can open it before this answers (app/src/lib/new-chat.ts).
    if (body.id !== undefined && (typeof body.id !== "string" || !/^cht_[A-Za-z0-9_-]{8,40}$/.test(body.id))) return fail(res, 400, "bad_request", "That chat id isn't valid");
    if (body.id && readState().chats[body.id]) return fail(res, 409, "conflict", "That chat already exists");
    const chatId = body.id || id("cht");
    // Vibe coders always build prototypes. Anyone else may start the chat in a project
    // they're in, or ask for vibe coding (a prototype with a preview link) from the list.
    const tier = agentTierOf(readState().users[creator.id]);
    if (tier === 0) return fail(res, 403, "no_agent", noAgentMessage);
    const vibe = lane !== "researcher" && (tier === 2 || (tier === 3 && body.mode === "vibe"));
    if (vibe && !vibeProject()) return fail(res, 503, "vibe_unavailable", "Prototyping isn't set up on this server");
    // Old builds send folderId, or project with ids this server may no longer know.
    const wanted = lane === "researcher" ? null : (body.projectId ?? body.folderId ?? (projects().byId(body.project) ? body.project : null));
    if (!vibe && wanted != null && !projectFor(creator, wanted)) return fail(res, 404, "not_found", "No such project");
    const projectId = vibe ? VIBE_PROJECT : wanted;
    // People invited from the start see the whole chat. Unknown or removed people are refused before the agent is asked.
    const invitees = [...new Set(Array.isArray(body.memberIds) ? body.memberIds : [])].filter(v => v !== creator.id);
    if (invitees.some(v => typeof v !== "string")) return fail(res, 400, "bad_request", "memberIds must be people's ids");
    { const people = readState().users; if (invitees.some(v => !people[v] || isRemoved(people[v]))) return fail(res, 404, "not_found", "That person isn't on this server"); }
    const hermesSessionId = `servant_${creator.id}_${chatId}`;
    const r = await hermes(creationUp, "POST", "/api/sessions", { id: hermesSessionId, title: `Servant · ${creator.name} · ${chatId.slice(-6)}` });
    if (!r.ok) return fail(res, 502, "agent_error", `The agent didn't start a chat (${r.status})`);
    const chat = {
      id: chatId,
      userId: creator.id,
      role: lane === "researcher" ? "researcher" : creator.role,
      hermesSessionId,
      title: String(body.title || "New chat").slice(0, 80),
      // Always private to start. Sharing with the server or the project is a later choice, per chat.
      shared: false,
      ...(projectId ? { projectId } : {}),
      ...(invitees.length ? { members: invitees.map(userId => ({ userId, since: 0, invitedAt: now(), invitedBy: creator.id })) } : {}),
      ...(vibe ? { mode: "vibe", vibeFolder: newFolder(), hosted: "server" } : {}),
      createdAt: now(),
      updatedAt: now(),
    };
    try {
      mutateAuthenticated(req, (state, current) => {
        if (current.user.role !== creator.role || current.user.id !== creator.id) throw requestError(403, "forbidden", "Your access changed. Start a new chat");
        if (state.chats[chatId]) throw requestError(409, "conflict", "That chat already exists");
        state.chats[chatId] = chat;
      });
    } catch (error) {
      // The upstream call ran outside the transaction. Do not retain an orphan
      // session if the device was revoked while that call was pending.
      void hermes(creationUp, "DELETE", `/api/sessions/${encodeURIComponent(hermesSessionId)}`).catch(() => {});
      throw error;
    }
    return send(res, 201, { chat: chatView(chat, creator, readState().users) });
  }

  const viewer = currentState.users[user.id] || user;
  const visible = currentState.chats[parts[2]];
  const joining = !!visible && visible.userId !== user.id && mayTakePart(visible, viewer)
    && ((parts[3] === "messages" && parts.length === 4 && method === "POST") || (parts[3] === "messages" && parts[5] === "reactions" && parts.length === 6) || parts[3] === "uploads" || parts[3] === "turns");
  if (visible && visible.userId !== user.id && !joining && canReadChat(visible, viewer)) {
    // Someone else's shared chat (or any chat, for the owner): read only.
    // A shared chat's messages can be forwarded to a channel or DM for feedback.
    if (method === "POST" && parts[3] === "messages" && parts[5] === "forward" && parts.length === 6 && chatShared(visible)) {
      return forwardChatMessage(req, res, { chat: visible, author: currentState.users[visible.userId], user: viewer, device, messageId: parts[4], cfg, readAuthorizedBody });
    }
    if (method !== "GET" || !["messages", "media", undefined].includes(parts[3]) || parts.length > 4) {
      return fail(res, 403, "read_only", "Only the person who started this chat can do that");
    }
    // Someone invited in sees only from the point the author chose; the rest stays, just not for them.
    const from = chatVisibleFrom(visible, viewer);
    const history = chatMediaStore().history(visible.id).filter(m => (m.at || 0) >= from);
    if (parts.length === 3) return send(res, 200, { chat: chatView(visible, viewer, currentState.users) });
    if (parts[3] === "media") {
      const author = currentState.users[visible.userId];
      const items = chatMediaStore().media(visible.id, { id: visible.userId, name: author?.name || "Former member" }, cfg.agentName || "Agent").filter(m => (m.createdAt || 0) >= from);
      return send(res, 200, mediaPage(items, url.searchParams));
    }
    const sources = agentTurns.messageSources(visible.id);
    const posters = { byMessage: agentTurns.messagePosters(visible.id), users: currentState.users, authorId: visible.userId };
    agentTurns.markViewed(user.id, [visible.id]);
    const connects = connectParts(visible.id, viewer, cfg);
    return send(res, 200, { chat: chatView(visible, viewer, currentState.users), messages: history.map(message => withConnect(privateMessageView(message, viewer, sources, posters), connects)), latestTurn: null, upstreamUnavailable: false });
  }
  const chat = joining ? visible : mine.find((c) => c.id === parts[2]);
  if (!chat) return fail(res, 404, "not_found", "No such chat");

  if (method === "GET" && parts.length === 3) return send(res, 200, { chat: chatView(chat, user) });

  if (method === "PATCH" && parts.length === 3) {
    const body = await readAuthorizedBody(req);
    // Old builds say folderId/folderShared; they mean the project.
    const hasProject = Object.hasOwn(body, "projectId") || Object.hasOwn(body, "folderId");
    const nextProject = Object.hasOwn(body, "projectId") ? body.projectId : body.folderId;
    const hasProjectShared = Object.hasOwn(body, "projectShared") || Object.hasOwn(body, "folderShared");
    const nextShared = Object.hasOwn(body, "projectShared") ? body.projectShared : body.folderShared;
    const hasTitle = Object.hasOwn(body, "title");
    const nextTitle = hasTitle ? cleanChatTitle(body.title) : "";
    if (hasTitle && (typeof body.title !== "string" || !nextTitle)) return fail(res, 400, "bad_request", "Give the chat a name");
    if (typeof body.shared !== "boolean" && !hasProject && !hasProjectShared && !hasTitle) return fail(res, 400, "bad_request", "shared must be true or false");
    if (typeof body.shared !== "boolean" && body.shared !== undefined) return fail(res, 400, "bad_request", "shared must be true or false");
    if (hasProjectShared && typeof nextShared !== "boolean") return fail(res, 400, "bad_request", "projectShared must be true or false");
    if (hasProject && nextProject !== null && !validProjectId(nextProject)) return fail(res, 400, "bad_request", "projectId must be a project or null");
    if (body.shared && chat.privateForward) return fail(res, 409, "forward_private", "This chat includes a message from a private conversation, so it stays private");
    let updated;
    mutateAuthenticated(req, (state, current) => {
      updated = requireChat(state, current.user.id, chat.id);
      if (typeof body.shared === "boolean") updated.shared = body.shared;
      // Named by hand: the agent never renames it after this.
      if (hasTitle) { updated.title = nextTitle; updated.titledBy = "user"; }
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
  // Edit mode in the preview: the app hands over the tweaks someone made (words, color, size, spacing) and they go
  // into the page's source, so the agent and everyone with the link see them. Only the chat's own person, only its pages.
  if (method === "POST" && parts[3] === "prototype" && parts.length === 4) {
    if (chat.mode !== "vibe" || chat.hosted !== "server" || !chat.vibeFolder) return fail(res, 404, "not_found", "This chat has no prototype to edit");
    const body = await readAuthorizedBody(req, 512 * 1024);
    try { return send(res, 200, { ok: true, ...savePrototypePage(PROTOTYPES_DIR, chat.vibeFolder, body.path, { edits: body.edits, styles: body.styles }) }); }
    catch (e) { return fail(res, e.status || 500, e.status === 404 ? "not_found" : "bad_request", e.message || "Couldn't save the page"); }
  }
  // Share the prototype with a business owner (docs/prototype-reviews.md): they get a link by email, confirm a code
  // sent to that address, and can then see it and comment on it. Only the chat's own person shares, lists or ends.
  // Hand one reviewer's comment to the agent, in this chat (docs/prototype-reviews.md). Only the chat's own person.
  // The sharer dealt with a comment themselves: it leaves the chat's waiting list and stays on record.
  if (parts[3] === "prototype" && parts[4] === "comments" && parts[6] === "set-aside" && parts.length === 7 && method === "POST") {
    await readAuthorizedBody(req);
    const current = requireAuth(req).user;
    if (chat.userId !== current.id) return fail(res, 403, "forbidden", "Only the person who made this prototype can set its comments aside");
    const reviews = prototypeReviews();
    if (!reviews.commentOf(parts[5], chat.id)) return fail(res, 404, "not_found", "That comment is no longer here");
    reviews.setAside(parts[5], chat.id);
    return send(res, 200, { comment: (({ id, setAsideAt }) => ({ id, setAsideAt }))(reviews.commentOf(parts[5], chat.id)) });
  }
  if (parts[3] === "prototype" && parts[4] === "comments" && parts[6] === "work" && parts.length === 7 && method === "POST") {
    await readAuthorizedBody(req);
    const current = requireAuth(req).user;
    if (chat.userId !== current.id) return fail(res, 403, "forbidden", "Only the person who made this prototype can ask the agent to work on its comments");
    const reviews = prototypeReviews();
    const comment = reviews.commentOf(parts[5], chat.id);
    const share = comment && reviews.get(comment.shareId);
    if (!comment || !share) return fail(res, 404, "not_found", "That comment is no longer here");
    const asked = askAgentAboutComment(share, comment, current, current.id, cfg);
    if (asked.refused) return fail(res, 409, "not_asked", asked.refused);
    return send(res, 200, { comment: (({ id, askedAt, askedBy, turnId }) => ({ id, askedAt, askedBy, turnId }))(reviews.commentOf(comment.id, chat.id)), turn: asked.turn });
  }
  if (parts[3] === "prototype" && parts[4] === "shares" && (parts.length === 5 || parts.length === 6)) {
    if (chat.userId !== user.id) return fail(res, 403, "forbidden", "Only the person who made this prototype can share it");
    if (chat.mode !== "vibe" || chat.hosted !== "server" || !chat.vibeFolder) return fail(res, 404, "not_found", "This chat has no prototype to share");
    const reviews = prototypeReviews();
    const listing = () => {
      const comments = reviews.comments({ chatId: chat.id });
      // The outside reviewers named on the project prototypes are built in, who don't have an open link to this one yet.
      const open = new Set(reviews.forChat(chat.id).filter(s => !s.endedAt).map(s => s.email));
      const suggested = outsideReviewers(vibeProject()).filter(r => !open.has(r.email));
      return { suggested, autoWorkChecked: autoWorkChecked(cfg, user), shares: reviews.forChat(chat.id).map(s => ({ id: s.id, email: s.email, createdAt: s.createdAt, ...(s.verifiedAt ? { verifiedAt: s.verifiedAt } : {}), ...(s.lastSeenAt ? { lastSeenAt: s.lastSeenAt } : {}), ...(s.endedAt ? { endedAt: s.endedAt } : {}), autoWork: s.autoWork,
        comments: comments.filter(c => c.shareId === s.id).map(c => ({ id: c.id, page: c.page, x: c.x, y: c.y, anchor: c.anchor, text: c.text, createdAt: c.createdAt,
          ...(c.askedAt ? { askedAt: c.askedAt, askedBy: c.askedBy === "auto" ? "auto" : "you", turnId: c.turnId } : {}), ...(c.setAsideAt ? { setAsideAt: c.setAsideAt } : {}) })) })) };
    };
    if (method === "GET" && parts.length === 5) return send(res, 200, listing());
    if (method === "POST" && parts.length === 5) {
      const body = await readAuthorizedBody(req);
      try { await sharePrototype(chat, body.email, user, cfg, { autoWork: body.autoWork === true }); }
      catch (e) { if (!e.status) throw e; return fail(res, e.status, e.code, e.message); }
      return send(res, 201, listing());
    }
    // Whether the agent starts on this reviewer's comments as they arrive. Off unless the sharer turns it on.
    if (method === "PATCH" && parts.length === 6) {
      const body = await readAuthorizedBody(req);
      if (typeof body?.autoWork !== "boolean") return fail(res, 400, "bad_request", "autoWork is true or false");
      if (!reviews.setAutoWork(parts[5], chat.id, body.autoWork)) return fail(res, 404, "not_found", "That share has ended");
      return send(res, 200, listing());
    }
    if (method === "DELETE" && parts.length === 6) {
      requireAuth(req);
      if (!reviews.end(parts[5], chat.id, user.id)) return fail(res, 404, "not_found", "That share has already ended");
      return send(res, 200, listing());
    }
    return fail(res, 404, "not_found", "No such route");
  }
  // Invite people into the chat (read only), with how much of what came before they see:
  // none, the last day, the last week or all of it. Only the author invites or removes.
  if (method === "POST" && parts[3] === "members" && parts.length === 4) {
    const body = await readAuthorizedBody(req);
    const ids = Array.isArray(body.userIds) ? body.userIds : body.userId ? [body.userId] : null;
    if (!ids || !ids.length || ids.some(v => typeof v !== "string")) return fail(res, 400, "bad_request", "Choose who to add");
    const history = body.history ?? "all";
    if (!Object.hasOwn(CHAT_HISTORY, history)) return fail(res, 400, "bad_request", "history must be none, day, week or all");
    const updated = mutateAuthenticated(req, (state, current) => {
      const active = requireChat(state, current.user.id, chat.id);
      if (active.privateForward) throw requestError(409, "forward_private", "This chat includes a message from a private conversation, so it stays private");
      const at = now(), span = CHAT_HISTORY[history];
      const since = span === Infinity ? 0 : span === null ? at : at - span;
      const members = [...(active.members || [])];
      for (const userId of new Set(ids)) {
        if (userId === active.userId) continue;
        const person = state.users[userId];
        if (!person || isRemoved(person)) throw requestError(404, "not_found", "That person isn't on this server");
        const existing = members.findIndex(m => m.userId === userId);
        const entry = { userId, since, invitedAt: at, invitedBy: current.user.id };
        if (existing >= 0) members[existing] = entry; else members.push(entry);
      }
      active.members = members;
      return { chat: { ...active }, users: state.users };
    });
    return send(res, 200, { chat: chatView(updated.chat, user, updated.users) });
  }
  if (method === "DELETE" && parts[3] === "members" && parts.length === 5) {
    const updated = mutateAuthenticated(req, (state, current) => {
      const active = requireChat(state, current.user.id, chat.id);
      active.members = (active.members || []).filter(m => m.userId !== parts[4]);
      if (!active.members.length) delete active.members;
      return { chat: { ...active }, users: state.users };
    });
    return send(res, 200, { chat: chatView(updated.chat, user, updated.users) });
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
    // Records preservation: copy the whole chat into the archive FIRST. If that fails, nothing is deleted and the person is told.
    if (recordsPreservationEnabled(cfg.recordsPreservation)) {
      try { preserveAgentChat(chat, user); }
      catch (e) { console.error("[servant] records preservation failed; chat not deleted:", e?.message || e); return fail(res, 503, "records_preservation_failed", "This chat can't be deleted right now because its record could not be saved. Try again, or ask your administrator."); }
    }
    mutateAuthenticated(req, (state, current) => { requireChat(state, current.user.id, chat.id).deletedAt = now(); });
    chatMediaStore().deleteChat(chat.id);
    documents().deleteChat(chat.id);
    // The prompts, replies and every streamed delta live in the turns database too, not only in the chat record.
    agentTurns?.deleteChat(chat.id);
    removeLongMessages(chat.id);
    if (chat.hosted === "server") removePrototype(PROTOTYPES_DIR, chat.vibeFolder, { keep: recordsPreservationEnabled(cfg.recordsPreservation) });
    // Every review link for it stops working. The comments stay on record.
    if (chat.hosted === "server") prototypeReviews().endChat(chat.id, user.id);
    hermes(chatUp, "DELETE", `/api/sessions/${encodeURIComponent(chat.hermesSessionId)}`).catch(() => {});
    return send(res, 200, { ok: true });
  }

  let upstreamUnavailable = false;
  const syncChatHistory = async (allowOffline = false) => {
    const cached = () => {
      const latest = readState();
      requireChatParticipant(latest, requireAuth(req, latest).user.id, chat.id);
      upstreamUnavailable = true;
      return chatMediaStore().history(chat.id);
    };
    if (agentRole(chat.role, cfg) !== "owner") {
      try { await verifyUpstream(agentRole(chat.role, cfg), chatUp); }
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
    requireChatParticipant(latest, requireAuth(req, latest).user.id, chat.id);
    const messages = data.messages ?? data.data;
    if (!Array.isArray(messages)) throw requestError(502, "agent_error", "The agent returned invalid message history");
    // Hermes keeps each reply as the agent wrote it. What is saved here has the person's saved values hidden and the
    // agent's requests for a connection taken out, the same as the copy saved when the reply arrived.
    const hide = replyCleaner([chat.userId, user.id]);
    return chatMediaStore().sync(chat.id, messages.map(message => cleanUpstreamMessage(message, hide)), generation);
  };

  // The author has seen every finished reply (others reading a shared chat never get here).
  if (method === "POST" && parts[3] === "read" && parts.length === 4) {
    requireChatParticipant(readState(), requireAuth(req).user.id, chat.id);
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
    const posters = { byMessage: agentTurns.messagePosters(chat.id), users: readState().users, authorId: chat.userId };
    const connects = connectParts(chat.id, current.user, cfg);
    return send(res, 200, { messages: messages.map(message => withConnect(privateMessageView(message, current.user, sources, posters), connects)), latestTurn, upstreamUnavailable });
  }

  if (method === "GET" && parts[3] === "media" && parts.length === 4) {
    await syncChatHistory(true);
    const sender = { id: user.id, name: user.name };
    return send(res, 200, mediaPage(chatMediaStore().media(chat.id, sender, cfg.agentName || "Agent"), url.searchParams));
  }

  const ownTurn = turnId => {
    const latest = readState();
    const current = requireAuth(req, latest);
    requireChatParticipant(latest, current.user.id, chat.id);
    if (!agentTurns.owns(turnId, chat.id, current.user.id)) throw requestError(404, "not_found", "No such turn");
    return current;
  };
  if (parts[3] === "turns") {
    if (method === "GET" && parts.length === 4) return send(res, 200, { turns: agentTurns.latest(chat.id) });
    const current = ownTurn(parts[4]);
    // One turn with every step it took: what "Worked for 12 seconds" opens to once the reply is done.
    // The list above only counts a finished turn's steps, so the poll every device makes stays small.
    if (method === "GET" && parts.length === 5) return send(res, 200, { turn: agentTurns.detail(parts[4]) });
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

  // A reaction on a message in the chat, the same twelve as in channels. Only stored messages, not a reply still being written.
  if (method === "POST" && parts[3] === "messages" && parts[5] === "reactions" && parts.length === 6) {
    const { emoji, active } = await readAuthorizedBody(req);
    if (!CHAT_REACTIONS.includes(emoji) || typeof active !== "boolean") return fail(res, 400, "invalid_reaction", "Choose a supported reaction");
    const reactions = chatMediaStore().react(chat.id, parts[4], user.id, emoji, active);
    if (!reactions) return fail(res, 404, "not_found", "That message is gone");
    return send(res, 200, { reactions });
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
    // A token typed into chat is not stored or sent to the agent: it belongs in Connections (docs/connections.md).
    const tokenTyped = tokenRefusal(ownText);
    if (tokenTyped) return fail(res, 400, "secret_in_chat", tokenTyped);
    // Warn before personal information is saved (pii-gate.mjs); the person can send anyway.
    if (body.confirmPii === true && body.reportFalseAlarm === true && ownText && reportingEnabled(cfg.piiWarning)) {
      // Sent anyway, and the person says the warning was wrong: queue it for the owner to review (business-reports.mjs).
      void reportFalseAlarm({ store: reports, userId: user.id, text: ownText, verdict: businessVerdict, personal: screenText });
    }
    if (body.confirmPii !== true && ownText && piiWarningEnabled(cfg.piiWarning)) {
      const warn = await screenMessage(ownText, cfg.piiWarning);
      if (warn) return fail(res, 409, "pii_warning", warn.message, { types: warn.types || [], ...(warn.business && reportingEnabled(cfg.piiWarning) ? { reportable: true } : {}) });
    }
    // Only the full agent can read a saved long message from disk.
    const limit = agentRole(chat.role, cfg) === "owner" ? MAX_MESSAGE_CHARS : INLINE_MESSAGE_CHARS;
    if (text.length > limit) return fail(res, 413, "too_long", "That message is too long");
    const prior = agentTurns.replay({ chat, text, attachments, requestId: body.requestId });
    if (prior) return streamPrivateTurn(req, res, prior.id, () => ownTurn(prior.id));
    if (usageStore().overLimit(user)) return fail(res, 429, "usage_limit", limitText(user));
    // Establish history before the worker records new accepted deliveries.
    await syncChatHistory();
    const turn = mutateAuthenticated(req, (state, current) => {
      const active = requireChatParticipant(state, current.user.id, chat.id);
      if (privateForward && (chatShared(active) || active.projectShared || active.members?.length)) throw requestError(409, "forward_private", "Messages from private conversations go into a private chat");
      const queued = agentTurns.enqueue({ chat: active, user: current.user, device: current.device, text, attachments, requestId: body.requestId });
      if (privateForward) active.privateForward = true;
      if (active.title === "New chat" && active.titledBy !== "user") active.title = (ownText || (body.forward != null ? `About: ${text.split("\n")[1]?.replace(/^> /, "") || "a message"}` : "") || text || attachments[0].name).replace(/\s+/g, " ").slice(0, 60);
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
      if (!mayTakePart(latest.chats[chat.id], current.user)) throw requestError(404, "not_found", "No such chat");
      return current;
    });
  }

  return fail(res, 404, "not_found", `This server has no ${method} ${url.pathname}. The app may be newer than the server`);
}

function streamPrivateTurn(req, res, turnId, authorize, after = 0) {
  authorize();
  const sources = agentTurns.turnMessageSources(turnId);
  const posterByMessage = agentTurns.turnMessagePosters(turnId);
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
        const turnChat = readState().chats[agentTurns.get(turnId)?.chatId];
        const posters = { byMessage: posterByMessage, users: readState().users, authorId: turnChat?.userId };
        for (const event of events) {
          const payload = event.event === 'sent'
            ? { ...event.payload, message: privateMessageView(event.payload.message, current?.user, sources, posters) }
            : event.event === 'message' ? withConnect(privateMessageView(event.payload, current?.user, sources, posters), connectParts(turnChat?.id, current?.user, loadConfig())) : event.payload;
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
  const chat = requireChatParticipant(initial, turn.user_id, turn.chat_id);
  if (!user || !device || (chat.role === "owner" && user.role !== "owner")) throw requestError(403, "forbidden", "Access changed before this turn started");
  // Someone moved to Researcher can't keep using an older chat that runs on the full or member agent.
  if (user.role !== "owner" && agentTierOf(user) === RESEARCHER_TIER && chat.role !== "researcher") throw requestError(403, "forbidden", "Your access changed. Start a new chat");
  const up = upstreamFor({ role: turn.role }, cfg);
  if (!up) throw requestError(502, "agent_error", "The agent is unavailable");
  const full = agentRole(turn.role, cfg) === "owner";
  if (!full) await verifyUpstream(agentRole(turn.role, cfg), up);
  else await requireEntitlementChecks(cfg, up, user);
  if (!turn.run_id && usageStore().overLimit(user)) throw requestError(429, "usage_limit", limitText(user));
  const durable = !!turn.run_id || await supportsDurableRuns(up);
  // Legacy owner agents can read the exact saved input instead of receiving
  // altered chunks. Restricted agents never receive a local-file fallback.
  const text = agentText(turn, full, durable ? INLINE_MESSAGE_CHARS : TEXT_PART_CHARS);
  const files = agentFiles(turn, full);
  const input = hermesInput(files ? (text ? `${text}\n\n${files}` : files) : text, turn.attachments, { durable, full });
  // Everything the agent writes back is cleaned before it is saved or shown: this person's saved values and anything
  // shaped like a known token become "[hidden]", and a request for a connection becomes the form, not text.
  const hide = replyCleaner([turn.user_id]);
  const deltas = createTextStream(piece => stripConnectMarkers(hide(piece)), hide);
  const headers = full ? await turnHeaders(cfg, turn.user_id, turn.chat_id) : {};
  const instructions = full ? [chatContext(chat), connectionNotes(turn.user_id, turn.chat_id)].filter(Boolean).join("\n\n") : chatContext(chat);
  let assistantMessage;
  let todoFinished = false;
  const saveAssistant = content => {
    if (assistantMessage) return;
    const latest = readState();
    const active = latest.chats[turn.chat_id];
    if (!mayTakePart(active, latest.users[turn.user_id])) throw requestError(404, "not_found", "That chat is gone");
    const normalized = normalizeMediaContent(content);
    const marked = readDoneTag(normalized.text);
    todoFinished = marked.done;
    const asked = readConnectMarkers(hide(marked.text), connectionTools());
    normalized.text = asked.text;
    assistantMessage = active.deletedAt
      ? { id: id("msg"), role: "assistant", text: normalized.text, at: now(), attachments: [] }
      : chatMediaStore().accept(turn.chat_id, "assistant", normalized.text, normalized.attachments, turn.id);
    // The agent asked for a connection this person doesn't have: the form goes on this message. Only the full agent
    // can use one, and a request that can't be recorded is dropped rather than failing the reply.
    if (full && !active.deletedAt) for (const type of asked.types) {
      try { connectionStore().request(turn.user_id, turn.chat_id, type, assistantMessage.id); }
      catch (error) { console.error("[servant] connections: could not record the agent's request:", error.message); }
    }
    hooks.emit("message", assistantMessage);
  };
  const onAccepted = () => {
    const latest = readState();
    requireChatParticipant(latest, turn.user_id, turn.chat_id);
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
    if (name === "assistant.delta") {
      if (payload.delta) { if (activity !== WRITING_LINE) step(WRITING_LINE); setActivity(WRITING_LINE); }
      // Cleaned a whole word at a time, so a token split across two pieces is still hidden.
      const text = deltas.push(payload.delta || "");
      if (text) hooks.emit("delta", { text });
      return;
    }
    // Anything else ends the run of words: what was held back for cleaning goes out first.
    const held = deltas.flush();
    if (held) hooks.emit("delta", { text: held });
    if (name === "tool.started") { const line = toolStatusLine(payload.tool_name, { full }); step(line, typeof payload.preview === "string" ? hide(payload.preview) : ""); setActivity(line); }
    else if (name === "reasoning.available" || (name === "tool.progress" && payload.tool_name === "_thinking")) { step(THINKING_LINE, hide(payload.text ?? payload.delta)); setActivity(THINKING_LINE); }
    else if (name === "run.started" || name === "tool.completed" || name.startsWith("reasoning.")) setActivity(THINKING_LINE);
    else if (name === "assistant.completed") saveAssistant(payload.content || "");
    else if (name === "run.completed") {
      const source = (Array.isArray(payload.messages) ? payload.messages : []).findLast(m => m.role === "assistant" && (m.content || m.text));
      if (assistantMessage && source) chatMediaStore().identify(assistantMessage.id, source.content ?? source.text);
    } else if (name === "approval.request") {
      if (!full) throw requestError(403, "forbidden", "Member agents cannot request privileged approvals");
      hooks.emit("approval", { approval: { id: payload.approval_id, command: hide(String(payload.command || "")).slice(0, 8000),
        description: hide(String(payload.description || payload.reason || "Allow this action on your Mac?")).slice(0, 2000), choices: ["once", "deny"] } });
    } else if (name === "approval.responded") {
      const current = hooks.controls().approval;
      if (current && (!payload.approvalId || current.id === payload.approvalId)) hooks.emit("approval_resolved", { approvalId: current.id });
    } else if (name === "error") hooks.emit("error", { message: "The agent hit a problem. Try again" });
  };
  let result;
  if (durable) {
    if (turn.run_id && !turn.accepted) onAccepted();
    const canSteer = full && await supportsSteer(up);
    // The app reads this off the turn: a message sent now joins this reply, or waits for it to finish.
    hooks.steerable?.(canSteer);
    // The steer is now part of this conversation: show it as a sent message. The text comes from the run loop,
    // not a lookup here: this runs in the worker, which has no journal of its own beyond these hooks.
    const steered = (steerId, text) => {
      chatMediaStore().accept(turn.chat_id, "user", text, [], steerId);
      hooks.steered?.(steerId);
    };
    result = await runDurableHermes({ up, sessionId: turn.session_id, input, sessionKey: sessionKey(user, turn.chat_id), instructions, runId: turn.run_id, headers,
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
      usage => recordUsage({ eventId: `chat:${turn.id}`, userId: turn.user_id, source: "chat", chatId: turn.chat_id, text: turn.text, usage }), instructions, headers);
    if (!assistantMessage && answer) saveAssistant(answer);
    result = { status: "completed" };
  }
  mutateState(state => { const current = state.chats[turn.chat_id]; if (current && !current.deletedAt) current.updatedAt = now(); });
  const completedChat = readState().chats[turn.chat_id];
  if (result.status === "completed" && todoFinished && completedChat?.userId === turn.user_id && !completedChat.deletedAt) todosStore?.agentDone(turn.chat_id, turn.id);
  // After a while the agent names the chat in a few words (chat-title.mjs). It runs on its own; the reply never waits for it.
  if (result.status === "completed" && completedChat && !completedChat.deletedAt) void nameChat(turn.chat_id);
  return { status: result.status, unreadSteers: result.unreadSteers, notification: assistantMessage && (assistantMessage.text || assistantMessage.attachments.length) ? {
    kind: "agent", eventId: turn.id, chatId: turn.chat_id, userId: turn.user_id,
    text: assistantMessage.text || (assistantMessage.attachments.some(a => a.mime.startsWith("video/")) ? "Sent a video" : "Sent an image"),
  } : undefined };
}

// Runs in a separate worker so deploying/restarting the API cannot lose a report. No AI: the report becomes a GitHub issue.
const ghExec = (args, input) => new Promise((resolve, reject) => {
  const child = execFile("gh", args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  if (input !== undefined) child.stdin.end(input);
});
export async function runFeedback(report) {
  return fileIssue(report, { repo: loadConfig().feedbackRepo, exec: ghExec });
}

function createServices(fixedCfg, { externalWorker = false, autoDrain = true } = {}) {
  process.umask(0o077); // messages.db and its WAL files are private to this user
  glossaryConfig = fixedCfg;
  store();
  let servicePush;
  const readLink = createLinkPreviews();
  const serviceMessaging = createMessaging({
    linkPreview: link => (fixedCfg || loadConfig()).linkPreviews === false ? null : readLink(link),
    file: path.join(DATA_DIR, "messages.db"),
    externalWorker,
    users: () => activeUsers(readState()),
    managerOf: person => managerOf(readState(), person)?.id || null,
    onMessage: event => servicePush.enqueue(event),
    agentName: () => (fixedCfg || loadConfig()).agentName || "Agent",
    features: () => normalizeFeatures((fixedCfg || loadConfig()).features),
    emailChecks: () => emailSettings(fixedCfg || loadConfig()).enabled,
    piiWarning: () => { const c = (fixedCfg || loadConfig()).piiWarning; return piiWarningEnabled(c) ? c : false; },
    // A token typed into a channel or a direct message is refused, not stored (docs/connections.md).
    refuseText: tokenRefusal,
    // Sent anyway and marked "this wasn't sensitive": queued for the owner to review (business-reports.mjs).
    reportFalseAlarm: (userId, text) => reportFalseAlarm({ store: reports, userId, text, verdict: businessVerdict, personal: screenText }),
    recordsPreservation: () => recordsPreservationEnabled((fixedCfg || loadConfig()).recordsPreservation),
    // Dollars beside a limit, for owners: each role's agent prices and this server's last 30 days of tokens in and out.
    tierCosts: () => {
      const cfg = fixedCfg || loadConfig();
      return tierCosts({ upstreams: cfg.upstreams, laneOf: tier => agentLane({ agentTier: tier }, cfg), mix: usageStore().mix({ since: Date.now() - 30 * 24 * 60 * 60 * 1000 }) });
    },
    // Channels use the same agent as private chats: full access unless the
    // server is set to "agentAccess": "limited".
    onUsage: recordUsage,
    // @agent in a channel or DM asked for real work: open a shared agent chat for the person who
    // asked, with the conversation as its first message, and start the agent on it.
    startWorkChat: workChatStarter = async ({ userId, deviceId, title, where, transcript, projectId, shared = true, beforeEnqueue, asWritten = false }) => {
      const cfg = fixedCfg || loadConfig();
      const state = readState();
      const user = state.users[userId];
      if (!user) throw new Error("that person is gone");
      const device = Object.values(state.devices).find(d => d.id === deviceId && d.userId === userId && !d.revokedAt)
        ?? Object.values(state.devices).find(d => d.userId === userId && !d.revokedAt);
      if (!device) throw new Error("no signed-in device");
      const projectData = projects().read();
      const project = projectId ? projectData.projects.find(p => p.id === projectId) : null;
      if (projectId && (!project || !accessOf(project, user, activeUsers(state), projectData.people).visible)) throw requestError(404, "not_found", "That project is no longer available");
      const up = upstreamFor(user, cfg);
      if (!up) throw new Error("the agent isn't set up");
      const chatId = id("cht"), hermesSessionId = `servant_${user.id}_${chatId}`;
      const made = await hermes(up, "POST", "/api/sessions", { id: hermesSessionId, title: `Servant · ${user.name} · ${chatId.slice(-6)}` });
      if (!made.ok) throw new Error(`agent ${made.status}`);
      const chat = { id: chatId, userId: user.id, role: agentLane(user, cfg) === "researcher" ? "researcher" : user.role, hermesSessionId, title: title.slice(0, 80), shared,
        ...(project ? { projectId: project.id } : {}),
        startedAt: now(), createdAt: now(), updatedAt: now(), fromConversation: where };
      // Link and recheck the todo before publishing the chat or exposing its turn to a worker.
      beforeEnqueue?.(chat);
      mutateState(s => { s.chats[chatId] = chat; });
      // A message the person wrote themselves (through /api/v1/) goes to the agent as they wrote it.
      const text = (asWritten ? transcript : `${user.name} asked for this in ${where}. Do the work here${shared ? "; others can follow along" : ""}.\n\n${transcript}`).slice(0, INLINE_MESSAGE_CHARS);
      const turn = serviceTurns.enqueue({ chat, user, device, text, attachments: [] });
      chat.firstTurnId = turn.id;
      return chat;
    },
    askAgent: async ({ sessionId, sessionKey: key, fresh, text, restartText, attachments, onDelta, onUsage = () => {}, userId }) => {
      if (usageStore().overLimit(readState().users[userId])) return limitText(readState().users[userId]);
      const cfg = fixedCfg || loadConfig();
      // A researcher's @agent runs on the researcher agent too, never the full one.
      const asker = readState().users[userId];
      const lane = asker ? agentLane(asker, cfg) : "member";
      const up = lane === "researcher" ? upstreamFor(asker, cfg) : upstreamFor({ role: "member" }, cfg);
      if (!up) return "The agent isn't set up on this server yet";
      if (lane === "researcher") await verifyResearcherUpstream(up);
      else if (!fullAgentAccess(cfg)) await verifyMemberUpstream(up);
      else await requireEntitlementChecks(cfg, up, asker);
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
      // A thread's session is shared by whoever mentions the agent in it; each reply is the asker's: their own
      // connections reach its commands, and their saved values are hidden in what it writes. A channel has no form
      // for a missing connection, so the agent is only told what it has.
      const fullTurn = lane !== "researcher" && fullAgentAccess(cfg);
      const hide = replyCleaner([userId]);
      const pieces = createTextStream(piece => stripConnectMarkers(hide(piece)), hide);
      const answer = await whileWorkingFor(cfg, userId, async () => streamTurn(up, sessionId, hermesInput(text, attachments), key, (name, p) => {
        if (name !== "assistant.delta") return;
        const piece = pieces.push(p.delta || "");
        if (piece) onDelta(piece);
      }, () => false, () => {}, onUsage, fullTurn ? connectionNotes(userId, sessionId, { ask: false }) : "", fullTurn ? await turnHeaders(cfg, userId, sessionId) : {}));
      const reply = normalizeMediaContent(answer);
      return { ...reply, text: readConnectMarkers(hide(reply.text), connectionTools()).text };
    },
  });
  todosStore = createTodos({
    db: serviceMessaging.db,
    legacyFile: path.join(DATA_DIR, "todos", "todos.db"),
    recordsPreservation: () => recordsPreservationEnabled((fixedCfg || loadConfig()).recordsPreservation),
    features: () => normalizeFeatures((fixedCfg || loadConfig()).features),
    users: () => activeUsers(readState()),
    project: (user, pid, rid) => {
      const data = projects().read();
      const project = validProjectId(pid) ? data.projects.find(p => p.id === pid) : null;
      if (!project) return null;
      const access = accessOf(project, user, activeUsers(readState()), data.people);
      if (!access.visible) return null;
      const release = rid ? project.releases.find(r => r.id === rid) : null;
      if (rid && !release) return null;
      return { projectName: project.name, releaseName: release?.name || "", releaseDate: release?.date || "", canWrite: access.canWrite };
    },
    channel: (userId, channelId) => serviceMessaging.channelFor(userId, channelId),
    canReadChat: (user, chatId) => canReadChat(readState().chats[chatId], user),
    announce: (channelId, userId, text) => serviceMessaging.postActivity(channelId, userId, text),
    startWork: options => workChatStarter({ ...options, shared: false }),
  });
  const serviceTurns = createAgentTurns({ file: path.join(DATA_DIR, "agent-turns.db"), keepRecords: recordsPreservationEnabled((fixedCfg || loadConfig()).recordsPreservation),
    execute: (turn, hooks) => executePrivateTurn(turn, hooks, fixedCfg || loadConfig()) });
  const pushTransport = createPushTransport(() => loadJson(process.env.SERVANT_PUSH_CONFIG || path.join(os.homedir(), ".config/servant/push.json"), {}), fetch,
    () => ({ identity: webPush(), subject: vapidSubject(fixedCfg || loadConfig()) }));
  servicePush = createPushService({
    file: path.join(DATA_DIR, "push.db"),
    autoDrain,
    state: readState,
    mutate: mutateState,
    stale: (device, user) => sessions.status(device, user).expired,
    resolve: (event, user) => {
      if (event.kind === "message") return serviceMessaging.notificationFor(event.messageId, user, event);
      // A visitor wrote to the secure inbox: the team hears as it would for a direct message, and not at all in deep work.
      if (event.kind === "case") return normalizeFeatures((fixedCfg || loadConfig()).features).secureInbox && !inDeepWork(user) ? inbox().notificationFor(user, event.caseId, event.sequence) : null;
      // An entitlement request, decision or refusal: only for the people it names.
      // A short note to named people that opens a page of the app, or one of their own agent chats (a comment on a
      // prototype they shared opens that prototype's chat).
      if (event.kind === "note") {
        if (!Array.isArray(event.to) || !event.to.includes(user.id)) return null;
        if (["todos", "entitlements"].includes(event.page)) return { kind: "agent", title: event.title, body: event.body, page: event.page };
        // A comment on an app preview they shared: it opens the app, with nowhere more exact to send them.
        if (typeof event.projectId === "string") return projectFor(user, event.projectId) ? { kind: "agent", title: event.title, body: event.body } : null;
        const chat = typeof event.chatId === "string" ? readState().chats[event.chatId] : null;
        return chat && !chat.deletedAt && chat.userId === user.id ? { kind: "agent", title: event.title, body: event.body, chatId: chat.id } : null;
      }
      if (event.kind === "entitlement") return Array.isArray(event.to) && event.to.includes(user.id) ? { kind: "agent", title: event.title, body: event.body, page: "entitlements" } : null;
      // A code request: only its own person, never after it expires, and never the code itself (there is none yet). The
      // separate worker process that sends alerts cannot see the requests held in the API's memory, so the alert is built
      // from the event; the process that made the request also drops it once the request is answered or cancelled.
      if (event.kind === "code") {
        if (event.to !== user.id || !(event.expiresAt > now()) || typeof event.label !== "string" || !event.label) return null;
        if (codeRequests.known(event.requestId) && !codeRequests.pending(event.requestId, user.id)) return null;
        return { kind: "agent", codeRequestId: event.requestId, title: "Code needed", body: `${event.device || "Automation"} is waiting for your ${event.label} code` };
      }
      const chat = readState().chats[event.chatId];
      if (event.userId !== user.id || !chat || chat.deletedAt || chat.userId !== user.id) return null;
      return { kind: "agent", chatId: chat.id, title: "Agent · " + chat.title, body: event.text };
    },
    send: (target, notification) => (globalThis.__servantPushSend || pushTransport)(target, notification),
  });
  return { messaging: serviceMessaging, push: servicePush, agentTurns: serviceTurns,
    closeState: () => { todosStore?.close(); todosStore = null; chatMedia?.close(); chatMedia = null; usageDb?.close(); usageDb = null; stateStore?.close(); stateStore = null; } };
}

// Voice memo notes: a no-tools model call on the restricted agent turns the
// transcript into a summary and next steps.
async function recordingNotes({ transcript, person }) {
  const cfg = loadConfig();
  const up = upstreamFor({ role: "member" }, cfg);
  if (!up) throw new Error("The agent isn't set up on this server yet");
  const context = [`Person: ${person || "unknown"}`, "", "Transcript:", transcript.slice(-120000)].join("\n");
  const response = await hermes(up, "POST", "/v1/chat/completions", { messages: [
    { role: "system", content: RECORDING_NOTES_PROMPT }, { role: "user", content: context },
  ] }, {}, AbortSignal.timeout(300_000));
  if (!response.ok) throw new Error(`The agent returned ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

// A wiki page is rewritten by the asker's own Agent: the same agent, on the same server, that answers their agent
// chats and their @agent, reached the same way (a session, then a turn), so it writes with what that agent knows and
// can look up. It runs as that person, verified the way their chats are, never as a more capable agent than theirs.
// Each request gets a session of its own, so one page's text never becomes context for another. The title carries
// the session's suffix too: Hermes refuses a second session with a title already in use (400 invalid_title).
async function askWikiAgent(messages, user, cfg) {
  const up = upstreamFor(user, cfg);
  if (!up) throw requestError(503, "agent_unavailable", "Pages are changed by asking the agent, and the agent isn't set up on this server yet. Ask an owner to set it up");
  const [instructions, request] = [messages.find(m => m.role === "system")?.content || "", messages.filter(m => m.role !== "system").map(m => m.content).join("\n\n")];
  const sessionId = `servant_wiki_${user.id}_${crypto.randomBytes(9).toString("base64url")}`;
  let usage = null;
  try {
    await verifyUpstream(agentLane(user, cfg), up);
    if (agentLane(user, cfg) === "owner") await requireEntitlementChecks(cfg, up, user);
    const made = await hermes(up, "POST", "/api/sessions", { id: sessionId, title: `Servant · wiki · ${user.name}`.slice(0, 66) + ` · ${sessionId.slice(-12)}` });
    if (!made.ok) throw requestError(502, "agent_failed", `The agent returned ${made.status}. Your page is unchanged; try again in a moment`);
    const headers = agentLane(user, cfg) === "owner" ? await turnHeaders(cfg, user.id, sessionId) : egressHeaders(cfg, user.id, sessionId);
    const content = await whileWorkingFor(cfg, user.id, () => streamTurn(up, sessionId, request, `servant:wiki:${user.id}`, () => {}, () => false, () => {}, reported => { usage = reported; }, instructions, headers));
    return { content: stripConnectMarkers(replyCleaner([user.id])(content)), usage };
  } catch (error) {
    if (error?.status && error?.code) throw error;
    throw requestError(503, "agent_unavailable", "The agent didn't answer. Your page is unchanged; try again in a moment");
  }
}

// Replies to the public are drafted by the restricted member agent and no other: a post on X is a stranger's text, and
// that agent has no tools for it to turn against the server (docs/member-security.md). It is checked to have none
// before every draft. The tokens count against the person who asked; only the counts are kept.
async function askSocial(messages, user, cfg, eventId) {
  const test = globalThis.__servantSocialAsk;
  if (test) return test(messages, user);
  const up = cfg.upstreams.member;
  if (!up?.url || !up?.key) throw requestError(503, "agent_unavailable", "Replies are drafted by the restricted agent, and it isn't set up on this server. Write the reply yourself, or ask an owner to set it up");
  try {
    await verifyMemberUpstream(up);
    const response = await hermes(up, "POST", "/v1/chat/completions", { messages: [{ role: "system", content: messages.system }, { role: "user", content: messages.user }] }, {}, AbortSignal.timeout(60_000));
    if (!response.ok) throw requestError(502, "agent_failed", `The agent returned ${response.status}. Nothing was drafted; try again in a moment`);
    const data = await response.json();
    if (data.usage) recordUsage({ eventId: `${eventId}:${crypto.randomUUID()}`, userId: user.id, source: "chat", usage: data.usage });
    return data.choices?.[0]?.message?.content || "";
  } catch (error) {
    if (error?.status && error?.code) throw error;
    throw requestError(503, "agent_unavailable", "The agent didn't answer. Nothing was drafted; try again in a moment, or write the reply yourself");
  }
}

// The guide learns from an edit: the agent says what the change teaches, and that line is added to the guide's
// "Learned from edits" as an ordinary edit of the page by the person who approved, so it is versioned (and
// preserved) like any other. Someone else saving the page at the same moment is tried once more.
async function learnFromEdit(replyId, fix, user, cfg) {
  const lesson = readLesson(await askSocial(socialLessonMessages(fix), user, cfg, `social:lesson:${replyId}`));
  if (!lesson) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const guide = socialGuide();
    const body = addLesson(guide.body, lesson, WIKI_LIMITS.body);
    if (!body) return;
    try { wiki().update(guide.id, { body, version: guide.version }, user); social().learned(replyId, lesson); return; }
    catch (error) { if (error?.code !== "stale") throw error; }
  }
}

// One no-tools question to the restricted member agent. Null when it isn't set up.
// The title the agent gives a chat. A name someone typed meanwhile wins: write checks again before saving.
const nameChat = chatId => autoTitle(chatId, {
  read: id => ({ chat: readState().chats[id], messages: chatMediaStore().history(id) }),
  ask: globalThis.__servantTitleAsk || askMemberAgent(),
  write: (id, title, due) => {
    let saved = false;
    mutateState(state => {
      const chat = state.chats[id];
      if (!chat || chat.deletedAt || chat.titledBy === "user" || (chat.autoTitledAt || 0) >= due) return;
      chat.title = title; chat.titledBy = "agent"; chat.autoTitledAt = due; saved = true;
    });
    return saved;
  },
});

const askMemberAgent = () => {
  const up = upstreamFor({ role: "member" }, loadConfig());
  if (!up) return null;
  return async (system, user) => {
    const response = await hermes(up, "POST", "/v1/chat/completions", { messages: [{ role: "system", content: system }, { role: "user", content: user }] }, {}, AbortSignal.timeout(8000));
    if (!response.ok) throw new Error(`The agent returned ${response.status}`);
    return (await response.json()).choices?.[0]?.message?.content || "";
  };
};

export function createWorkerServices() {
  return createServices(undefined, { externalWorker: true, autoDrain: false });
}

export function startServer(fixedCfg) {
  // Config is re-read per request so discovery changes require no restart.
  const cfg = fixedCfg || loadConfig();
  const emailWarning = emailSetupWarning(cfg);
  if (emailWarning) console.warn(emailWarning);
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
  // The agent's sandbox has one way out: this proxy on localhost (egress.mjs). The same listener answers the bridge's
  // "may this person's agent do this?" (agentUse). It only listens when the gate or those checks are on at start; what
  // is allowed is read for every connection. With only the checks on, it proxies nothing.
  if ((egressSettings(cfg.agentEgress).mode === "ask" || capabilitySettings(cfg.agentCapabilities).mode === "ask") && !egressProxy) {
    egressProxy = createEgressProxy({ store: egressStore(), settings: () => egressSettings((fixedCfg || loadConfig()).agentEgress), allowed: (userId, host) => entitlementStore().allows(userId, host),
      active: () => [...(agentTurns?.workingFor() || []), ...egressStore().workingFor()], known: userId => { const u = readState().users[userId]; return !!u && !isRemoved(u); }, blocked: egressBlocked, hint: egressHint, local: (req, res) => agentDoor(req, res, () => fixedCfg || loadConfig()),
      ...(globalThis.__servantEgressTest || {}) });
    // A new release starts while the old one still holds the port, so this keeps trying until the port is free.
    const what = egressSettings(cfg.agentEgress).mode === "ask" ? "network gate" : "entitlement checks";
    const wanted = egressSettings(cfg.agentEgress).port, proxy = egressProxy;
    proxy.listenWhenFree(wanted, { onWait: error => console.error(`[servant] agent ${what}: port ${wanted} is busy (${error.message}); trying again until it is free. Until then agents are refused`) })
      .then(port => { proxy.port = port; console.log(`[servant] agent ${what} on 127.0.0.1:${port}`); });
  }
  inboxConfig = () => fixedCfg || loadConfig();
  // Checked every few seconds; a short configured delay (a test or a demonstration) is checked as often as it asks.
  if (!inboxNoticeTimer) { inboxNoticeTimer = setInterval(() => void inboxNotices.sweep(), Math.max(1000, Math.min(5000, inboxNoticeSettings(cfg).delayMs))); inboxNoticeTimer.unref(); }
  // Social media: every few seconds, post the next approved reply whose time has come, and ask X for new posts when
  // it has been long enough. Off (and silent) until the X account's keys are in config.json.
  socialConfig = () => fixedCfg || loadConfig();
  if (!socialTimer) {
    let busy = false;
    const turn = async () => {
      if (busy || !socialOn(socialConfig())) return;
      busy = true;
      try {
        const runner = socialRunner();
        await runner.postDue();
        if (runner.syncDue()) { runner.markTried(); await runner.sync(); }
      } catch (error) { console.error("[servant] social", error?.message || error); } finally { busy = false; }
    };
    const work = () => { const run = turn().finally(() => socialWork.delete(run)); socialWork.add(run); };
    socialTimer = setInterval(work, Number(process.env.SERVANT_SOCIAL_TICK_MS) || 15_000); socialTimer.unref();
  }
  sessions.start(() => fixedCfg || loadConfig());
  feedback ??= createFeedback({ file: path.join(DATA_DIR, "feedback.db"), interval: 0, recover: false });
  migrateProjects();
  messaging.ensureGeneral();
  messaging.joinEveryone(Object.keys(activeUsers(readState())));
  try { messaging.ensureAgentDms(Object.keys(activeUsers(readState()))); } catch (error) { console.error("[servant] agent conversations", error); }
  if (!recordings) {
    recordings = createRecordings({
      dir: path.join(DATA_DIR, "recordings"),
      users: () => activeUsers(readState()),
      config: () => { const c = fixedCfg || loadConfig(); return { ...(c.recordings || {}), recordsPreservation: recordsPreservationEnabled(c.recordsPreservation) }; },
      summarize: recordingNotes,
      startWork: o => workChatStarter(o),
      todos: () => todosStore,
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
      fail(res, status, status === 500 ? "server_error" : err.code || "bad_request", status === 500 ? "Something went wrong on the server" : err.message, status === 500 ? undefined : err.extra);
    });
    requests.add(task);
    const settled = () => requests.delete(task);
    task.then(settled, settled);
  });
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    while (requests.size) await Promise.allSettled([...requests]);
    clearInterval(privateTimer); privateTimer = null;
    clearInterval(inboxNoticeTimer); inboxNoticeTimer = null;
    clearInterval(socialTimer); socialTimer = null;
    while (socialWork.size) await Promise.allSettled([...socialWork]);
    await inboxNotices.idle();
    await agentTurns?.whenIdle();
    agentTurns?.drainOutbox(event => push.enqueue(event));
    await recordings?.close().catch(err => console.error("[servant] recordings shutdown", err)); recordings = null;
    todosStore?.close(); todosStore = null;
    await messaging?.whenIdle();
    await push?.shutdown();
    push = null;
    feedback?.close(); feedback = null;
    inboxStore?.close(); inboxStore = null;
    businessReports?.close(); businessReports = null;
    glossaryStore?.close(); glossaryStore = null;
    lexiconStore?.close(); lexiconStore = null;
    socialDb?.close(); socialDb = null; socialRun = null;
    wikiStore?.close(); wikiStore = null;
    messaging?.close(); messaging = null;
    agentTurns?.close(); agentTurns = null;
    chatMedia?.close(); chatMedia = null; usageDb?.close(); usageDb = null;
    await egressProxy?.close(); egressProxy = null;
    tokenDb?.close(); tokenDb = null;
    entitlementDb?.close(); entitlementDb = null; egressDb?.close(); egressDb = null; reviewDb?.close(); reviewDb = null;
    if (connectionDoor) { const door = await connectionDoor.catch(() => null); connectionDoor = null; door?.close(); door?.closeAllConnections?.(); }
    connectionDb?.close(); connectionDb = null; toolsCache = null;
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
  // For tests: one turn of the social media clock now, and a wait for the guide to finish learning.
  server.socialTurn = async () => { const runner = socialRunner(); await runner.postDue(); if (runner.syncDue()) { runner.markTried(); await runner.sync(); } };
  server.socialIdle = async () => { while (socialWork.size) await Promise.allSettled([...socialWork]); };
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
  if (cmd === "token") {
    // Personal access tokens from the server's own terminal (docs/access-tokens.md):
    //   servant token create --user "Pat Tester" --name "Work laptop" [--days 90]
    //   servant token list --user "Pat Tester"
    //   servant token revoke <token id> --user "Pat Tester"
    const sub = process.argv[3] || "list", wanted = arg("user", "");
    const people = Object.values(readState().users).filter(u => !isRemoved(u));
    const person = people.find(u => u.id === wanted) || people.find(u => u.name.toLowerCase() === wanted.toLowerCase());
    if (!person) { console.error(wanted ? `No one here is called ${JSON.stringify(wanted)}. Use --user with a name or id from People` : "Say whose token: --user \"Their name\""); process.exit(1); }
    const when = at => new Date(at).toISOString().slice(0, 10);
    try {
      if (sub === "create") {
        const made = accessTokens().create(person.id, { name: arg("name", ""), days: Number(arg("days", String(DEFAULT_DAYS))) });
        console.log(`Token for ${person.name} (${made.record.name}), good until ${when(made.record.expiresAt)}:`);
        console.log(`\n  ${made.token}\n`);
        console.log("This is the only time it is shown. Keep it like a password.");
        if (!accessTokenSettings(loadConfig().accessTokens).enabled) console.log('It will not work until config.json has "accessTokens": { "enabled": true }.');
      } else if (sub === "revoke") {
        console.log(accessTokens().revoke(process.argv[4], person.id, "server") ? "Revoked." : "No live token with that id for that person.");
      } else {
        const list = accessTokens().list(person.id);
        if (!list.length) console.log(`${person.name} has no tokens.`);
        for (const t of list) console.log(`${t.id}  ${t.state.padEnd(7)}  ${t.hint}  ${t.name}  (made ${when(t.createdAt)}, ends ${when(t.expiresAt)}${t.lastUsedAt ? `, last used ${when(t.lastUsedAt)}` : ", never used"})`);
      }
    } catch (error) { console.error(error.message); process.exit(1); }
    process.exit(0);
  }
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
    const web = joinWebLink(code, cfg, { local });
    if (web) console.log(`Web link:    ${web}   (join in your browser or open the Servant app)`);
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
  } else if (cmd === "notify") {
    // server.mjs notify [--to <userId>] [--file <image>]... <text | -> : the agent tells them in their agent conversation.
    const args = process.argv.slice(3); let to = null; const files = []; const words = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--to") to = args[++i];
      else if (args[i] === "--file") files.push(args[++i]);
      else words.push(args[i]);
    }
    let text = words.join(" ");
    if (text === "-" || (!text && !process.stdin.isTTY)) text = fs.readFileSync(0, "utf8");
    if (!text.trim() && !files.length) { console.error("usage: server.mjs notify [--to <userId>] [--file <path>]... <text | ->"); process.exit(2); }
    const attachments = files.map((f) => ({ name: path.basename(f), data: fs.readFileSync(f).toString("base64") }));
    const { r, data } = await adminPost("/admin/notify", { userId: to || undefined, text, attachments });
    if (!r.ok) { console.error(`Couldn't notify (${r.status}): ${data.error?.message || "server not running?"}`); process.exit(1); }
    console.log(`Posted in ${data.conversationId} (message ${data.messageId})`);

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
  } else if (cmd === "business-reports") {
    // server.mjs business-reports list | approve <id|all> | reject <id|all> | export [file]
    // People report "this warning was wrong"; nothing is trained on until you approve it here (business-reports.mjs).
    const sub = process.argv[3] || "list", target = process.argv[4];
    const store = createBusinessReports({ file: path.join(DATA_DIR, "business-reports.db") });
    try {
      if (sub === "list") {
        const rows = store.list("pending");
        console.log(`${rows.length} waiting for review. Counts: ${JSON.stringify(store.counts())}`);
        for (const r of rows) console.log(`\n${r.id}  score ${r.score.toFixed(2)}  ${new Date(r.createdAt).toISOString().slice(0, 10)}\n  ${r.text.replace(/\s+/g, " ").slice(0, 400)}`);
        if (rows.length) console.log("\nApprove the ones that are really fine to send:  server.mjs business-reports approve <id>   (or reject <id>)");
      } else if (sub === "approve" || sub === "reject") {
        if (!target) { console.error(`usage: server.mjs business-reports ${sub} <id|all>`); process.exit(2); }
        const ids = target === "all" ? store.list("pending", 5000).map(r => r.id) : [target];
        const done = ids.filter(id => store[sub](id, os.userInfo().username)).length;
        console.log(`${done} ${sub === "approve" ? "approved" : "rejected (text erased)"}`);
      } else if (sub === "export") {
        const rows = store.exportApproved();
        const out = target || path.join(DATA_DIR, `business-false-alarms-${new Date().toISOString().slice(0, 10)}.jsonl`);
        fs.writeFileSync(out, rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
        console.log(`${rows.length} approved reports written to ${out}. Train with: python train.py --extra ${out}`);
      } else { console.error("usage: server.mjs business-reports list | approve <id|all> | reject <id|all> | export [file]"); process.exit(2); }
    } finally { store.close(); }
  } else if (cmd === "records") {
    // server.mjs records status | verify | export [dir]
    // For the agency's records officer (docs/records-management.md): what has been preserved, whether the log is intact, and a copy to
    // hand over. Reads the archive only; nothing here deletes or changes a record.
    const sub = process.argv[3] || "status";
    const { DatabaseSync } = await import("node:sqlite");
    const mfile = path.join(DATA_DIR, "messages.db");
    if (!fs.existsSync(mfile)) { console.error("No messages database yet."); process.exit(1); }
    const db = new DatabaseSync(mfile);
    const has = db.prepare("SELECT name FROM sqlite_master WHERE name = 'records_archive'").get();
    try {
      if (!has) { console.log(`Nothing preserved yet. Records preservation is ${recordsPreservationEnabled(loadConfig().recordsPreservation) ? "on" : "OFF"} (config.json: \"recordsPreservation\": { \"enabled\": true }).`); }
      else if (sub === "status") {
        const v = verifyChain(db);
        const n = db.prepare("SELECT event, COUNT(*) AS n FROM records_archive GROUP BY event ORDER BY n DESC").all();
        console.log(`Preservation: ${recordsPreservationEnabled(loadConfig().recordsPreservation) ? "on" : "OFF"}   Entries: ${v.checked}   Chain: ${v.ok ? "intact" : "BROKEN at " + v.brokenAt}`);
        for (const r of n) console.log(`  ${String(r.n).padStart(6)}  ${r.event}`);
      } else if (sub === "verify") {
        const v = verifyChain(db);
        console.log(v.ok ? `OK: ${v.checked} entries, every link and attachment checksum matches.` : `PROBLEM: the log does not match at ${v.brokenAt} (after ${v.checked} good entries). Something changed after it was written.`);
        if (!v.ok) process.exit(1);
      } else if (sub === "export") {
        const dir = process.argv[4] || path.join(DATA_DIR, `records-export-${new Date().toISOString().slice(0, 10)}`);
        fs.mkdirSync(path.join(dir, "files"), { recursive: true, mode: 0o700 });
        const entries = listPreserved(db);
        for (const e of entries) for (const f of e.files) {
          const blob = preservedFile(db, f.id);
          fs.writeFileSync(path.join(dir, "files", `${f.id}-${String(f.name).replace(/[^\w.-]+/g, "_")}`), blob.data, { mode: 0o600 });
        }
        fs.writeFileSync(path.join(dir, "records.jsonl"), entries.map(e => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), { mode: 0o600 });
        const v = verifyChain(db);
        fs.writeFileSync(path.join(dir, "MANIFEST.txt"), `Servant records export\nExported: ${new Date().toISOString()}\nEntries: ${entries.length}\nChain verified at export: ${v.ok ? "yes" : "NO, broken at " + v.brokenAt}\nOne JSON object per line in records.jsonl, oldest first; each has prev_hash and hash linking it to the one before. Attachment files are in files/, named by their id; sizes and SHA-256 are in each entry.\nThis is a copy of what Servant held. It is not a determination of which items are federal records or how long to keep them.\n`, { mode: 0o600 });
        console.log(`${entries.length} entries exported to ${dir} (chain ${v.ok ? "intact" : "BROKEN"})`);
      } else { console.error("usage: server.mjs records status | verify | export [dir]"); process.exit(2); }
    } finally { db.close(); }
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
  } else if (cmd === "session-reset") {
    // server.mjs session-reset <name, user id or device id> — the person's devices count as verified now (this Mac only).
    const query = process.argv.slice(3).join(" ").trim();
    if (!query) { console.error("usage: server.mjs session-reset <name, user id or device id>"); process.exit(2); }
    const done = mutateState(state => sessions.reset(state, query));
    if (!done || done.count !== 1) { console.error(done?.count > 1 ? "More than one person has that name. Use the id from: server.mjs people" : "No one by that name. List people with: server.mjs people"); process.exit(1); }
    const p = sessions.policy();
    console.log(`${done.name} is back in on ${done.devices === 1 ? "their device" : `${done.devices} devices`}${p.enabled ? ` for the next ${p.maxHours} hours` : " (sessions don't expire on this server right now)"}`);
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
