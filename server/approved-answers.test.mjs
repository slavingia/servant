import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ApprovedAnswersError,
  approvedAnswerRequest,
  approvedAnswersPath,
  createApprovedAnswers,
  createApprovedAnswersStore,
  matchApprovedAnswer,
  normalizeApprovedQuestion,
  renderApprovedAnswer,
  validateApprovedAnswers,
} from "./approved-answers.mjs";

const NOW = Date.parse("2026-11-06T20:00:00.000Z");
const entry = (overrides = {}) => ({
  id: "show-me-around",
  question: "How do I get started?",
  aliases: ["Show me around", "Where should I begin?"],
  answer: "Start with **Home**, then choose Agent, Designs, or Research.",
  status: "published",
  sources: [{ title: "Servant onboarding", url: "https://servant.example/onboarding", date: "2026-11-01" }],
  approvedBy: "Workspace owner",
  approvedAt: "2026-11-01T12:00:00.000Z",
  reviewBy: "2026-12-01T12:00:00.000Z",
  version: 1,
  ...overrides,
});
const manifest = (...answers) => ({ version: 1, answers: answers.length ? answers : [entry()] });

test("normalization is deterministic, narrow, and strips one supported agent handle", () => {
  assert.equal(normalizeApprovedQuestion("  @Servant:  ＨＯＷ   do I get started?  "), "how do i get started");
  assert.equal(normalizeApprovedQuestion("@s Show me around."), "show me around");
  assert.equal(normalizeApprovedQuestion("Show me around??"), "show me around?");
  assert.equal(normalizeApprovedQuestion("@someone Show me around?"), "@someone show me around");
  assert.equal(normalizeApprovedQuestion(null), "");
});

test("ask live is an explicit bypass with or without a supported mention", () => {
  assert.deepEqual(approvedAnswerRequest("@agent ask live: Show me around?"), {
    bypass: true,
    normalized: "show me around",
    question: "Show me around?",
  });
  assert.equal(matchApprovedAnswer(manifest(), "ask live: Show me around?", NOW).kind, "bypass");
  assert.equal(matchApprovedAnswer(manifest(), "Can you ask live: Show me around?", NOW).kind, "miss");
});

test("validation preserves safe fields and rejects duplicate normalized aliases", () => {
  const valid = validateApprovedAnswers(manifest());
  assert.equal(valid.answers[0].id, "show-me-around");
  assert.equal(valid.answers[0].question, "How do I get started?");
  assert.equal(valid.answers[0].sources[0].url, "https://servant.example/onboarding");
  assert.throws(() => validateApprovedAnswers(manifest(
    entry(),
    entry({ id: "duplicate", aliases: ["@s show me around."] }),
  )), error => error instanceof ApprovedAnswersError && /Duplicate normalized alias/.test(error.message));
  assert.throws(() => validateApprovedAnswers(manifest(entry({ aliases: ["ask live: show me around"] }))), /reserved ask live/);
  assert.throws(() => validateApprovedAnswers(manifest(entry({ question: "ask live: show me around" }))), /reserved ask live/);
  assert.throws(() => validateApprovedAnswers(manifest(entry({ sources: [] }))), /needs 1-25 sources/);
  assert.throws(() => validateApprovedAnswers(manifest(entry({ sources: [{ title: "Internal", url: "http://insecure.example" }] }))), /must be HTTPS/);
  assert.throws(() => validateApprovedAnswers(manifest(entry({ sources: [{ title: "Broken", url: "https://example.gov/>bad" }] }))), /must be HTTPS/);
  assert.throws(() => validateApprovedAnswers(manifest(entry({ sources: [{ title: "Disguised", url: "https://trusted.example@evil.example/guide" }] }))), /without credentials/);
  assert.throws(() => validateApprovedAnswers(manifest(entry({ question: "" }))), /canonical question/);
  assert.throws(() => validateApprovedAnswers(manifest(entry({ approvedAt: "2026-02-31T12:00:00.000Z" }))), /real calendar timestamp/);
  assert.throws(() => validateApprovedAnswers(manifest(entry({ answer: "x".repeat(8_000) }))), /rendered message under 8,000 characters/);
  assert.throws(() => validateApprovedAnswers(manifest(entry({ version: "v1\nforged" }))), /letters-and-numbers label/);
  const unversioned = entry();
  delete unversioned.version;
  assert.throws(() => validateApprovedAnswers(manifest(unversioned)), /needs a version/);
  assert.equal(validateApprovedAnswers(manifest({ ...unversioned, status: "draft" })).answers[0].version, undefined);
  assert.throws(() => validateApprovedAnswers({ version: 2, answers: [] }), /version must be 1/);
});

test("matching is exact, published, approved, and fresh", () => {
  const data = manifest(
    entry(),
    entry({ id: "draft", question: "Is this draft visible?", aliases: ["Draft question"], status: "draft" }),
    entry({ id: "retired", question: "Is this retired?", aliases: ["Retired question"], status: "retired" }),
    entry({ id: "future", question: "Is this approved yet?", aliases: ["Future question"], approvedAt: "2026-11-07T12:00:00.000Z", reviewBy: "2026-12-07T12:00:00.000Z" }),
    entry({ id: "expired", question: "Has this expired?", aliases: ["Expired question"], expiresAt: "2026-11-06T19:59:59.000Z" }),
    entry({ id: "review-due", question: "Is this due for review?", aliases: ["Review due question"], reviewBy: "2026-11-06T20:00:00.000Z" }),
  );
  const hit = matchApprovedAnswer(data, "@s how do I get started.", NOW);
  assert.equal(hit.kind, "hit");
  assert.equal(hit.answer.id, "show-me-around");
  assert.equal(matchApprovedAnswer(data, "get started", NOW).kind, "miss", "no substring matching");
  assert.equal(matchApprovedAnswer(data, "How do I get start", NOW).kind, "miss", "no fuzzy matching");
  for (const question of ["Draft question", "Retired question", "Future question", "Expired question", "Review due question"]) {
    assert.equal(matchApprovedAnswer(data, question, NOW).kind, "miss", question);
  }
});

test("rendering produces deterministic ordinary Markdown with governance metadata", () => {
  const rendered = renderApprovedAnswer(entry({
    answer: "Use **Home** to choose where to begin.",
    sources: [
      { title: "Servant [onboarding]", url: "https://servant.example/onboarding", date: "2026-11-01" },
      { title: "Workspace guide", url: "https://servant.example/guide" },
    ],
    expiresAt: "2026-11-20T12:00:00.000Z",
  }));
  assert.equal(rendered, [
    "**Approved answer**",
    "",
    "Use **Home** to choose where to begin.",
    "",
    "**Sources**",
    "- [Servant \\[onboarding\\]](<https://servant.example/onboarding>) — 2026-11-01",
    "- [Workspace guide](<https://servant.example/guide>)",
    "",
    "Approved by Workspace owner · approved 2026-11-01 · review by 2026-12-01 · expires 2026-11-20",
    "",
    "Need a live response instead? Send `ask live: your question` in your agent chat, or `@s ask live: your question` in a channel or group message.",
  ].join("\n"));
  assert.throws(() => renderApprovedAnswer(entry({ status: "draft" })), /must be published/);
});

test("malformed or ambiguous input fails closed", () => {
  assert.equal(matchApprovedAnswer({ version: 1, answers: "broken" }, "Show me around", NOW).kind, "miss");
  assert.equal(matchApprovedAnswer({ version: 1, answers: [entry(), entry({ id: "other" })] }, "Show me around", NOW).kind, "miss");
  assert.equal(matchApprovedAnswer(manifest(), "", NOW).kind, "miss");
});

test("validation rejects a manifest that publishing could not reload", () => {
  const answers = Array.from({ length: 300 }, (_, index) => entry({
    id: `answer-${index}`,
    question: `How does answer ${index} work?`,
    aliases: [`Explain answer ${index}`],
    answer: "x".repeat(7_000),
  }));
  assert.throws(() => validateApprovedAnswers(manifest(...answers)), /file must be under 2,097,152 bytes/);
});

test("the store publishes atomically with private permissions and reloads edits", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-approved-answers-"));
  const file = approvedAnswersPath(directory);
  const errors = [];
  const store = createApprovedAnswersStore(file, { log: { error: message => errors.push(message) } });
  try {
    assert.equal(store.match("Show me around", NOW).kind, "miss");
    store.publish(manifest());
    assert.equal(store.match("Show me around", NOW).kind, "hit");
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store.status(NOW), { file, valid: true, error: null, total: 1, published: 1, fresh: 1 });

    fs.writeFileSync(file, "{ broken", { mode: 0o600 });
    assert.equal(store.match("Show me around", NOW).kind, "miss", "bad refresh never serves the earlier valid answer");
    assert.equal(store.status(NOW).valid, false);
    assert.ok(errors.length);

    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => store.publish(manifest(entry({ sources: [] }))), /needs 1-25 sources/);
    assert.equal(fs.readFileSync(file, "utf8"), before, "validation failure never replaces the file");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an independent reader sees an equally sized atomic replacement", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-approved-reload-"));
  const file = approvedAnswersPath(directory);
  const publisher = createApprovedAnswersStore(file, { log: { error() {} } });
  const reader = createApprovedAnswersStore(file, { log: { error() {} } });
  try {
    publisher.publish(manifest());
    assert.equal(reader.match("Show me around", NOW).kind, "hit");
    publisher.publish(manifest(entry({ aliases: ["Take me around", "Where should I begin?"] })));
    assert.equal(reader.match("Show me around", NOW).kind, "miss");
    assert.equal(reader.match("Take me around", NOW).kind, "hit");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the runtime facade exposes safe matching, bounded search, status and publishing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-approved-runtime-"));
  let at = NOW;
  const library = createApprovedAnswers({ directory, now: () => at, log: { error() {} } });
  try {
    library.publish(manifest(
      entry(),
      entry({ id: "password", question: "How do I reset my password?", aliases: ["Reset password"], answer: "Use the account recovery link." }),
    ));
    assert.equal(library.match("Show me around")?.kind, "hit");
    assert.equal(library.match("ask live: Show me around")?.kind, "bypass");
    assert.equal(library.match("unrelated"), null);
    assert.deepEqual(library.search("reset password", 1).map(answer => answer.id), ["password"]);
    assert.equal(library.search("account", 100).length, 1);
    assert.equal(library.status().fresh, 2);
    at = Date.parse("2027-01-01T00:00:00.000Z");
    assert.equal(library.match("Show me around"), null);
    assert.equal(library.search("started").length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown manifest, answer or source fields fail visibly instead of being dropped", () => {
  const cases = [
    [{ ...manifest(), audience: "owner-only" }, /approved answers file has unsupported field "audience"/],
    [manifest(entry({ audience: "owner-only" })), /Answer show-me-around has unsupported field "audience".*restricted audiences aren't supported/],
    [manifest(entry({ sources: [{ title: "Guide", url: "https://servant.example/guide", internal: true }] })), /source 1 has unsupported field "internal"/],
    [manifest(entry({ visibility: "private", channel: "leadership" })), /unsupported fields "visibility", "channel"/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => validateApprovedAnswers(raw), error => error instanceof ApprovedAnswersError && message.test(error.message), String(message));
  }
  assert.throws(() => renderApprovedAnswer(entry({ audience: "owner-only" })), /unsupported field "audience"/);
  // Publishing refuses, and a file edited by hand stops serving any answer.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "servant-approved-answers-"));
  const file = approvedAnswersPath(directory);
  const errors = [];
  const store = createApprovedAnswersStore(file, { log: { error: message => errors.push(message) } });
  try {
    store.publish(manifest());
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => store.publish(manifest(entry({ audience: "owner-only" }))), /unsupported field "audience"/);
    assert.equal(fs.readFileSync(file, "utf8"), before, "nothing is published");
    fs.writeFileSync(file, JSON.stringify(manifest(entry({ audience: "owner-only" }))), { mode: 0o600 });
    assert.equal(store.match("Show me around", NOW).kind, "miss", "fails closed to the live agent");
    assert.match(store.status(NOW).error, /unsupported field "audience"/);
    assert.ok(errors.some(message => /audience/.test(message)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
