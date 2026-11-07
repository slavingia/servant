import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMessaging } from "./messaging.mjs";

const people = {
  alice: { id: "alice", name: "Alice Example", role: "member" },
  bob: { id: "bob", name: "Bob Example", role: "member" },
};

const APPROVED = {
  id: "show-me-around",
  version: "v7",
  text: "**Approved answer**\n\nStart with Home, then choose the area you need.",
  suggestions: ["Open Research", "Ask live: Show me around"],
};

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-approved-integration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function requestText(value) {
  return typeof value === "string" ? value : String(value?.text ?? "");
}

function harness(directory, { matcher = () => APPROVED } = {}) {
  const calls = { agent: 0, usage: 0, matcher: 0 };
  const messaging = createMessaging({
    file: path.join(directory, "messages.db"),
    users: () => people,
    agentName: () => "Servant",
    externalWorker: true,
    matchApprovedAnswer: (...args) => {
      calls.matcher++;
      return matcher(...args);
    },
    askAgent: async ({ onUsage }) => {
      calls.agent++;
      onUsage({ input_tokens: 9, output_tokens: 4, total_tokens: 13 });
      return "Live agent answer";
    },
    onUsage: () => { calls.usage++; },
  });
  return { calls, messaging };
}

const jobFor = (messaging, trigger) => messaging.db.prepare("SELECT * FROM agent_jobs WHERE trigger_seq = ?").get(trigger.seq);
const faqFor = (messaging, trigger) => messaging.db.prepare("SELECT * FROM faq_events WHERE trigger_seq = ?").get(trigger.seq);

test("the first human turn in an agent DM uses an approved answer without upstream usage", async t => {
  const directory = fixture(t);
  const { calls, messaging } = harness(directory);
  try {
    const dm = messaging.welcomeFromAgent("alice");
    const trigger = messaging.post(dm, "alice", "Show me around");

    assert.equal(await messaging.processAgentJob("approved-worker"), true);
    assert.equal(calls.matcher, 1);
    assert.equal(calls.agent, 0);
    assert.equal(calls.usage, 0);

    const job = jobFor(messaging, trigger);
    const reply = messaging.db.prepare("SELECT * FROM messages WHERE seq = ?").get(job.reply_seq);
    assert.equal(job.status, "done");
    assert.equal(reply.user_id, "agent");
    assert.equal(reply.thread_root, null, "agent DMs remain an in-line conversation");
    assert.equal(reply.pending, 0);
    assert.equal(reply.text, APPROVED.text);
    assert.deepEqual(JSON.parse(reply.suggestions), APPROVED.suggestions);
    assert.deepEqual(
      { trigger_seq: faqFor(messaging, trigger).trigger_seq,
        reply_seq: faqFor(messaging, trigger).reply_seq,
        answer_id: faqFor(messaging, trigger).answer_id,
        answer_version: faqFor(messaging, trigger).answer_version,
        surface: faqFor(messaging, trigger).surface },
      { trigger_seq: trigger.seq, reply_seq: reply.seq, answer_id: APPROVED.id,
        answer_version: APPROVED.version, surface: "agent_dm" },
    );
    assert.equal(messaging.db.prepare("SELECT COUNT(*) AS n FROM agent_threads").get().n, 0,
      "a local answer does not create a Hermes session");
  } finally { messaging.close(); }
});

test("a top-level channel mention records approved-answer analytics and finishes its durable job", async t => {
  const directory = fixture(t);
  const { calls, messaging } = harness(directory);
  try {
    const channel = messaging.createChannel(people.alice, { name: "help", memberIds: ["bob"] });
    const trigger = messaging.post(channel, "alice", "@s Show me around");

    assert.equal(await messaging.processAgentJob("approved-worker"), true);
    assert.equal(calls.agent, 0);
    assert.equal(calls.usage, 0);

    const job = jobFor(messaging, trigger);
    const reply = messaging.db.prepare("SELECT * FROM messages WHERE seq = ?").get(job.reply_seq);
    const event = faqFor(messaging, trigger);
    assert.equal(job.status, "done");
    assert.equal(reply.thread_root, trigger.seq, "channel answers stay in the request thread");
    assert.equal(reply.pending, 0);
    assert.equal(reply.text, APPROVED.text);
    assert.equal(event.reply_seq, reply.seq);
    assert.equal(event.answer_id, APPROVED.id);
    assert.equal(event.answer_version, APPROVED.version);
    assert.equal(event.surface, "channel");

    const stats = messaging.approvedAnswerStats();
    assert.equal(stats.hits, 1);
    assert.deepEqual(stats.answers.map(({ lastHitAt: _lastHitAt, ...answer }) => answer),
      [{ id: APPROVED.id, version: APPROVED.version, hits: 1 }]);
    assert.deepEqual(stats.surfaces, [{ surface: "channel", hits: 1 }]);
  } finally { messaging.close(); }
});

test("a top-level group DM mention can use an approved answer and keeps an @s live fallback", async t => {
  const directory = fixture(t);
  let surface;
  const { calls, messaging } = harness(directory, { matcher: (_text, context) => {
    surface = context.surface;
    return { ...APPROVED, suggestions: ["@s ask live: Show me around"] };
  } });
  try {
    const group = messaging.openDm(people.alice, ["bob"]);
    const trigger = messaging.post(group, "alice", "@agent Show me around");
    assert.equal(await messaging.processAgentJob("approved-worker"), true);
    const reply = messaging.db.prepare("SELECT * FROM messages WHERE seq = ?").get(jobFor(messaging, trigger).reply_seq);
    assert.equal(surface, "group_dm");
    assert.equal(calls.agent, 0);
    assert.equal(faqFor(messaging, trigger).surface, "group_dm");
    assert.deepEqual(JSON.parse(reply.suggestions), ["@s ask live: Show me around"]);
  } finally { messaging.close(); }
});

test("multiline, attached, threaded, and non-leading-mention requests stay on the live path", async t => {
  const directory = fixture(t);
  const { calls, messaging } = harness(directory);
  try {
    const channel = messaging.createChannel(people.alice, { name: "guardrails", memberIds: ["bob"] });
    const triggers = [
      messaging.post(channel, "alice", "Could you help, @s Show me around"),
      messaging.post(channel, "alice", "@s Show me around\nPlease include details"),
      messaging.post(channel, "alice", "@s Show me around", null, {
        attachments: [{ name: "context.txt", mime: "text/plain", data: Buffer.from("context") }],
      }),
    ];
    const root = messaging.post(channel, "alice", "Thread context");
    triggers.push(messaging.post(channel, "alice", "@s Show me around", root.seq));

    for (let index = 0; index < triggers.length; index++) {
      assert.equal(await messaging.processAgentJob(`live-worker-${index}`), true);
      assert.equal(faqFor(messaging, triggers[index]), undefined);
    }
    assert.equal(calls.matcher, 0);
    assert.equal(calls.agent, 4);
    assert.equal(calls.usage, 4);
  } finally { messaging.close(); }
});

test("ask-live requests, later DM turns, and matcher errors safely use the live agent", async t => {
  await t.test("ask live bypass", async t => {
    const directory = fixture(t);
    const { calls, messaging } = harness(directory, {
      matcher: value => /^\s*(?:@(?:s|agent|servant)\b[\s,:-]*)?ask live\s*:/iu.test(requestText(value)) ? null : APPROVED,
    });
    try {
      const dm = messaging.welcomeFromAgent("alice");
      const trigger = messaging.post(dm, "alice", "ask live: Show me around");
      assert.equal(await messaging.processAgentJob("live-worker"), true);
      assert.equal(calls.agent, 1);
      assert.equal(calls.usage, 1);
      assert.equal(messaging.db.prepare("SELECT text FROM messages WHERE seq = ?").get(jobFor(messaging, trigger).reply_seq).text,
        "Live agent answer");
      assert.equal(faqFor(messaging, trigger), undefined);
    } finally { messaging.close(); }
  });

  await t.test("only the first human DM turn is eligible", async t => {
    const directory = fixture(t);
    const { calls, messaging } = harness(directory);
    try {
      const dm = messaging.welcomeFromAgent("alice");
      const first = messaging.post(dm, "alice", "Show me around");
      assert.equal(await messaging.processAgentJob("approved-worker"), true);
      assert.ok(faqFor(messaging, first));
      assert.equal(calls.agent, 0);

      const second = messaging.post(dm, "alice", "Show me around");
      assert.equal(await messaging.processAgentJob("live-worker"), true);
      assert.equal(calls.agent, 1);
      assert.equal(calls.usage, 1);
      assert.equal(messaging.db.prepare("SELECT text FROM messages WHERE seq = ?").get(jobFor(messaging, second).reply_seq).text,
        "Live agent answer");
      assert.equal(faqFor(messaging, second), undefined);
      assert.equal(messaging.db.prepare("SELECT COUNT(*) AS n FROM faq_events").get().n, 1);
    } finally { messaging.close(); }
  });

  await t.test("matcher failure is fail-open", async t => {
    const directory = fixture(t);
    const { calls, messaging } = harness(directory, { matcher: () => { throw new Error("library unavailable"); } });
    try {
      const channel = messaging.createChannel(people.alice, { name: "errors" });
      const trigger = messaging.post(channel, "alice", "@s Show me around");
      assert.equal(await messaging.processAgentJob("live-worker"), true);
      assert.equal(calls.agent, 1);
      assert.equal(calls.usage, 1);
      assert.equal(jobFor(messaging, trigger).status, "done");
      assert.equal(faqFor(messaging, trigger), undefined);
    } finally { messaging.close(); }
  });
});

test("two workers can only persist one approved answer for one trigger", async t => {
  const directory = fixture(t);
  const a = harness(directory);
  const b = harness(directory);
  try {
    const channel = a.messaging.createChannel(people.alice, { name: "concurrency", memberIds: ["bob"] });
    const trigger = a.messaging.post(channel, "alice", "@servant Show me around");
    const claimed = await Promise.all([
      a.messaging.processAgentJob("worker-a"),
      b.messaging.processAgentJob("worker-b"),
    ]);

    assert.deepEqual(claimed.sort(), [false, true]);
    assert.equal(a.calls.agent + b.calls.agent, 0);
    assert.equal(a.calls.usage + b.calls.usage, 0);
    assert.equal(a.messaging.db.prepare("SELECT COUNT(*) AS n FROM faq_events WHERE trigger_seq = ?").get(trigger.seq).n, 1);
    assert.equal(a.messaging.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND user_id = 'agent'").get(channel.id).n, 1);
    const job = jobFor(a.messaging, trigger);
    assert.equal(job.status, "done");
    assert.equal(job.reply_seq, faqFor(a.messaging, trigger).reply_seq);
    assert.equal(await a.messaging.processAgentJob("worker-a-retry"), false);
  } finally { a.messaging.close(); b.messaging.close(); }
});
