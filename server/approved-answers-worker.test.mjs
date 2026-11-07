import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createApprovedAnswers } from "./approved-answers.mjs";
import { createMessaging } from "./messaging.mjs";
import { createStateStore } from "./state-store.mjs";

const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const people = {
  member: { id: "member", name: "Member Example", role: "member", agentTier: 1 },
  blocked: { id: "blocked", name: "No Agent Example", role: "member", agentTier: 0 },
};

function approvedManifest(now = Date.now()) {
  return {
    version: 1,
    answers: [{
      id: "show-me-around",
      question: "How do I get started?",
      aliases: ["Show me around"],
      answer: "Start with **Home**, then choose Agent, Designs, or Research.",
      status: "published",
      sources: [{ title: "Onboarding guide", url: "https://servant.example/onboarding", date: "2026-11-01" }],
      approvedBy: "Workspace owner",
      approvedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      reviewBy: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
      version: 3,
    }],
  };
}

async function until(check, child, output, description) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = check();
    if (value) return value;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Worker exited before ${description}\n${output()}`);
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}\n${output()}`);
}

test("the real worker resolves a queued channel job from Approved Answers without an upstream", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant approved worker "));
  const configFile = path.join(directory, "config.json");
  const pushConfig = path.join(directory, "push-disabled.json");
  const messagesFile = path.join(directory, "messages.db");
  fs.writeFileSync(configFile, JSON.stringify({
    name: "Approved Answers worker fixture",
    agentName: "Agent",
    agentAccess: "limited",
    upstreams: {},
  }));
  fs.writeFileSync(pushConfig, "{}");

  const state = createStateStore({ directory });
  state.mutate(value => { value.users = structuredClone(people); });
  state.close();

  const library = createApprovedAnswers({ directory });
  library.publish(approvedManifest());

  const seed = createMessaging({
    file: messagesFile,
    users: () => people,
    agentName: () => "Agent",
    externalWorker: true,
    askAgent: async () => { throw new Error("the seeding connection must not run an agent"); },
  });
  const channel = seed.createChannel(people.member, { name: "help" });
  const trigger = seed.post(channel, "member", "@s Show me around");
  const blockedTrigger = seed.post(channel, "blocked", "@s Show me around");
  assert.equal(seed.db.prepare("SELECT status FROM agent_jobs WHERE trigger_seq = ?").get(trigger.seq).status, "queued");
  assert.equal(seed.db.prepare("SELECT status FROM agent_jobs WHERE trigger_seq = ?").get(blockedTrigger.seq).status, "queued");

  let output = "";
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, SERVANT_DATA_DIR: directory, SERVANT_PUSH_CONFIG: pushConfig },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    seed.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await until(() => output.includes("durable worker ready"), child, () => output, "worker readiness");
  const job = await until(
    () => {
      const row = seed.db.prepare("SELECT * FROM agent_jobs WHERE trigger_seq = ?").get(trigger.seq);
      return row?.status === "done" ? row : null;
    },
    child,
    () => output,
    "Approved Answer completion",
  );
  const blockedJob = await until(
    () => {
      const row = seed.db.prepare("SELECT * FROM agent_jobs WHERE trigger_seq = ?").get(blockedTrigger.seq);
      return row?.status === "done" ? row : null;
    },
    child,
    () => output,
    "no-agent fallback completion",
  );

  const reply = seed.db.prepare("SELECT * FROM messages WHERE seq = ?").get(job.reply_seq);
  assert.equal(reply.user_id, "agent");
  assert.equal(reply.thread_root, trigger.seq);
  assert.equal(reply.pending, 0);
  assert.match(reply.text, /^\*\*Approved answer\*\*/);
  assert.match(reply.text, /Start with \*\*Home\*\*, then choose Agent, Designs, or Research\./);
  assert.match(reply.text, /\[Onboarding guide\]\(<https:\/\/servant\.example\/onboarding>\) — 2026-11-01/);
  assert.match(reply.text, /Approved by Workspace owner · approved \d{4}-\d{2}-\d{2} · review by \d{4}-\d{2}-\d{2}/);
  assert.match(reply.text, /Need a live response instead\?/);
  assert.deepEqual(JSON.parse(reply.suggestions), ["@s ask live: I still need help"]);

  const event = seed.db.prepare("SELECT * FROM faq_events WHERE trigger_seq = ?").get(trigger.seq);
  assert.equal(event.reply_seq, reply.seq);
  assert.equal(event.answer_id, "show-me-around");
  assert.equal(event.answer_version, "3");
  assert.equal(event.surface, "channel");
  assert.equal(seed.db.prepare("SELECT COUNT(*) AS n FROM agent_threads WHERE key = ?").get(`${channel.id}:${trigger.seq}`).n, 0,
    "the local match must not create an upstream session");
  assert.match(seed.db.prepare("SELECT text FROM messages WHERE seq = ?").get(blockedJob.reply_seq).text, /don't have agent access yet/i);
  assert.equal(seed.db.prepare("SELECT * FROM faq_events WHERE trigger_seq = ?").get(blockedTrigger.seq), undefined,
    "Approved Answers must not bypass server-granted agent access");
  assert.equal(seed.db.prepare("SELECT COUNT(*) AS n FROM faq_events").get().n, 1);

  const usage = new DatabaseSync(path.join(directory, "usage.db"), { readOnly: true });
  try {
    assert.equal(usage.prepare("SELECT COUNT(*) AS n FROM token_usage").get().n, 0);
  } finally { usage.close(); }
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")).upstreams, {},
    "the worker has no configured upstream to contact");
  assert.doesNotMatch(output, /channel agent job interrupted|worker could not start/);

  child.kill("SIGTERM");
  assert.deepEqual(await closed, [0, null], output);
  assert.match(output, /worker finishing current work/);
});
