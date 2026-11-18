// Personal connections (docs/connections.md): each person's own credentials for the tools their agent works with,
// so the agent acts as them, with their access only, instead of with one login the whole server shares.
//
// A tool type is data: its name, the fields a person fills in, and the environment variables those become in that
// person's agent commands. GitHub and Jira are built in; an owner adds others in config.json.
//
// A saved value is encrypted here and leaves this file one way only: into the environment of that person's own
// agent commands (the bridge asks for it at the start of their turn). It is never returned by the API, never logged
// and never written to the history, which records only that something was saved, replaced, removed, asked for,
// declined or used.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanHost } from "./egress.mjs";

export const HIDDEN = "[hidden]";
export const MAX_TOOLS = 40;
const MAX_VALUE = 2000;

const GITHUB_TOKEN = "github_pat_[A-Za-z0-9_]{22,255}|gh[pousr]_[A-Za-z0-9]{36,255}";
/** The tool types every server has. An owner's own types (config.json, "connections.types") come after these. */
export const BUILTIN_TOOLS = [
  { id: "github", name: "GitHub", heading: "GitHub token for your account",
    help: "Needed so the agent works on GitHub as you, with only your access. Create one at github.com → Settings → Developer settings → Personal access tokens.",
    createUrl: "https://github.com/settings/personal-access-tokens/new",
    hosts: ["github.com", "*.github.com", "*.githubusercontent.com"],
    fields: [{ key: "token", label: "Personal access token", placeholder: "github_pat_… or ghp_…", pattern: `^(?:${GITHUB_TOKEN})$`, detect: GITHUB_TOKEN, secret: true }],
    env: { GH_TOKEN: "{token}", GITHUB_TOKEN: "{token}" }, check: "github" },
  { id: "jira", name: "Jira", heading: "Jira API token",
    help: "Needed so the agent works in Jira as you, with only your access. Create one at id.atlassian.com → Security → API tokens.",
    createUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    hosts: ["*.atlassian.net", "*.atlassian.com"],
    fields: [
      { key: "site", label: "Jira site", placeholder: "example.atlassian.net", pattern: "^[a-z0-9][a-z0-9-]{0,62}\\.atlassian\\.net$", secret: false },
      { key: "email", label: "Your Jira email", placeholder: "you@example.gov", pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", secret: false },
      { key: "token", label: "API token", placeholder: "ATATT…", pattern: "^[A-Za-z0-9_=-]{20,512}$", detect: "ATATT3[A-Za-z0-9_=-]{20,512}", secret: true },
    ],
    env: { JIRA_SITE: "{site}", JIRA_EMAIL: "{email}", JIRA_API_TOKEN: "{token}" } },
];

const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const line = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const compiles = source => { try { new RegExp(source); return true; } catch { return false; } };
// Variables a tool type may never set: they change how every command runs, or belong to Servant and the agent.
const RESERVED_ENV = /^(PATH|HOME|SHELL|USER|LOGNAME|PWD|IFS|ENV|BASH_ENV|TMPDIR|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|(HTTPS?|ALL|NO)_PROXY|(LD|DYLD|HERMES|SERVANT|_HERMES)_.*)$/i;

/** One owner-defined tool type from config.json, cleaned; null when it can't be used (the reason goes to `problems`). */
export function cleanTool(raw, problems = []) {
  const bad = why => { problems.push(`${JSON.stringify(String(raw?.id ?? "").slice(0, 40))}: ${why}`); return null; };
  if (!raw || typeof raw !== "object") return bad("a tool type is an object");
  const id = String(raw.id ?? "");
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) return bad("id is 2 to 31 lowercase letters, digits or dashes, starting with a letter");
  const name = line(raw.name, 40);
  if (!name) return bad("a tool type needs a name");
  if (!Array.isArray(raw.fields) || !raw.fields.length || raw.fields.length > 6) return bad("fields is a list of one to six fields");
  const fields = [];
  for (const f of raw.fields) {
    const key = String(f?.key ?? "");
    if (!/^[a-z][A-Za-z0-9_]{0,30}$/.test(key) || fields.some(x => x.key === key)) return bad(`field key ${JSON.stringify(key.slice(0, 40))} must be letters and digits, starting with a lowercase letter, and used once`);
    for (const source of [f.pattern, f.detect]) if (source !== undefined && (typeof source !== "string" || source.length > 300 || !compiles(source))) return bad(`field ${key} has a pattern that isn't a regular expression`);
    fields.push({ key, label: line(f.label, 60) || key, placeholder: line(f.placeholder, 80), ...(f.pattern ? { pattern: f.pattern } : {}), ...(f.detect ? { detect: f.detect } : {}), secret: f.secret !== false });
  }
  if (!fields.some(f => f.secret)) return bad("at least one field must be secret");
  const env = {};
  for (const [variable, template] of Object.entries(raw.env && typeof raw.env === "object" ? raw.env : {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(variable) || RESERVED_ENV.test(variable)) return bad(`${JSON.stringify(variable.slice(0, 70))} can't be set by a tool type`);
    if (typeof template !== "string" || !template || template.length > 300) return bad(`${variable} needs a value such as "{token}"`);
    for (const used of template.matchAll(/\{([A-Za-z0-9_]+)\}/g)) if (!fields.some(f => f.key === used[1])) return bad(`${variable} uses {${used[1]}}, which is not a field`);
    env[variable] = template;
  }
  if (!Object.keys(env).length || Object.keys(env).length > 12) return bad("env names one to twelve variables");
  let createUrl = "";
  if (raw.createUrl) { try { const url = new URL(String(raw.createUrl)); if (url.protocol === "https:") createUrl = url.href; } catch { /* reported below */ } if (!createUrl) return bad("createUrl must be an https:// address"); }
  return { id, name, heading: line(raw.heading, 80) || `${name} token for your account`, help: line(raw.help, 300), createUrl,
    hosts: (Array.isArray(raw.hosts) ? raw.hosts : []).map(cleanHost).filter(Boolean).slice(0, 50), fields, env };
}

/** `"connections"` in config.json: the built-in tool types, then the owner's own. A type that can't be used is left out and reported. */
export function toolCatalog(raw, problems = []) {
  const tools = BUILTIN_TOOLS.map(t => ({ ...t }));
  for (const item of Array.isArray(raw?.types) ? raw.types.slice(0, MAX_TOOLS) : []) {
    const tool = cleanTool(item, problems);
    if (!tool) continue;
    if (tools.some(t => t.id === tool.id)) { problems.push(`${JSON.stringify(tool.id)}: that id is already taken`); continue; }
    tools.push(tool);
  }
  return tools;
}

/** What the app is told about a tool type: everything but how its values reach the agent. */
export const publicTool = tool => ({ id: tool.id, name: tool.name, heading: tool.heading, help: tool.help, createUrl: tool.createUrl, hosts: tool.hosts,
  fields: tool.fields.map(f => ({ key: f.key, label: f.label, placeholder: f.placeholder, ...(f.pattern ? { pattern: f.pattern } : {}), secret: f.secret })) });

/** A person's values for a tool, checked against its fields. Throws what the person should be told. */
export function cleanValues(tool, input) {
  const values = {};
  for (const field of tool.fields) {
    const value = typeof input?.[field.key] === "string" ? input[field.key].trim() : "";
    if (!value) throw fault(400, "bad_request", `${field.label} is needed to connect ${tool.name}`);
    // A value becomes an environment variable: no line breaks or control characters.
    if (value.length > MAX_VALUE || /[\u0000-\u001f\u007f]/.test(value)) throw fault(400, "bad_request", `${field.label} doesn't look right. Copy it again and try once more`);
    if (field.pattern && !new RegExp(field.pattern).test(value)) throw fault(400, "bad_format", `${field.label} doesn't look right. It should look like ${field.placeholder || "the example"}`);
    values[field.key] = value;
  }
  return values;
}

/** The environment a tool's values become. */
export function toolEnv(tool, values) {
  return Object.fromEntries(Object.entries(tool.env).map(([variable, template]) => [variable, template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => values[key] ?? "")]));
}

// ---------- text: tokens typed into chat, redaction, and the agent's "ask for a connection" marker ----------

const detectors = new WeakMap();
function detectorsFor(tools) {
  let found = detectors.get(tools);
  if (!found) {
    found = tools.flatMap(tool => tool.fields.filter(f => f.secret && f.detect).map(f => ({ tool, pattern: `(?<![A-Za-z0-9_])(?:${f.detect})(?![A-Za-z0-9_])` })));
    detectors.set(tools, found);
  }
  return found;
}

/** The tool whose token this text seems to contain, or null. A person's message with one in it is not stored. */
export function tokenInText(text, tools) {
  if (typeof text !== "string" || !text) return null;
  return detectorsFor(tools).find(d => new RegExp(d.pattern).test(text))?.tool ?? null;
}
export const tokenInChatMessage = tool => `That looks like a ${tool.name} token. Use Connections so it stays out of chat.`;

// The letters every match of a pattern must start with ("ghp_" for a classic GitHub token), one per alternative; null
// when they can't be told from the pattern, and then a reply still being written is held a whole word at a time.
function literalStarts(source) {
  if (/[()\\]/.test(source)) return null;
  const starts = source.split("|").map(alternative => /^[A-Za-z0-9_-]*/.exec(alternative)[0]);
  return starts.every(Boolean) ? starts : null;
}

/**
 * A function that hides secrets in text: every saved value it is given, and anything shaped like a known token.
 * Longest values first, so a value that contains another is hidden whole. It carries what a stream needs to know
 * to hold back the start of a secret that has only half arrived (`secrets`, `starts`).
 */
export function redactor(tools, secrets = []) {
  const exact = [...new Set(secrets.filter(s => typeof s === "string" && s.length >= 8))].sort((a, b) => b.length - a.length);
  const found = detectorsFor(tools);
  const patterns = found.map(d => new RegExp(d.pattern, "g"));
  const starts = tools.flatMap(tool => tool.fields.filter(f => f.secret && f.detect).map(f => literalStarts(f.detect)));
  const hide = text => {
    if (typeof text !== "string" || !text) return text;
    let out = text;
    for (const secret of exact) if (out.includes(secret)) out = out.split(secret).join(HIDDEN);
    for (const pattern of patterns) out = out.replace(pattern, HIDDEN);
    return out;
  };
  hide.secrets = exact;
  hide.starts = starts.includes(null) ? null : starts.flat();
  return hide;
}

const MARKER = /\[\[connect:([A-Za-z0-9_-]{1,40})\]\]/g;
/**
 * The agent asks for a connection by writing [[connect:<type>]] on its own line. This takes every such marker out
 * of the text and returns the types asked for, once each, in order. A type nobody defined is dropped.
 */
export function readConnectMarkers(text, tools) {
  if (typeof text !== "string" || !text.includes("[[connect:")) return { text, types: [] };
  const types = [];
  const lines = text.split("\n").flatMap(original => {
    if (!original.includes("[[connect:")) return [original];
    const rest = original.replace(MARKER, (_, id) => { const type = id.toLowerCase(); if (tools.some(t => t.id === type) && !types.includes(type)) types.push(type); return ""; });
    // A line that held only the marker goes with it.
    return rest.trim() ? [rest.replace(/[ \t]{2,}/g, " ").trimEnd()] : [];
  });
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), types };
}

/** The same, for a piece of a reply still being written: markers go, and the spacing around them is left alone. */
export const stripConnectMarkers = text => typeof text === "string" && text.includes("[[connect:") ? text.replace(MARKER, "") : text;

/**
 * For text that arrives in pieces. `clean` is only ever given text in which nothing sensitive is half-arrived, so a
 * token, a saved value or a marker split across two pieces is still caught. What could be the start of one is held
 * until the rest arrives (or `flush`); everything else goes out at once, so a reply cut off mid-way keeps its words.
 *  - `secrets`: saved values; the end of the text is held while it could be the start of one.
 *  - `starts`: how known tokens begin; a word that begins like one is held until it ends. null: hold every unfinished word.
 */
export function createTextStream(clean, { secrets = [], starts = [], hold = 600 } = {}) {
  let held = "";
  const word = /[A-Za-z0-9_]/;
  function from(text) {
    let at = text.length;
    for (const secret of secrets) {
      for (let k = Math.min(secret.length - 1, text.length); k > 0; k--) if (text.endsWith(secret.slice(0, k))) { at = Math.min(at, text.length - k); break; }
    }
    // A marker that has begun and not ended.
    const marker = text.lastIndexOf("[[");
    if (marker >= 0 && !text.includes("]]", marker) && text.length - marker <= 60) at = Math.min(at, marker);
    else if (text.endsWith("[")) at = Math.min(at, text.length - 1);
    const run = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t")) + 1;
    if (starts === null) return Math.min(at, run);
    for (let i = run; i < Math.min(at, text.length); i++) {
      if (i > run && word.test(text[i - 1])) continue;
      const rest = text.slice(i);
      if (starts.some(start => rest.startsWith(start) || start.startsWith(rest))) { at = i; break; }
    }
    return at;
  }
  return {
    push(piece) {
      held += String(piece ?? "");
      const at = held.length - from(held) > hold ? held.length : from(held);
      const ready = held.slice(0, at);
      held = held.slice(at);
      return ready ? clean(ready) : "";
    },
    flush() { const rest = held; held = ""; return rest ? clean(rest) : ""; },
  };
}

// ---------- the store ----------

const last4 = value => `${value}`.slice(-4);

/** The 32-byte key the values are encrypted with: a file beside the database, made once, readable only by the server's user. */
export function loadConnectionsKey(keyFile) {
  let key;
  try { key = fs.readFileSync(keyFile); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (raced) { if (raced.code !== "EEXIST") throw raced; }
    key = fs.readFileSync(keyFile);
  }
  if (key.length !== 32) throw new Error("Invalid connections key; restore the original connections-key file");
  fs.chmodSync(keyFile, 0o600);
  return key;
}

/**
 * `tools()` is the catalog right now. `known(userId)` says whether someone is on the server.
 * Values are sealed with AES-256-GCM; the person and tool are bound into each one, so a row copied onto another
 * person or tool does not open.
 */
export function createConnections({ file, keyFile = path.join(path.dirname(file), "connections-key"), tools = () => BUILTIN_TOOLS, known = () => true, clock = Date.now }) {
  const key = loadConnectionsKey(keyFile);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS connections (user_id TEXT NOT NULL, type TEXT NOT NULL, sealed BLOB NOT NULL, last4 TEXT NOT NULL, account TEXT,
      saved_at INTEGER NOT NULL, used_at INTEGER, PRIMARY KEY(user_id, type));
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, type TEXT NOT NULL, message_id TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, decided_at INTEGER, UNIQUE(user_id, chat_id, type));
    CREATE INDEX IF NOT EXISTS requests_chat ON requests(chat_id);
    CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, action TEXT NOT NULL, chat_id TEXT, at INTEGER NOT NULL, detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS history_user ON history(user_id, seq);
    CREATE TRIGGER IF NOT EXISTS history_no_update BEFORE UPDATE ON history BEGIN SELECT RAISE(ABORT, 'connection history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS history_no_delete BEFORE DELETE ON history BEGIN SELECT RAISE(ABORT, 'connection history is append-only'); END;`);
  const tx = fn => { db.exec("BEGIN IMMEDIATE"); try { const out = fn(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  // The history says what happened and never holds a value: `detail` is built here from fixed words only.
  const note = (userId, type, action, { chatId = null, detail = {} } = {}) =>
    db.prepare("INSERT INTO history(user_id,type,action,chat_id,at,detail) VALUES (?,?,?,?,?,?)").run(String(userId), type, action, chatId ? String(chatId) : null, clock(), JSON.stringify(detail));
  const aad = (userId, type) => Buffer.from(`servant-connection:${userId}:${type}`);
  const seal = (userId, type, values) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(userId, type));
    const body = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
  };
  const open = (userId, type, sealed) => {
    const raw = Buffer.from(sealed);
    if (raw[0] !== 1 || raw.length < 30) throw new Error("A saved connection can't be read");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(1, 13));
    decipher.setAAD(aad(userId, type));
    decipher.setAuthTag(raw.subarray(13, 29));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(29)), decipher.final()]).toString("utf8"));
  };
  const tool = type => tools().find(t => t.id === type) || null;
  const need = type => { const found = tool(String(type)); if (!found) throw fault(404, "not_found", "No such tool to connect"); return found; };
  const row = (userId, type) => db.prepare("SELECT * FROM connections WHERE user_id=? AND type=?").get(String(userId), String(type));
  const shape = r => r ? { type: r.type, last4: r.last4, ...(r.account ? { account: r.account } : {}), savedAt: r.saved_at, ...(r.used_at ? { usedAt: r.used_at } : {}) } : null;
  const requestRow = id => db.prepare("SELECT * FROM requests WHERE id=?").get(String(id));
  const requestShape = r => r && ({ id: r.id, userId: r.user_id, chatId: r.chat_id, type: r.type, ...(r.message_id ? { messageId: r.message_id } : {}), status: r.status, createdAt: r.created_at });
  // Whatever can still be read of a person's saved values. One that no longer opens (a replaced key file) is skipped
  // and said so, without the value.
  const opened = userId => db.prepare("SELECT * FROM connections WHERE user_id=?").all(String(userId)).flatMap(r => {
    const found = tool(r.type);
    if (!found) return [];
    try { return [{ tool: found, values: open(r.user_id, r.type, r.sealed) }]; }
    catch { console.error(`[servant] connections: a saved ${found.name} connection can't be read with this server's key and was left out`); return []; }
  });

  return {
    tools: () => tools(),
    tool,
    /** One person's standing on one tool: null, or the last four characters, the account name and the times. Never a value. */
    status: (userId, type) => shape(row(userId, type)),
    /** Every tool the person has connected. */
    list: userId => db.prepare("SELECT * FROM connections WHERE user_id=? ORDER BY type").all(String(userId)).filter(r => tool(r.type)).map(shape),
    has: userId => db.prepare("SELECT type FROM connections WHERE user_id=?").all(String(userId)).some(r => tool(r.type)),
    /** Save or replace a person's values for a tool. `account` is the name the tool knows them by, when it was checked. */
    save(userId, type, input, { account = "" } = {}) {
      const found = need(type);
      if (!known(userId)) throw fault(403, "forbidden", "Only people on this server can connect a tool");
      const values = cleanValues(found, input);
      const secret = found.fields.find(f => f.secret);
      return tx(() => {
        const replaced = !!row(userId, found.id);
        db.prepare(`INSERT INTO connections(user_id,type,sealed,last4,account,saved_at,used_at) VALUES (?,?,?,?,?,?,NULL)
          ON CONFLICT(user_id, type) DO UPDATE SET sealed=excluded.sealed, last4=excluded.last4, account=excluded.account, saved_at=excluded.saved_at, used_at=NULL`)
          .run(String(userId), found.id, seal(String(userId), found.id, values), last4(values[secret.key]), line(account, 100) || null, clock());
        // Whatever the agent was waiting on for this tool, in any chat, is answered.
        db.prepare("UPDATE requests SET status='saved', decided_at=? WHERE user_id=? AND type=? AND status='open'").run(clock(), String(userId), found.id);
        note(userId, found.id, replaced ? "replaced" : "saved");
        return { connection: shape(row(userId, found.id)), replaced };
      });
    },
    /** Remove a person's values for a tool. False when there was nothing to remove. */
    remove(userId, type, { reason = "" } = {}) {
      return tx(() => {
        if (!row(userId, type)) return false;
        db.prepare("DELETE FROM connections WHERE user_id=? AND type=?").run(String(userId), String(type));
        note(userId, String(type), "removed", { detail: reason ? { reason: line(reason, 100) } : {} });
        return true;
      });
    },
    /** Someone left the server: everything they saved goes. */
    forget(userId) {
      tx(() => {
        for (const r of db.prepare("SELECT type FROM connections WHERE user_id=?").all(String(userId))) {
          db.prepare("DELETE FROM connections WHERE user_id=? AND type=?").run(String(userId), r.type);
          note(userId, r.type, "removed", { detail: { reason: "Left the server" } });
        }
      });
    },
    /**
     * The environment for one person's agent commands in this turn, and which tools it came from. Written down as
     * "used", per tool and chat. This is the only way a value leaves.
     */
    envFor(userId, { chatId = "" } = {}) {
      if (!known(userId)) return { env: {}, types: [] };
      return tx(() => {
        const env = {}, types = [];
        for (const { tool: found, values } of opened(userId)) {
          Object.assign(env, toolEnv(found, values));
          types.push(found.id);
          db.prepare("UPDATE connections SET used_at=? WHERE user_id=? AND type=?").run(clock(), String(userId), found.id);
          note(userId, found.id, "used", { chatId });
        }
        return { env, types };
      });
    },
    /** The secret values a person has saved, for hiding them in anything the agent writes back. */
    secrets: userId => opened(userId).flatMap(({ tool: found, values }) => found.fields.filter(f => f.secret).map(f => values[f.key])).filter(Boolean),
    /**
     * The agent asked this person for a tool, in this chat, in this message. One request per person, chat and tool:
     * asking again moves the form to the newest message. Null when there is nothing to ask (already connected, or
     * the person declined in this chat).
     */
    request(userId, chatId, type, messageId) {
      const found = tool(String(type));
      if (!found || !known(userId) || !chatId) return null;
      return tx(() => {
        if (row(userId, found.id)) return null;
        const existing = db.prepare("SELECT * FROM requests WHERE user_id=? AND chat_id=? AND type=?").get(String(userId), String(chatId), found.id);
        if (existing?.status === "declined") return null;
        if (existing) {
          db.prepare("UPDATE requests SET status='open', message_id=?, decided_at=NULL WHERE id=?").run(messageId ? String(messageId) : existing.message_id, existing.id);
          if (existing.status !== "open") note(userId, found.id, "requested", { chatId });
          return requestShape(requestRow(existing.id));
        }
        const id = `creq_${crypto.randomBytes(9).toString("base64url")}`;
        db.prepare("INSERT INTO requests(id,user_id,chat_id,type,message_id,status,created_at) VALUES (?,?,?,?,?,'open',?)").run(id, String(userId), String(chatId), found.id, messageId ? String(messageId) : null, clock());
        note(userId, found.id, "requested", { chatId });
        return requestShape(requestRow(id));
      });
    },
    /** The person said no. Only their own request; the agent does not ask again in that chat. */
    decline(id, userId) {
      return tx(() => {
        const existing = requestRow(id);
        if (!existing || existing.user_id !== String(userId)) throw fault(404, "not_found", "That request is gone");
        if (existing.status === "saved") throw fault(409, "conflict", "You already connected this");
        if (existing.status !== "declined") {
          db.prepare("UPDATE requests SET status='declined', decided_at=? WHERE id=?").run(clock(), existing.id);
          note(userId, existing.type, "declined", { chatId: existing.chat_id });
        }
        return requestShape(requestRow(existing.id));
      });
    },
    /** Every request made in a chat. */
    requestsForChat: chatId => db.prepare("SELECT * FROM requests WHERE chat_id=? ORDER BY created_at").all(String(chatId ?? "")).map(requestShape),
    /** The tools this person declined to connect in this chat. */
    declinedIn: (userId, chatId) => db.prepare("SELECT type FROM requests WHERE user_id=? AND chat_id=? AND status='declined'").all(String(userId), String(chatId ?? "")).map(r => r.type),
    /** What happened, newest first: one person's, or everyone's. Never a value. */
    history({ userId, limit = 200 } = {}) {
      return db.prepare("SELECT * FROM history WHERE (? IS NULL OR user_id=?) ORDER BY seq DESC LIMIT ?").all(userId ?? null, userId ?? null, Math.max(1, Math.min(1000, Number(limit) || 200)))
        .map(h => ({ seq: h.seq, userId: h.user_id, type: h.type, action: h.action, ...(h.chat_id ? { chatId: h.chat_id } : {}), at: h.at, detail: JSON.parse(h.detail) }));
    },
    close() { db.close(); key.fill(0); },
  };
}

/** Check a GitHub token by asking GitHub who it belongs to. Returns { ok, account } or { ok: false, rejected } ; `unreachable` when GitHub could not be asked. */
export async function checkGithubToken(values, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  let response;
  try {
    response = await fetchImpl("https://api.github.com/user", { headers: { Authorization: `Bearer ${values.token}`, Accept: "application/vnd.github+json", "User-Agent": "servant-server" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch { return { ok: true, unreachable: true }; }
  if (response.status === 401 || response.status === 403) return { ok: false };
  if (!response.ok) return { ok: true, unreachable: true };
  try { const login = (await response.json())?.login; return { ok: true, account: typeof login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(login) ? `@${login}` : "" }; }
  catch { return { ok: true, unreachable: true }; }
}
