import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIRM_FAILED, continueHint, defaultShareProject, progressLabel, sendShare, ShareSendError, shareTitle, type ShareProgress, type ShareSendDeps } from "./share-send.ts";
import type { StreamEvent } from "./agent-events.ts";
import type { Upload } from "./server";

const turn = (accepted: boolean): StreamEvent => ({ type: "turn", turn: { id: "t1", chatId: "cht_1", status: "running", accepted, text: "", assistantText: "", canStop: true, createdAt: 1, updatedAt: 1 } });
const photo: Upload = { name: "IMG_1.jpg", data: "/9j/abc" };
const doc: Upload = { name: "Report.pdf", data: "", document: { uri: "file:///c/Report.pdf", size: 20480 } };

// A fake server: records calls, answers the stream with the given events.
function fakeDeps(events: StreamEvent[] | ((onEvent: (e: StreamEvent) => void, signal: AbortSignal) => void), { failChat = false, failUpload = false } = {}) {
  const calls: { newChat: unknown[]; uploads: { chatId: string; name: string }[]; sent: { chatId: string; text: string; uploads: Upload[]; requestId: string; abortedAfter: boolean }[] } = { newChat: [], uploads: [], sent: [] };
  const deps: ShareSendDeps = {
    newChat: async options => { calls.newChat.push(options); if (failChat) throw new Error("The server isn't reachable right now"); return { id: "cht_new", title: "New chat" }; },
    uploadDocument: async (chatId, file, onProgress) => { calls.uploads.push({ chatId, name: file.name }); if (failUpload) throw new Error("Couldn't upload this file. Try again"); onProgress(0.5); onProgress(1); return `up_${file.name}`; },
    send: async (chatId, text, uploads, requestId, onEvent, signal) => {
      const record = { chatId, text, uploads, requestId, abortedAfter: false };
      calls.sent.push(record);
      if (typeof events === "function") events(onEvent, signal);
      else for (const event of events) { if (signal.aborted) break; onEvent(event); }
      record.abortedAfter = signal.aborted;
      // A closed stream rejects, like the real reader does after abort.
      if (signal.aborted) throw new Error("Request cancelled");
    },
  };
  return { deps, calls };
}

test("a new chat in the chosen project; the stream closes as soon as the message is accepted", async () => {
  const { deps, calls } = fakeDeps([{ type: "status", text: "Thinking" }, turn(true), { type: "delta", text: "Hi" }, { type: "done" }]);
  const steps: ShareProgress[] = [];
  const chat = await sendShare({ text: "What is this?", uploads: [photo], target: { kind: "new", projectId: "prj_1" }, requestId: "req-1", deps, onProgress: p => steps.push(p) });
  assert.deepEqual(calls.newChat, [{ projectId: "prj_1" }]);
  assert.equal(calls.sent.length, 1);
  assert.deepEqual([calls.sent[0]!.chatId, calls.sent[0]!.text, calls.sent[0]!.requestId], ["cht_new", "What is this?", "req-1"]);
  assert.deepEqual(calls.sent[0]!.uploads, [photo]);
  assert.ok(calls.sent[0]!.abortedAfter, "the reply stream is closed once accepted");
  assert.deepEqual(chat, { id: "cht_new", title: "What is this?" });
  assert.deepEqual(steps.map(s => s.stage), ["create", "send"]);
});

test("no project means a plain chat; the title falls back to the first file's name", async () => {
  const { deps, calls } = fakeDeps([turn(true)]);
  const chat = await sendShare({ text: "   ", uploads: [photo], target: { kind: "new", projectId: null }, requestId: "r", deps });
  assert.deepEqual(calls.newChat, [{}]);
  assert.equal(chat.title, "IMG_1.jpg");
  assert.equal(shareTitle("  many   spaces  here ", []), "many spaces here");
  assert.equal(shareTitle("", []), "New chat");
});

test("continuing the last chat sends there and keeps its title", async () => {
  const { deps, calls } = fakeDeps([{ type: "sent", message: { id: "msg_1", role: "user", text: "x" } }]);
  const chat = await sendShare({ text: "more", uploads: [], target: { kind: "chat", id: "cht_old", title: "Refund timing" }, requestId: "r", deps });
  assert.equal(calls.newChat.length, 0);
  assert.equal(calls.sent[0]!.chatId, "cht_old");
  assert.deepEqual(chat, { id: "cht_old", title: "Refund timing" });
});

test("documents go up in chunks first, then the message names them", async () => {
  const { deps, calls } = fakeDeps([turn(true)]);
  const steps: ShareProgress[] = [];
  await sendShare({ text: "", uploads: [doc, photo], target: { kind: "new", projectId: null }, requestId: "r", deps, onProgress: p => steps.push(p) });
  assert.deepEqual(calls.uploads, [{ chatId: "cht_new", name: "Report.pdf" }]);
  assert.deepEqual(calls.sent[0]!.uploads, [{ ...doc, upload: "up_Report.pdf" }, photo]);
  assert.deepEqual(steps, [{ stage: "create" }, { stage: "upload", file: "Report.pdf", fraction: 0 }, { stage: "upload", file: "Report.pdf", fraction: 0.5 }, { stage: "upload", file: "Report.pdf", fraction: 1 }, { stage: "send" }]);
  assert.equal(progressLabel(steps[2]!), "Uploading Report.pdf, 50%");
  assert.equal(progressLabel({ stage: "create" }), "Starting the chat…");
  assert.equal(progressLabel({ stage: "send" }), "Sending…");
});

test("an older server that only answers with the reply still counts as sent", async () => {
  const { deps } = fakeDeps([{ type: "delta", text: "Sure" }, { type: "message", text: "Sure" }, { type: "done" }]);
  const chat = await sendShare({ text: "hi", uploads: [], target: { kind: "new", projectId: null }, requestId: "r", deps });
  assert.equal(chat.id, "cht_new");
});

test("failures say what happened and keep what already worked for the retry", async () => {
  // The chat could not be made: nothing to reuse.
  await assert.rejects(sendShare({ text: "hi", uploads: [], target: { kind: "new", projectId: null }, requestId: "r", deps: fakeDeps([], { failChat: true }).deps }),
    (e: unknown) => e instanceof ShareSendError && e.stage === "create" && e.chat === null && e.message === "The server isn't reachable right now");
  // The upload failed: the chat exists, no document id yet.
  await assert.rejects(sendShare({ text: "", uploads: [doc], target: { kind: "new", projectId: null }, requestId: "r", deps: fakeDeps([], { failUpload: true }).deps }),
    (e: unknown) => e instanceof ShareSendError && e.stage === "upload" && e.chat?.id === "cht_new" && e.uploads[0]!.upload === undefined);
  // The server refused the message.
  await assert.rejects(sendShare({ text: "", uploads: [doc], target: { kind: "new", projectId: null }, requestId: "r", deps: fakeDeps([{ type: "error", message: "That message is too long" }, { type: "done" }]).deps }),
    (e: unknown) => e instanceof ShareSendError && e.stage === "send" && e.chat?.id === "cht_new" && e.uploads[0]!.upload === "up_Report.pdf" && e.message === "That message is too long");
  // The stream ended without the server ever confirming.
  await assert.rejects(sendShare({ text: "hi", uploads: [], target: { kind: "new", projectId: null }, requestId: "r", deps: fakeDeps([{ type: "status", text: "…" }, { type: "done" }]).deps }),
    (e: unknown) => e instanceof ShareSendError && e.message === CONFIRM_FAILED);
  // The request itself failed (network, 4xx) before anything was accepted.
  const broken = fakeDeps(() => { throw new Error("The server isn't reachable right now"); });
  await assert.rejects(sendShare({ text: "hi", uploads: [], target: { kind: "new", projectId: null }, requestId: "r", deps: broken.deps }),
    (e: unknown) => e instanceof ShareSendError && e.stage === "send" && e.message === "The server isn't reachable right now");
});

test("a retry reuses the chat and the uploaded documents instead of making more", async () => {
  const { deps, calls } = fakeDeps([turn(true)]);
  const chat = await sendShare({ text: "", uploads: [{ ...doc, upload: "up_Report.pdf" }], target: { kind: "new", projectId: "prj_1" }, requestId: "r", reuse: { id: "cht_first", title: "New chat" }, deps });
  assert.equal(calls.newChat.length, 0);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.sent[0]!.chatId, "cht_first");
  assert.equal(chat.id, "cht_first");
});

test("the line under Continue my last chat says what each position of the switch does", () => {
  assert.equal(continueHint("Refund tracker", "Refund timing"), "Off: starts a new chat in Refund tracker. On: adds to Refund timing.");
  assert.equal(continueHint(null, "Refund timing"), "Off: starts a new chat. On: adds to Refund timing.");
  // A title that already ends a sentence isn't given a second stop; a long one is cut short; backticks and runs of spaces are tidied.
  assert.equal(continueHint("Refund tracker", "How should we summarize refund delays?"), "Off: starts a new chat in Refund tracker. On: adds to How should we summarize refund delays?");
  assert.equal(continueHint(null, "A very long chat title that keeps going on and on about amended returns"), "Off: starts a new chat. On: adds to A very long chat title that keeps going…");
  assert.equal(continueHint("Refund tracker", "How should we summarize refund delays for the team?"), "Off: starts a new chat in Refund tracker. On: adds to How should we summarize refund delays…");
  assert.equal(continueHint(null, "Supercalifragilisticexpialidocious-refund-timeline-2026-amended"), "Off: starts a new chat. On: adds to Supercalifragilisticexpialidocious-refun…");
  assert.equal(continueHint(null, "`code`   title"), "Off: starts a new chat. On: adds to code title.");
  assert.equal(continueHint(null, "   "), "Off: starts a new chat. On: adds to your last chat.");
});

test("the project a share starts in: the one the Agent tab remembers, when it's still offered", () => {
  const projects = { list: [{ id: "prj_1", name: "Refunds" }], vibeCoder: false, vibe: true } as unknown as Parameters<typeof defaultShareProject>[0];
  assert.equal(defaultShareProject(projects, "prj_1"), "prj_1");
  assert.equal(defaultShareProject(projects, "prj_gone"), null);
  assert.equal(defaultShareProject(projects, "vibe"), null, "prototyping isn't a place to send files");
  assert.equal(defaultShareProject(projects, null), null);
  assert.equal(defaultShareProject(null, "prj_1"), null);
  assert.equal(defaultShareProject({ ...projects!, vibeCoder: true }, "prj_1"), null);
});
