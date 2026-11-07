import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const APPROVED_ANSWERS_FILE = "approved-answers.json";
const DAY = 24 * 60 * 60 * 1000;

function answer(id, { status = "published", approvedAt, reviewBy, version = 1 } = {}) {
  return {
    id,
    question: `How does ${id} work?`,
    aliases: [`Explain ${id}`],
    answer: `Use the reviewed guidance for **${id}**.`,
    status,
    sources: [{ title: `${id} guide`, url: `https://servant.example/${id}` }],
    approvedBy: "Workspace owner",
    approvedAt,
    reviewBy,
    version,
  };
}

function manifest(now = Date.now()) {
  return {
    version: 1,
    answers: [
      answer("fresh", {
        approvedAt: new Date(now - DAY).toISOString(),
        reviewBy: new Date(now + 30 * DAY).toISOString(),
      }),
      answer("review-due", {
        approvedAt: new Date(now - 30 * DAY).toISOString(),
        reviewBy: new Date(now - DAY).toISOString(),
        version: 2,
      }),
      answer("draft", {
        status: "draft",
        approvedAt: new Date(now - DAY).toISOString(),
        reviewBy: new Date(now + 30 * DAY).toISOString(),
      }),
    ],
  };
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant approved answers cli "));
  const data = path.join(directory, "private data");
  fs.mkdirSync(data, { mode: 0o755 });
  const candidate = path.join(directory, "candidate answers.json");
  const candidateManifest = manifest();
  fs.writeFileSync(candidate, JSON.stringify(candidateManifest, null, 2));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, data, candidate, candidateManifest, installed: path.join(data, APPROVED_ANSWERS_FILE) };
}

async function runFaq(data, ...args) {
  const child = spawn(process.execPath, [SERVER, "faq", ...args], {
    env: { ...process.env, SERVANT_DATA_DIR: data },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code, signal] = await closed;
  return { code, signal, stdout, stderr, output: stdout + stderr };
}

test("faq validate accepts a candidate without writing server data", async t => {
  const f = fixture(t);
  const candidateBefore = fs.readFileSync(f.candidate, "utf8");
  const dataBefore = fs.readdirSync(f.data);

  const result = await runFaq(f.data, "validate", f.candidate);

  assert.equal(result.code, 0, result.output);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Valid: 3 approved-answer entries\. No files changed\./);
  assert.deepEqual(fs.readdirSync(f.data), dataBefore);
  assert.equal(fs.existsSync(f.installed), false);
  assert.equal(fs.readFileSync(f.candidate, "utf8"), candidateBefore);
});

test("faq publish installs atomically with private permissions and rejects an invalid replacement", async t => {
  const f = fixture(t);

  const published = await runFaq(f.data, "publish", f.candidate);
  assert.equal(published.code, 0, published.output);
  assert.match(published.stdout, /Published 3 approved-answer entries/);
  assert.equal(fs.statSync(f.data).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.installed).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.installed, "utf8")), f.candidateManifest);
  assert.deepEqual(fs.readdirSync(f.data).filter(name => name.startsWith(`${APPROVED_ANSWERS_FILE}.`) && name.endsWith(".tmp")), []);

  const activeBefore = fs.readFileSync(f.installed, "utf8");
  const invalid = structuredClone(f.candidateManifest);
  invalid.answers[0].sources = [];
  const invalidCandidate = path.join(f.directory, "invalid candidate answers.json");
  fs.writeFileSync(invalidCandidate, JSON.stringify(invalid, null, 2));

  const rejected = await runFaq(f.data, "publish", invalidCandidate);
  assert.equal(rejected.code, 1, rejected.output);
  assert.match(rejected.stderr, /Approved answers publish failed: Answer fresh needs 1-25 sources/);
  assert.equal(fs.readFileSync(f.installed, "utf8"), activeBefore,
    "failed validation must leave the active manifest byte-for-byte unchanged");
  assert.equal(fs.statSync(f.installed).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.data).filter(name => name.startsWith(`${APPROVED_ANSWERS_FILE}.`) && name.endsWith(".tmp")), []);
});

test("faq status reports freshness, publication, and approved-answer hits from the analytics database", async t => {
  const f = fixture(t);
  const published = await runFaq(f.data, "publish", f.candidate);
  assert.equal(published.code, 0, published.output);

  const database = new DatabaseSync(path.join(f.data, "messages.db"));
  try {
    database.exec(`
      CREATE TABLE faq_events (answer_id TEXT NOT NULL, answer_version TEXT NOT NULL);
      INSERT INTO faq_events VALUES ('fresh', '1');
      INSERT INTO faq_events VALUES ('fresh', '1');
      INSERT INTO faq_events VALUES ('review-due', '2');
    `);
  } finally { database.close(); }

  const status = await runFaq(f.data, "status");
  assert.equal(status.code, 0, status.output);
  assert.match(status.stdout, /Approved answers: valid; 3 total, 2 published, 1 fresh/);
  assert.match(status.stdout, /Approved-answer hits: 3/);
  assert.match(status.stdout, /^  fresh version 1: 2$/m);
  assert.match(status.stdout, /^  review-due version 2: 1$/m);
  assert.match(status.stdout, new RegExp(`^File: ${f.installed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});
