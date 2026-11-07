import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RESEARCH_HUB_SCHEMA_VERSION = 1;
export const MAX_RESEARCH_HUB_RECORDS = 25_000;
export const MAX_RESEARCH_HUB_SELECTION = 8;
export const MAX_RESEARCH_HUB_RESULTS = 20;

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SOURCE_REPOSITORY = "Taxpayer-Services-and-Online-Accounts/research-hub";
const SOURCE_PATH = "survey-research-catalog/catalog/canonical_source_set.json";
const APPROVED_AUDIENCE = "servant-private-workspace-and-configured-researcher-model";
const CONTROL = /[\u0000-\u001f\u007f]/;
const EVIDENCE_KINDS = new Set(["theme", "feature", "bug", "rating"]);
const METRIC_UNITS = new Set(["comments", "percent", "rating", "responses"]);

export class ResearchHubError extends Error {
  constructor(message, status = 503, code = "research_hub_unavailable") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ownObject = value => value && typeof value === "object" && !Array.isArray(value);

function exactKeys(value, expected, label) {
  if (!ownObject(value)) throw new ResearchHubError(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ResearchHubError(`${label} has unsupported fields`);
  }
}

function text(value, label, max, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) {
    throw new ResearchHubError(`${label} is invalid`);
  }
  const cleaned = value.trim();
  if (!allowEmpty && !cleaned) throw new ResearchHubError(`${label} is missing`);
  return cleaned;
}

function isoDate(value, label) {
  const cleaned = text(value, label, 10);
  const parsed = new Date(`${cleaned}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== cleaned) {
    throw new ResearchHubError(`${label} is invalid`);
  }
  return cleaned;
}

function isoInstant(value, label) {
  const cleaned = text(value, label, 40);
  const time = Date.parse(cleaned);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== cleaned) {
    throw new ResearchHubError(`${label} is invalid`);
  }
  return { value: cleaned, time };
}

function number(value, label, { integer = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ResearchHubError(`${label} is invalid`);
  }
  return value;
}

function sourcePath(value) {
  const cleaned = text(value, "record source path", 240);
  if (cleaned.startsWith("/") || cleaned.includes("\\") || cleaned.split("/").includes("..") ||
      !(cleaned.startsWith("research/") || cleaned.startsWith("survey-research-catalog/"))) {
    throw new ResearchHubError("record source path is outside the Research Hub");
  }
  return cleaned;
}

function approvalSourcePath(value, approvalId) {
  const cleaned = text(value, "approval source path", 180);
  if (cleaned !== `approvals/servant/${approvalId}.json`) throw new ResearchHubError("Research Hub approval source is invalid");
  return cleaned;
}

function record(value, index) {
  const label = `record ${index + 1}`;
  exactKeys(value, ["id", "kind", "title", "summary", "product", "period", "metric", "release", "catalogReference", "sourcePath", "version"], label);
  const id = text(value.id, `${label} id`, 32);
  if (!/^rhe_[a-f0-9]{16}$/.test(id)) throw new ResearchHubError(`${label} id is invalid`);
  const kind = text(value.kind, `${label} kind`, 20);
  if (!EVIDENCE_KINDS.has(kind)) throw new ResearchHubError(`${label} kind is not an approved aggregate layer`);

  exactKeys(value.product, ["id", "name"], `${label} product`);
  exactKeys(value.period, ["start", "end", "grain"], `${label} period`);
  exactKeys(value.metric, ["label", "value", "unit", "sampleSize"], `${label} metric`);
  exactKeys(value.release, ["id", "status"], `${label} release`);

  const start = isoDate(value.period.start, `${label} period start`);
  const end = isoDate(value.period.end, `${label} period end`);
  if (start > end) throw new ResearchHubError(`${label} period is reversed`);
  const grain = text(value.period.grain, `${label} period grain`, 10);
  if (grain !== "week" && grain !== "month") throw new ResearchHubError(`${label} period grain is invalid`);
  const unit = text(value.metric.unit, `${label} metric unit`, 20);
  if (!METRIC_UNITS.has(unit)) throw new ResearchHubError(`${label} metric unit is invalid`);
  const metricValue = number(value.metric.value, `${label} metric value`, { min: 0, max: 1_000_000_000 });
  if ((unit === "percent" && metricValue > 100) || (unit === "rating" && (metricValue < 1 || metricValue > 5))) {
    throw new ResearchHubError(`${label} metric value is outside its valid range`);
  }
  const sampleSize = value.metric.sampleSize === null ? null : number(value.metric.sampleSize, `${label} sample size`, { integer: true });

  return {
    id,
    kind,
    title: text(value.title, `${label} title`, 180),
    summary: text(value.summary, `${label} summary`, 500),
    product: {
      id: text(value.product.id, `${label} product id`, 80),
      name: text(value.product.name, `${label} product name`, 120),
    },
    period: { start, end, grain },
    metric: {
      label: text(value.metric.label, `${label} metric label`, 80),
      value: metricValue,
      unit,
      sampleSize,
    },
    release: {
      id: text(value.release.id, `${label} release id`, 180),
      status: text(value.release.status, `${label} release status`, 220),
    },
    catalogReference: text(value.catalogReference, `${label} catalog reference`, 320),
    sourcePath: sourcePath(value.sourcePath),
    version: number(value.version, `${label} version`, { integer: true, min: 1, max: 1_000_000 }),
  };
}

function revisionPayload(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    reviewBy: snapshot.reviewBy,
    source: snapshot.source,
    approval: snapshot.approval,
    records: snapshot.records,
  };
}

export function researchHubRevision(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(revisionPayload(snapshot))).digest("hex");
}

export function validateResearchHubSnapshot(value, { now = Date.now() } = {}) {
  exactKeys(value, ["schemaVersion", "revision", "generatedAt", "reviewBy", "source", "approval", "records"], "Research Hub snapshot");
  if (value.schemaVersion !== RESEARCH_HUB_SCHEMA_VERSION) throw new ResearchHubError("Research Hub snapshot schema is unsupported");
  const generated = isoInstant(value.generatedAt, "snapshot generated time");
  const review = isoInstant(value.reviewBy, "snapshot review date");
  if (generated.time > now + 5 * 60_000) throw new ResearchHubError("Research Hub snapshot is dated in the future");
  if (review.time <= now) throw new ResearchHubError("Research Hub snapshot needs an owner refresh", 503, "research_hub_stale");
  if (review.time <= generated.time) throw new ResearchHubError("Research Hub snapshot review date is invalid");

  exactKeys(value.source, ["label", "repository", "path", "commit", "catalogTree", "catalogSchemaVersion", "workflowRegistryVersion", "validation"], "Research Hub source");
  const source = {
    label: text(value.source.label, "source label", 120),
    repository: text(value.source.repository, "source repository", 120),
    path: sourcePath(value.source.path),
    commit: text(value.source.commit, "source commit", 40),
    catalogTree: text(value.source.catalogTree, "source catalog tree", 64),
    catalogSchemaVersion: text(value.source.catalogSchemaVersion, "catalog schema version", 40),
    workflowRegistryVersion: text(value.source.workflowRegistryVersion, "workflow registry version", 40),
    validation: text(value.source.validation, "source validation", 10),
  };
  if (source.repository !== SOURCE_REPOSITORY || source.path !== SOURCE_PATH || !/^[a-f0-9]{40}$/.test(source.commit) ||
      !/^[a-f0-9]{40,64}$/.test(source.catalogTree) || source.validation !== "PASS") {
    throw new ResearchHubError("Research Hub snapshot source is not approved");
  }
  exactKeys(value.approval, ["id", "audience", "sourcePath", "catalogTree", "expiresAt"], "Research Hub approval");
  const approvalId = text(value.approval.id, "approval id", 80);
  const approval = {
    id: approvalId,
    audience: text(value.approval.audience, "approval audience", 80),
    sourcePath: approvalSourcePath(value.approval.sourcePath, approvalId),
    catalogTree: text(value.approval.catalogTree, "approval catalog tree", 64),
    expiresAt: isoInstant(value.approval.expiresAt, "approval expiry").value,
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(approval.id) || approval.audience !== APPROVED_AUDIENCE ||
      approval.catalogTree !== source.catalogTree || Date.parse(approval.expiresAt) < review.time) {
    throw new ResearchHubError("Research Hub snapshot audience is not approved");
  }
  if (!Array.isArray(value.records) || value.records.length > MAX_RESEARCH_HUB_RECORDS) {
    throw new ResearchHubError("Research Hub snapshot contains too many records");
  }
  const records = value.records.map(record);
  const ids = new Set();
  for (const item of records) {
    if (ids.has(item.id)) throw new ResearchHubError("Research Hub snapshot contains duplicate record IDs");
    ids.add(item.id);
  }

  const snapshot = {
    schemaVersion: RESEARCH_HUB_SCHEMA_VERSION,
    revision: text(value.revision, "snapshot revision", 64),
    generatedAt: generated.value,
    reviewBy: review.value,
    source,
    approval,
    records,
  };
  if (!/^[a-f0-9]{64}$/.test(snapshot.revision) || researchHubRevision(snapshot) !== snapshot.revision) {
    throw new ResearchHubError("Research Hub snapshot integrity check failed");
  }
  return snapshot;
}

function safeLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(MAX_RESEARCH_HUB_RESULTS, Math.max(1, parsed)) : MAX_RESEARCH_HUB_RESULTS;
}

function normalizeQuery(value) {
  if (typeof value !== "string" || value.length > 120 || CONTROL.test(value)) {
    throw new ResearchHubError("Search must be 120 characters or fewer", 400, "bad_request");
  }
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function publicStatus(snapshot) {
  return {
    available: true,
    revision: snapshot.revision,
    generatedAt: snapshot.generatedAt,
    reviewBy: snapshot.reviewBy,
    recordCount: snapshot.records.length,
    source: snapshot.source.label,
    sourceCommit: snapshot.source.commit,
  };
}

export function createResearchHub(file, options = {}) {
  let cached = null;
  let cachedKey = null;
  const clock = options.now ?? (() => Date.now());

  const load = () => {
    let descriptor;
    try {
      const directory = fs.lstatSync(path.dirname(file));
      if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== "win32" && (directory.mode & 0o077) !== 0)) {
        throw new ResearchHubError("Research Hub snapshot directory permissions are not private");
      }
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      descriptor = fs.openSync(file, flags);
      const stat = fs.fstatSync(descriptor, { bigint: true });
      if (!stat.isFile() || stat.size > BigInt(MAX_SNAPSHOT_BYTES)) throw new ResearchHubError("Research Hub snapshot is invalid");
      if (process.platform !== "win32" && (Number(stat.mode) & 0o077) !== 0) {
        throw new ResearchHubError("Research Hub snapshot permissions are not private");
      }
      const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (cached && key === cachedKey) {
        if (Date.parse(cached.reviewBy) <= clock()) throw new ResearchHubError("Research Hub snapshot needs an owner refresh", 503, "research_hub_stale");
        return cached;
      }
      const raw = fs.readFileSync(descriptor, "utf8");
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new ResearchHubError("Research Hub snapshot is corrupt"); }
      const next = validateResearchHubSnapshot(parsed, { now: clock() });
      cached = next;
      cachedKey = key;
      return next;
    } catch (error) {
      if (error instanceof ResearchHubError) throw error;
      throw new ResearchHubError("Research Hub evidence is not configured");
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };

  const status = () => {
    try { return publicStatus(load()); }
    catch (error) {
      const stale = error instanceof ResearchHubError && error.code === "research_hub_stale";
      return {
        available: false,
        message: stale
          ? "Research Hub evidence needs to be refreshed by a workspace owner."
          : "Research Hub evidence is not available on this workspace.",
      };
    }
  };

  const search = (query = "", limit = MAX_RESEARCH_HUB_RESULTS) => {
    const snapshot = load();
    const normalized = normalizeQuery(query);
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const ranked = snapshot.records.flatMap(item => {
      if (!normalized) return [{ item, score: 0 }];
      const title = item.title.toLocaleLowerCase("en-US");
      const product = item.product.name.toLocaleLowerCase("en-US");
      const haystack = `${title} ${product} ${item.summary} ${item.kind} ${item.metric.label}`.normalize("NFKC").toLocaleLowerCase("en-US");
      if (!tokens.every(token => haystack.includes(token))) return [];
      const score = (title.includes(normalized) ? 8 : 0) + (product.includes(normalized) ? 5 : 0) +
        tokens.reduce((sum, token) => sum + (title.includes(token) ? 3 : product.includes(token) ? 2 : 1), 0);
      return [{ item, score }];
    });
    ranked.sort((a, b) => b.score - a.score || b.item.period.end.localeCompare(a.item.period.end) || a.item.id.localeCompare(b.item.id));
    return { hub: publicStatus(snapshot), evidence: ranked.slice(0, safeLimit(limit)).map(result => result.item) };
  };

  const resolve = (ids, expectedRevision) => {
    if (!Array.isArray(ids) || ids.length > MAX_RESEARCH_HUB_SELECTION || ids.some(id => typeof id !== "string" || !/^rhe_[a-f0-9]{16}$/.test(id))) {
      throw new ResearchHubError(`Choose up to ${MAX_RESEARCH_HUB_SELECTION} Research Hub records`, 400, "bad_request");
    }
    if (new Set(ids).size !== ids.length) throw new ResearchHubError("Research Hub selection contains duplicates", 400, "bad_request");
    const snapshot = load();
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      throw new ResearchHubError("Research Hub selection is missing its snapshot revision", 400, "bad_request");
    }
    if (expectedRevision !== snapshot.revision) {
      throw new ResearchHubError("Research Hub evidence changed. Review your evidence selection.", 409, "research_hub_changed");
    }
    const byId = new Map(snapshot.records.map(item => [item.id, item]));
    const evidence = ids.map(id => byId.get(id));
    if (evidence.some(item => !item)) throw new ResearchHubError("One or more selected Research Hub records changed. Review your evidence selection.", 409, "research_hub_changed");
    return { hub: publicStatus(snapshot), evidence };
  };

  return { status, search, resolve };
}
