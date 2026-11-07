#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_RESEARCH_HUB_RECORDS,
  RESEARCH_HUB_SCHEMA_VERSION,
  researchHubRevision,
  validateResearchHubSnapshot,
} from "./research-hub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = "Taxpayer-Services-and-Online-Accounts/research-hub";
const CATALOG_FILENAME = "research_catalog.sqlite";
const SOURCE_PATH = "survey-research-catalog/catalog/canonical_source_set.json";
const AUDIENCE = "servant-private-workspace-and-configured-researcher-model";
const APPROVED_LAYERS = ["theme", "feature", "bug", "rating"];

const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
const stableId = value => `rhe_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
const period = row => `${row.evidence_period_start}–${row.evidence_period_end}`;
const status = row => `${row.publication_status} | disclosure: ${row.disclosure_review_status}`;

function themeRecord(row) {
  const share = row.theme_share_pct === null ? "" : ` (${Number(row.theme_share_pct).toFixed(1)}% of comments in its stored denominator)`;
  return {
    id: stableId(`theme:${row.theme_period_id}`),
    kind: "theme",
    title: clean(row.theme_name),
    summary: `${row.theme_comment_count} published aggregate comments were coded to “${clean(row.theme_name)}” for ${clean(row.product_name)} during ${period(row)}${share}.`,
    product: { id: clean(row.product_id), name: clean(row.product_name) },
    period: { start: row.evidence_period_start, end: row.evidence_period_end, grain: row.period_grain },
    metric: { label: "Theme comments", value: row.theme_comment_count, unit: "comments", sampleSize: row.underlying_n },
    release: { id: clean(row.release_id), status: status(row) },
    catalogReference: `fact_theme_period • ${clean(row.theme_period_id)}`,
    sourcePath: SOURCE_PATH,
    version: 1,
  };
}

function featureRecord(row) {
  return {
    id: stableId(`feature:${row.feature_bug_id}`),
    kind: "feature",
    title: clean(row.code_name),
    summary: `${row.feature_request_count} published aggregate comments were classified as “${clean(row.code_name)}” for ${clean(row.product_name)} during ${period(row)}.`,
    product: { id: clean(row.product_id), name: clean(row.product_name) },
    period: { start: row.evidence_period_start, end: row.evidence_period_end, grain: row.period_grain },
    metric: { label: "Feature-request comments", value: row.feature_request_count, unit: "comments", sampleSize: row.underlying_n },
    release: { id: clean(row.release_id), status: status(row) },
    catalogReference: `fact_feature_bug • ${clean(row.feature_bug_id)}`,
    sourcePath: SOURCE_PATH,
    version: 1,
  };
}

function bugRecord(row) {
  return {
    id: stableId(`bug:${row.feature_bug_id}`),
    kind: "bug",
    title: clean(row.code_name),
    summary: `${row.technical_bug_count} published aggregate comments were classified as “${clean(row.code_name)}” for ${clean(row.product_name)} during ${period(row)}.`,
    product: { id: clean(row.product_id), name: clean(row.product_name) },
    period: { start: row.evidence_period_start, end: row.evidence_period_end, grain: row.period_grain },
    metric: { label: "Technical-bug comments", value: row.technical_bug_count, unit: "comments", sampleSize: row.underlying_n },
    release: { id: clean(row.release_id), status: status(row) },
    catalogReference: `fact_feature_bug • ${clean(row.feature_bug_id)}`,
    sourcePath: SOURCE_PATH,
    version: 1,
  };
}

function ratingRecord(row) {
  const label = clean(row.rating_metric).replace(/_/g, " ");
  return {
    id: stableId(`rating:${row.rating_period_id}`),
    kind: "rating",
    title: `${label.charAt(0).toUpperCase()}${label.slice(1)} rating`,
    summary: `${clean(row.product_name)} had an average ${label} rating of ${row.avg_rating} out of 5 from ${row.valid_n} valid responses during ${period(row)}.`,
    product: { id: clean(row.product_id), name: clean(row.product_name) },
    period: { start: row.evidence_period_start, end: row.evidence_period_end, grain: row.period_grain },
    metric: { label: `Average ${label} rating`, value: row.avg_rating, unit: "rating", sampleSize: row.valid_n },
    release: { id: clean(row.release_id), status: status(row) },
    catalogReference: `fact_rating_period • ${clean(row.rating_period_id)}`,
    sourcePath: SOURCE_PATH,
    version: 1,
  };
}

const THEME_SQL = `
  SELECT f.theme_period_id, f.product_id, p.product_name, f.release_id, t.theme_name,
         f.period_grain, f.evidence_period_start, f.evidence_period_end,
         f.theme_comment_count, f.theme_share_pct, f.underlying_n,
         f.disclosure_review_status, r.publication_status
  FROM fact_theme_period f
  JOIN dim_product p ON p.product_id = f.product_id
  JOIN dim_theme t ON t.theme_id = f.theme_id
  JOIN release_manifest r ON r.release_id = f.release_id
  WHERE f.suppression_applied = 0 AND f.publish_eligible = 1
    AND f.publication_class = 'repository_aggregate' AND f.theme_comment_count IS NOT NULL
  ORDER BY f.evidence_period_end DESC, f.product_id, f.theme_period_id`;

const FEATURE_SQL = `
  SELECT f.feature_bug_id, f.product_id, p.product_name, f.release_id, c.code_name,
         f.period_grain, f.evidence_period_start, f.evidence_period_end,
         f.feature_request_count, f.underlying_n, f.disclosure_review_status, r.publication_status
  FROM fact_feature_bug f
  JOIN dim_product p ON p.product_id = f.product_id
  JOIN dim_code c ON c.code_id = f.code_id
  JOIN release_manifest r ON r.release_id = f.release_id
  WHERE f.suppression_applied = 0 AND f.publish_eligible = 1
    AND f.publication_class = 'repository_aggregate' AND f.is_feature_request = 1
    AND f.feature_request_count IS NOT NULL
  ORDER BY f.evidence_period_end DESC, f.product_id, f.feature_bug_id`;

const BUG_SQL = `
  SELECT f.feature_bug_id, f.product_id, p.product_name, f.release_id, c.code_name,
         f.period_grain, f.evidence_period_start, f.evidence_period_end,
         f.technical_bug_count, f.underlying_n, f.disclosure_review_status, r.publication_status
  FROM fact_feature_bug f
  JOIN dim_product p ON p.product_id = f.product_id
  JOIN dim_code c ON c.code_id = f.code_id
  JOIN release_manifest r ON r.release_id = f.release_id
  WHERE f.suppression_applied = 0 AND f.publish_eligible = 1
    AND f.publication_class = 'repository_aggregate' AND f.is_technical_bug = 1
    AND f.technical_bug_count IS NOT NULL
  ORDER BY f.evidence_period_end DESC, f.product_id, f.feature_bug_id`;

const RATING_SQL = `
  SELECT f.rating_period_id, f.product_id, p.product_name, f.release_id, f.rating_metric,
         f.period_grain, f.evidence_period_start, f.evidence_period_end,
         f.avg_rating, f.valid_n, f.disclosure_review_status, r.publication_status
  FROM fact_rating_period f
  JOIN dim_product p ON p.product_id = f.product_id
  JOIN release_manifest r ON r.release_id = f.release_id
  WHERE f.suppression_applied = 0 AND f.publish_eligible = 1
    AND f.publication_class = 'repository_aggregate' AND f.avg_rating IS NOT NULL AND f.valid_n IS NOT NULL
  ORDER BY f.evidence_period_end DESC, f.product_id, f.rating_period_id`;

export function aggregateRecords(databasePath, releaseSources) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    const records = [
      ...database.prepare(THEME_SQL).all().map(themeRecord),
      ...database.prepare(FEATURE_SQL).all().map(featureRecord),
      ...database.prepare(BUG_SQL).all().map(bugRecord),
      ...database.prepare(RATING_SQL).all().map(ratingRecord),
    ];
    if (releaseSources) {
      for (const record of records) {
        const source = releaseSources.get(record.release.id);
        if (!source) throw new Error(`No canonical source manifest is registered for ${record.release.id}`);
        record.sourcePath = source;
      }
    }
    if (records.length > MAX_RESEARCH_HUB_RECORDS) throw new Error(`The approved aggregate export exceeds ${MAX_RESEARCH_HUB_RECORDS} records`);
    return records;
  } finally {
    database.close();
  }
}

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function safeCheckout(checkout) {
  const requested = path.resolve(checkout);
  if (fs.lstatSync(requested).isSymbolicLink() || fs.realpathSync(requested) !== requested) throw new Error("The Research Hub checkout cannot be a symlink");
  const root = fs.realpathSync(git(requested, "rev-parse", "--show-toplevel"));
  if (root !== requested) throw new Error("Pass the Research Hub repository root to --checkout");
  const remote = git(root, "remote", "get-url", "origin");
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)Taxpayer-Services-and-Online-Accounts\/research-hub(?:\.git)?$/.test(remote)) {
    throw new Error("The checkout is not the approved Research Hub repository");
  }
  try { git(root, "fetch", "--quiet", "--no-tags", "origin", "refs/heads/main"); }
  catch { throw new Error("Could not refresh the authoritative Research Hub origin/main; no snapshot was published"); }
  if (git(root, "status", "--porcelain", "--untracked-files=all")) throw new Error("The Research Hub checkout has local changes; publish only from a clean immutable commit");
  if (git(root, "ls-files", "-s").split("\n").some(line => line.startsWith("120000 "))) throw new Error("The Research Hub checkout contains tracked symlinks; no snapshot was published");
  const commit = git(root, "rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Could not identify the Research Hub commit");
  let upstream;
  try { upstream = git(root, "rev-parse", "FETCH_HEAD"); }
  catch { throw new Error("The just-fetched origin/main commit is unavailable; no snapshot was published"); }
  if (!/^[a-f0-9]{40}$/.test(upstream)) throw new Error("The just-fetched origin/main commit is invalid; no snapshot was published");
  if (commit !== upstream) throw new Error("Publish only the exact fetched origin/main commit after its Servant approval is merged");
  const catalogTree = git(root, "rev-parse", "HEAD:survey-research-catalog");
  if (!/^[a-f0-9]{40,64}$/.test(catalogTree)) throw new Error("Could not identify the approved Research Hub catalog tree");
  return { root, commit, catalogTree };
}

function containedFile(root, relative) {
  const candidate = path.join(root, relative);
  if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error(`${relative} cannot be a symlink`);
  const real = fs.realpathSync(candidate);
  if (real !== candidate || !real.startsWith(`${root}${path.sep}`)) throw new Error(`${relative} is outside the Research Hub checkout`);
  return real;
}

function canonicalReleaseSources(root, canonicalPath) {
  const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8"));
  if (!Array.isArray(canonical.releases) || !canonical.releases.length) throw new Error("The canonical source set has no releases");
  const sources = new Map();
  for (const item of canonical.releases) {
    const releaseId = clean(item?.release_id);
    const sourceRoot = clean(item?.source_root);
    if (!releaseId || !sourceRoot || sourceRoot.startsWith("/") || sourceRoot.includes("\\") || sourceRoot.split("/").includes("..")) {
      throw new Error("The canonical source set contains an invalid release path");
    }
    if (sources.has(releaseId)) throw new Error(`The canonical source set repeats ${releaseId}`);
    const relative = `survey-research-catalog/${sourceRoot}/catalog_manifest.json`;
    containedFile(root, relative);
    try { git(root, "ls-files", "--error-unmatch", relative); }
    catch { throw new Error(`The canonical manifest for ${releaseId} is not tracked at the approved commit`); }
    sources.set(releaseId, relative);
  }
  return sources;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} has unsupported fields`);
}

function exactInstant(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error(`${label} is invalid`);
  return time;
}

export function validateServantApproval(value, { approvalId, catalogTree, now = Date.now() }) {
  exactKeys(value, ["schemaVersion", "approvalId", "status", "audience", "catalogTree", "layers", "approvedAt", "expiresAt"], "Servant approval");
  if (value.schemaVersion !== 1 || clean(value.approvalId) !== approvalId || value.status !== "APPROVED" || value.audience !== AUDIENCE || value.catalogTree !== catalogTree) {
    throw new Error("The committed Servant approval does not match this catalog tree and audience");
  }
  if (!Array.isArray(value.layers) || value.layers.length !== APPROVED_LAYERS.length ||
      [...value.layers].sort().some((layer, index) => layer !== [...APPROVED_LAYERS].sort()[index])) {
    throw new Error("The committed Servant approval does not cover every exported aggregate layer");
  }
  const approvedAt = exactInstant(value.approvedAt, "approval date");
  const expiresAt = exactInstant(value.expiresAt, "approval expiry");
  if (approvedAt > now + 5 * 60_000 || expiresAt <= now) throw new Error("The committed Servant approval is not currently valid");
  return {
    id: approvalId,
    audience: AUDIENCE,
    sourcePath: `approvals/servant/${approvalId}.json`,
    catalogTree,
    expiresAt: value.expiresAt,
  };
}

export function buildResearchHubSnapshot({ checkout, approvalId, reviewDays = 30, now = new Date() }) {
  const approval = clean(approvalId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(approval)) throw new Error("Pass the committed Servant audience approval ID with --approval");
  if (!Number.isInteger(reviewDays) || reviewDays < 1 || reviewDays > 90) throw new Error("Review days must be between 1 and 90");
  const source = safeCheckout(checkout);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "servant-research-hub-export-"));
  const requestedWorktree = path.join(temporary, "approved-source");
  let immutableRoot;
  let worktreeAdded = false;
  try {
    git(source.root, "worktree", "add", "--detach", "--quiet", requestedWorktree, source.commit);
    worktreeAdded = true;
    immutableRoot = fs.realpathSync(requestedWorktree);
    const catalogRoot = containedFile(immutableRoot, "survey-research-catalog");
    const statusPath = containedFile(immutableRoot, "survey-research-catalog/CURRENT_STATUS.json");
    const workflowsPath = containedFile(immutableRoot, "survey-research-catalog/catalog/query_workflows.json");
    const canonicalPath = containedFile(immutableRoot, SOURCE_PATH);
    const builderPath = containedFile(immutableRoot, "survey-research-catalog/catalog/build_catalog.py");
    const validatorPath = containedFile(immutableRoot, "survey-research-catalog/catalog/validate_catalog.py");
    const approvalRelative = `approvals/servant/${approval}.json`;
    const approvalPath = containedFile(immutableRoot, approvalRelative);
    try { git(immutableRoot, "ls-files", "--error-unmatch", approvalRelative); }
    catch { throw new Error("The Servant audience approval is not tracked at the approved commit"); }
    const approvalRecord = validateServantApproval(JSON.parse(fs.readFileSync(approvalPath, "utf8")), {
      approvalId: approval,
      catalogTree: source.catalogTree,
      now: new Date(now).getTime(),
    });
    const databasePath = path.join(temporary, CATALOG_FILENAME);
    const build = spawnSync("python3", [builderPath, "--canonical", "--database", databasePath], {
      cwd: catalogRoot,
      encoding: "utf8",
      timeout: 600_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (build.status !== 0) throw new Error("Research Hub canonical catalog build failed; no snapshot was published");
    const validation = spawnSync("python3", [validatorPath, "--database", databasePath], {
      cwd: catalogRoot,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (validation.status !== 0) throw new Error("Research Hub catalog validation failed; no snapshot was published");

    const currentStatus = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const workflows = JSON.parse(fs.readFileSync(workflowsPath, "utf8"));
    const generatedAt = new Date(now).toISOString();
    const reviewBy = new Date(Math.min(
      new Date(now).getTime() + reviewDays * 24 * 60 * 60 * 1000,
      Date.parse(approvalRecord.expiresAt),
    )).toISOString();
    const snapshot = {
      schemaVersion: RESEARCH_HUB_SCHEMA_VERSION,
      revision: "0".repeat(64),
      generatedAt,
      reviewBy,
      source: {
        label: "Research Hub approved aggregate catalog",
        repository: REPOSITORY,
        path: SOURCE_PATH,
        commit: source.commit,
        catalogTree: source.catalogTree,
        catalogSchemaVersion: clean(currentStatus.schema_version),
        workflowRegistryVersion: clean(workflows.registry_version),
        validation: "PASS",
      },
      approval: approvalRecord,
      records: aggregateRecords(databasePath, canonicalReleaseSources(immutableRoot, canonicalPath)),
    };
    snapshot.revision = researchHubRevision(snapshot);
    return validateResearchHubSnapshot(snapshot, { now: new Date(now).getTime() });
  } finally {
    if (worktreeAdded) {
      try { git(source.root, "worktree", "remove", "--force", immutableRoot || requestedWorktree); }
      catch { try { git(source.root, "worktree", "prune"); } catch {} }
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function publishResearchHubSnapshot(snapshot, dataDirectory) {
  const approved = validateResearchHubSnapshot(snapshot);
  const requestedDirectory = path.resolve(dataDirectory);
  fs.mkdirSync(requestedDirectory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(requestedDirectory).isSymbolicLink()) throw new Error("The Servant data directory cannot be a symlink");
  const directory = fs.realpathSync(requestedDirectory);
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const destination = path.join(directory, "research-hub.json");
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error("The Research Hub destination cannot be a symlink");
  const temp = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(approved)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, destination);
    if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
    return destination;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--checkout", "--approval", "--data-dir", "--review-days"].includes(key) || index + 1 >= argv.length) throw new Error(`Unknown or incomplete argument: ${key}`);
    values[key.slice(2)] = argv[++index];
  }
  if (!values.checkout || !values.approval) throw new Error("Usage: node server/research-hub-export.mjs --checkout <clean-research-hub-root> --approval <approval-id> [--data-dir <servant-data>] [--review-days 30]");
  return values;
}

async function main() {
  const values = args(process.argv.slice(2));
  const snapshot = buildResearchHubSnapshot({
    checkout: values.checkout,
    approvalId: values.approval,
    reviewDays: values["review-days"] === undefined ? 30 : Number(values["review-days"]),
  });
  const dataDirectory = values["data-dir"] || process.env.SERVANT_DATA_DIR || path.join(HERE, "data");
  const destination = publishResearchHubSnapshot(snapshot, dataDirectory);
  process.stdout.write(`Published ${snapshot.records.length} approved aggregate records to ${destination}\nRevision ${snapshot.revision}\nReview by ${snapshot.reviewBy}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
