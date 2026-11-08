// Owner-approved, workspace-wide answers that can resolve stable questions
// without starting an upstream agent turn. Matching is intentionally exact and
// deterministic: a miss, stale entry, or malformed file always falls through.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APPROVED_ANSWERS_FILE = "approved-answers.json";
export const APPROVED_ANSWERS_VERSION = 1;
export const APPROVED_ANSWER_STATUSES = ["draft", "published", "retired"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ANSWERS = 1000;
const MAX_ALIASES = 50;
const MAX_ALIAS_CHARS = 300;
const MAX_ANSWER_CHARS = 20_000;
const MAX_RENDERED_CHARS = 8_000;
const MAX_SOURCES = 25;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HTTPS = /^https:\/\/[^\s<>]+$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export class ApprovedAnswersError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApprovedAnswersError";
  }
}

const invalid = message => { throw new ApprovedAnswersError(message); };

// Every field must be one this version understands. An unknown field is never
// dropped: something like "audience": "owner-only" looks like a restriction,
// and silently ignoring it would publish the answer to the whole workspace.
const MANIFEST_FIELDS = ["version", "answers"];
const ANSWER_FIELDS = ["id", "question", "aliases", "answer", "status", "sources", "approvedBy", "approvedAt", "reviewBy", "expiresAt", "version"];
const SOURCE_FIELDS = ["title", "url", "date"];
function rejectUnknownFields(value, allowed, where) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (!unknown.length) return;
  const named = unknown.slice(0, 5).map(key => `"${String(key).slice(0, 40)}"`).join(", ");
  invalid(`${where} has unsupported ${unknown.length === 1 ? "field" : "fields"} ${named}. Remove ${unknown.length === 1 ? "it" : "them"} and try again. Approved answers are always workspace-wide; restricted audiences aren't supported`);
}
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const cleanLine = value => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
const cleanText = value => typeof value === "string" ? value.normalize("NFKC").trim() : "";
const stripAgentHandle = value => value.replace(/^@(s|agent|servant)\b[\s,:-]*/iu, "").trim();

/**
 * The canonical form used for aliases and requests. Removing only one final
 * punctuation mark means accidental "??" or similar input does not broaden a
 * match. No stemming, substring, fuzzy, semantic, or model matching occurs.
 */
export function normalizeApprovedQuestion(value) {
  if (typeof value !== "string") return "";
  return stripAgentHandle(cleanLine(value)).toLowerCase().replace(/[?.]$/u, "").trim();
}

/** Explicit live-agent bypass. It works with or without a leading agent handle. */
export function approvedAnswerRequest(value) {
  const request = stripAgentHandle(cleanLine(value));
  const bypass = /^ask live\s*:\s*/iu.test(request);
  const question = bypass ? request.replace(/^ask live\s*:\s*/iu, "") : request;
  return { bypass, normalized: normalizeApprovedQuestion(question), question };
}

function isoTime(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    invalid(`${label} must be an ISO 8601 UTC timestamp`);
  }
  const parsed = new Date(value).toISOString();
  if (parsed !== (value.includes(".") ? value : value.replace("Z", ".000Z"))) invalid(`${label} must be a real calendar timestamp`);
  return parsed;
}

function validateSource(source, answerId, index) {
  if (!source || typeof source !== "object" || Array.isArray(source)) invalid(`Answer ${answerId} source ${index + 1} must be an object`);
  rejectUnknownFields(source, SOURCE_FIELDS, `Answer ${answerId} source ${index + 1}`);
  const title = cleanLine(source.title);
  const url = cleanLine(source.url);
  const date = cleanLine(source.date);
  if (!title || title.length > 200) invalid(`Answer ${answerId} source ${index + 1} needs a title under 200 characters`);
  let parsed;
  try { parsed = new URL(url); } catch { /* handled below */ }
  if (!url || !HTTPS.test(url) || url.length > 500 || parsed?.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    invalid(`Answer ${answerId} source ${index + 1} URL must be HTTPS without credentials`);
  }
  if (date && date.length > 40) invalid(`Answer ${answerId} source ${index + 1} date is too long`);
  return { title, url, ...(date ? { date } : {}) };
}

function validateAnswer(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`Answer ${index + 1} must be an object`);
  const id = cleanLine(raw.id);
  if (!ID.test(id)) invalid(`Answer ${index + 1} needs a lowercase id using letters, numbers, _ or -`);
  rejectUnknownFields(raw, ANSWER_FIELDS, `Answer ${id}`);
  const question = cleanLine(raw.question);
  if (!question || question.length > 200 || !normalizeApprovedQuestion(question)) invalid(`Answer ${id} needs a canonical question under 200 characters`);
  if (/^ask live\s*:/iu.test(stripAgentHandle(question))) invalid(`Answer ${id} question uses the reserved ask live bypass`);
  if (!APPROVED_ANSWER_STATUSES.includes(raw.status)) invalid(`Answer ${id} status must be draft, published or retired`);
  if (!Array.isArray(raw.aliases) || !raw.aliases.length || raw.aliases.length > MAX_ALIASES) invalid(`Answer ${id} needs 1-${MAX_ALIASES} aliases`);
  const aliases = raw.aliases.map((alias, aliasIndex) => {
    if (typeof alias !== "string" || alias.length > MAX_ALIAS_CHARS) invalid(`Answer ${id} alias ${aliasIndex + 1} must be text under ${MAX_ALIAS_CHARS} characters`);
    const normalized = normalizeApprovedQuestion(alias);
    if (!normalized) invalid(`Answer ${id} alias ${aliasIndex + 1} is empty after normalization`);
    if (/^ask live\s*:/iu.test(stripAgentHandle(cleanLine(alias)))) invalid(`Answer ${id} alias ${aliasIndex + 1} uses the reserved ask live bypass`);
    return cleanLine(alias);
  });
  const answer = cleanText(raw.answer);
  if (!answer || answer.length > MAX_ANSWER_CHARS || answer.includes("\0")) invalid(`Answer ${id} needs plain Markdown under ${MAX_ANSWER_CHARS.toLocaleString("en-US")} characters`);
  if (!Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > MAX_SOURCES) invalid(`Answer ${id} needs 1-${MAX_SOURCES} sources`);
  const sources = raw.sources.map((source, sourceIndex) => validateSource(source, id, sourceIndex));
  const approvedBy = cleanLine(raw.approvedBy);
  if (!approvedBy || approvedBy.length > 120) invalid(`Answer ${id} needs approvedBy under 120 characters`);
  const approvedAt = isoTime(raw.approvedAt, `Answer ${id} approvedAt`);
  const reviewBy = isoTime(raw.reviewBy, `Answer ${id} reviewBy`);
  const expiresAt = own(raw, "expiresAt") && raw.expiresAt !== null ? isoTime(raw.expiresAt, `Answer ${id} expiresAt`) : null;
  if (Date.parse(reviewBy) <= Date.parse(approvedAt)) invalid(`Answer ${id} reviewBy must be after approvedAt`);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(approvedAt)) invalid(`Answer ${id} expiresAt must be after approvedAt`);
  let version;
  if (!own(raw, "version") && raw.status !== "draft") invalid(`Answer ${id} needs a version before it can be published or retired`);
  if (own(raw, "version")) {
    if (!(typeof raw.version === "string" && VERSION.test(raw.version)) && !(Number.isSafeInteger(raw.version) && raw.version >= 1)) {
      invalid(`Answer ${id} version must be a positive integer or short letters-and-numbers label`);
    }
    version = raw.version;
  }
  return { id, question, aliases, answer, status: raw.status, sources, approvedBy, approvedAt, reviewBy,
    ...(expiresAt ? { expiresAt } : {}), ...(version === undefined ? {} : { version }) };
}

/** Strict validation used by both the live reader and the publishing path. */
export function validateApprovedAnswers(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("Approved answers must be a JSON object");
  rejectUnknownFields(raw, MANIFEST_FIELDS, "The approved answers file");
  if (raw.version !== APPROVED_ANSWERS_VERSION) invalid(`Approved answers version must be ${APPROVED_ANSWERS_VERSION}`);
  if (!Array.isArray(raw.answers) || raw.answers.length > MAX_ANSWERS) invalid(`Approved answers must contain at most ${MAX_ANSWERS} entries`);
  const answers = raw.answers.map(validateAnswer);
  const ids = new Set();
  const aliases = new Map();
  for (const answer of answers) {
    if (ids.has(answer.id)) invalid(`Duplicate answer id: ${answer.id}`);
    ids.add(answer.id);
    for (const alias of [answer.question, ...answer.aliases]) {
      const normalized = normalizeApprovedQuestion(alias);
      const existing = aliases.get(normalized);
      if (existing) invalid(`Duplicate normalized alias "${normalized}" in ${existing} and ${answer.id}`);
      aliases.set(normalized, answer.id);
    }
    if (formatApprovedAnswer(answer).length > MAX_RENDERED_CHARS) {
      invalid(`Answer ${answer.id} is too long with sources and approval details; keep the rendered message under ${MAX_RENDERED_CHARS.toLocaleString("en-US")} characters`);
    }
  }
  const manifest = { version: APPROVED_ANSWERS_VERSION, answers };
  if (Buffer.byteLength(JSON.stringify(manifest, null, 2) + "\n", "utf8") > MAX_FILE_BYTES) {
    invalid(`Approved answers file must be under ${MAX_FILE_BYTES.toLocaleString("en-US")} bytes`);
  }
  return manifest;
}

export function approvedAnswerIsFresh(answer, now = Date.now()) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(at) && answer?.status === "published"
    && Date.parse(answer.approvedAt) <= at
    && at < Date.parse(answer.reviewBy)
    && (!answer.expiresAt || at < Date.parse(answer.expiresAt));
}

const markdownLabel = value => value.replace(/([\\\[\]])/gu, "\\$1");
const day = value => value.slice(0, 10);

function formatApprovedAnswer(answer) {
  const sources = answer.sources.map(source => `- [${markdownLabel(source.title)}](<${source.url}>)${source.date ? ` — ${source.date}` : ""}`);
  const metadata = [
    `Approved by ${answer.approvedBy}`,
    `approved ${day(answer.approvedAt)}`,
    `review by ${day(answer.reviewBy)}`,
    ...(answer.expiresAt ? [`expires ${day(answer.expiresAt)}`] : []),
  ].join(" · ");
  return [
    "**Approved answer**",
    "",
    answer.answer,
    "",
    "**Sources**",
    ...sources,
    "",
    metadata,
    "",
    "Need a live response instead? Send `ask live: your question` in your agent chat, or `@s ask live: your question` in a channel or group message.",
  ].join("\n");
}

/**
 * Plain Markdown so every Servant client can display the same governed answer.
 * The metadata is deliberately visible: a canned response should never look
 * like a new model judgment or hide when its review is due.
 */
export function renderApprovedAnswer(raw) {
  const answer = validateApprovedAnswers({ version: APPROVED_ANSWERS_VERSION, answers: [raw] }).answers[0];
  if (answer.status !== "published") invalid(`Answer ${answer.id} must be published before it can be rendered`);
  return formatApprovedAnswer(answer);
}

function indexManifest(manifest) {
  const byAlias = new Map();
  for (const answer of manifest.answers) {
    for (const alias of [answer.question, ...answer.aliases]) {
      const normalized = normalizeApprovedQuestion(alias);
      const matches = byAlias.get(normalized) ?? [];
      matches.push(answer);
      byAlias.set(normalized, matches);
    }
  }
  return byAlias;
}

function matchIndexedApprovedAnswer(byAlias, request, now) {
  const query = approvedAnswerRequest(request);
  if (query.bypass) return { kind: "bypass", normalized: query.normalized, question: query.question };
  if (!query.normalized) return { kind: "miss", normalized: "" };
  const matches = byAlias.get(query.normalized) ?? [];
  const fresh = matches.filter(answer => approvedAnswerIsFresh(answer, now));
  if (fresh.length !== 1) return { kind: "miss", normalized: query.normalized };
  return { kind: "hit", normalized: query.normalized, answer: structuredClone(fresh[0]) };
}

export function matchApprovedAnswer(manifest, request, now = Date.now()) {
  const query = approvedAnswerRequest(request);
  if (query.bypass) return { kind: "bypass", normalized: query.normalized, question: query.question };
  if (!query.normalized) return { kind: "miss", normalized: "" };
  let validated;
  try { validated = validateApprovedAnswers(manifest); } catch { return { kind: "miss", normalized: query.normalized }; }
  return matchIndexedApprovedAnswer(indexManifest(validated), request, now);
}

export function approvedAnswersPath(dataDir = process.env.SERVANT_DATA_DIR || path.join(HERE, "data")) {
  return path.join(dataDir, APPROVED_ANSWERS_FILE);
}

/**
 * Re-reads on file changes. A missing or malformed refresh becomes an empty,
 * non-matching library; live traffic never receives stale data by accident.
 */
export function createApprovedAnswersStore(file = approvedAnswersPath(), { log = console } = {}) {
  let cache = null;
  let stamp = null;
  const refresh = () => {
    let stat;
    try { stat = fs.statSync(file); } catch (error) {
      if (error?.code !== "ENOENT") log.error?.(`[servant] ${file}: ${error.message}`);
      const manifest = { version: APPROVED_ANSWERS_VERSION, answers: [] };
      cache = { manifest, byAlias: indexManifest(manifest), error: error?.code === "ENOENT" ? null : error };
      stamp = null;
      return cache;
    }
    // Atomic publishing replaces the inode. Including it prevents an equally
    // sized same-millisecond update from being mistaken for the cached file.
    const nextStamp = `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
    if (cache && stamp === nextStamp) return cache;
    try {
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) invalid(`Approved answers file must be under ${MAX_FILE_BYTES.toLocaleString("en-US")} bytes`);
      const manifest = validateApprovedAnswers(JSON.parse(fs.readFileSync(file, "utf8")));
      cache = { manifest, byAlias: indexManifest(manifest), error: null };
    } catch (error) {
      log.error?.(`[servant] ${file}: ${error.message}`);
      const manifest = { version: APPROVED_ANSWERS_VERSION, answers: [] };
      cache = { manifest, byAlias: indexManifest(manifest), error };
    }
    stamp = nextStamp;
    return cache;
  };
  const publish = raw => {
    const manifest = validateApprovedAnswers(raw);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort for an existing directory */ }
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(tmp); } catch { /* renamed or never created */ }
    }
    cache = null;
    stamp = null;
    return structuredClone(manifest);
  };
  return {
    file,
    publish,
    read: () => structuredClone(refresh().manifest),
    match: (request, now) => {
      const current = refresh();
      if (current.error) return { kind: "miss", normalized: approvedAnswerRequest(request).normalized };
      return matchIndexedApprovedAnswer(current.byAlias, request, now);
    },
    status(now = Date.now()) {
      const current = refresh();
      const answers = current.manifest.answers;
      return { file, valid: !current.error, error: current.error?.message ?? null, total: answers.length,
        published: answers.filter(answer => answer.status === "published").length,
        fresh: answers.filter(answer => approvedAnswerIsFresh(answer, now)).length };
    },
  };
}

/**
 * Runtime facade used by messaging and search. Search is deterministic local
 * text filtering, never a routing model call; only fresh published entries are
 * visible. `match` returns a discriminated hit/bypass object or null on a miss.
 */
export function createApprovedAnswers({ directory, file = approvedAnswersPath(directory), now = Date.now, log = console } = {}) {
  const clock = typeof now === "function" ? now : () => now;
  const store = createApprovedAnswersStore(file, { log });
  const currentTime = () => {
    const value = clock();
    return value instanceof Date ? value.getTime() : Number(value);
  };
  return {
    file,
    publish: store.publish,
    status: () => store.status(currentTime()),
    match(text) {
      const result = store.match(text, currentTime());
      return result.kind === "miss" ? null : result;
    },
    search(query, limit = 6) {
      const terms = normalizeApprovedQuestion(query).split(" ").filter(Boolean);
      if (!terms.length) return [];
      const cap = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 20)) : 6;
      return store.read().answers
        .filter(answer => approvedAnswerIsFresh(answer, currentTime()))
        .filter(answer => {
          const haystack = normalizeApprovedQuestion([answer.question, ...answer.aliases, answer.answer].join(" "));
          return terms.every(term => haystack.includes(term));
        })
        .slice(0, cap)
        .map(answer => structuredClone(answer));
    },
  };
}
