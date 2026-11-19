import test from "node:test";
import assert from "node:assert/strict";
import { visibleWorkLog, workLogActor, workLogChanged, workLogCounts, workLogHref, workLogLabel, workLogPreview } from "./work-log.ts";
import type { WorkLogEntry } from "./server.ts";

const saved: Extract<WorkLogEntry, { kind: "saved" }> = {
  kind: "saved", id: "saved:completion_1", at: 3000,
  completion: {
    id: "completion_1", messageId: "10", savedAt: 1000, completedAt: 3000, note: "Reviewed the release", reopenedAt: null,
    conversation: { id: "ch_example", kind: "channel", name: "example-app" },
    message: { id: "10", conversationId: "ch_example", user: { id: "pat", name: "Pat Tester" }, text: "Review release", threadRoot: "7", deleted: false, pending: false, replyCount: 0, lastReplyAt: null, createdAt: 500, editedAt: null },
  },
};
const recording: Extract<WorkLogEntry, { kind: "recording" }> = {
  kind: "recording", id: "recording:rec_1", at: 4000, recordingId: "rec_1", durationMs: 2000,
  source: { title: "Release review", summary: "Reviewed the plan" },
};
const todo: Extract<WorkLogEntry, { kind: "todo" }> = {
  kind: "todo", id: "todo:completion_2", at: 5000, todoId: "10", createdAt: 1000, reopenedAt: null, originKind: null,
  completedBy: { kind: "agent" }, source: { text: "Check the links", projectId: "p_1", projectName: "example-app", releaseId: null, releaseName: null, channelId: "ch_example", channelName: "example-app" },
};
const allFeatures = { channels: true, directMessages: true, secureInbox: true, people: true, home: true };

test("counts completion events, distinct tasks, voice memos and Agent work separately", () => {
  const again = { ...saved, id: "saved:completion_3", completion: { ...saved.completion, id: "completion_3", reopenedAt: 3500 } };
  assert.deepEqual(workLogCounts([saved, again, todo, recording]), {
    entryCount: 4, completionCount: 3, taskCount: 2, recordingCount: 1, agentCompletionCount: 1,
  });
});

test("Agent attribution depends on actor kind, not a person's name or source text", () => {
  const human = { ...todo, completedBy: { kind: "person" as const, id: "pat", name: "Agent" } };
  const unknown = { ...todo, completedBy: { kind: "unknown" as const } };
  assert.equal(workLogLabel(todo), "Completed by Agent");
  assert.equal(workLogActor(todo), "Agent");
  assert.equal(workLogLabel(human), "To-do completed");
  assert.equal(workLogActor(human), "Person: Agent");
  assert.equal(workLogActor(unknown), "Not recorded");
  assert.equal(workLogCounts([human, unknown]).agentCompletionCount, 0);
});

test("conversation flags conceal sources while voice memos stay in history", () => {
  const hidden = visibleWorkLog([saved, recording, todo], { ...allFeatures, channels: false });
  assert.equal(hidden.length, 3);
  assert.equal((hidden[0] as typeof saved).completion.message, null);
  assert.equal((hidden[0] as typeof saved).completion.note, saved.completion.note);
  assert.deepEqual((hidden[1] as typeof recording).source, recording.source);
  assert.deepEqual((hidden[2] as typeof todo).source, { ...todo.source, channelId: null, channelName: null });
});

test("source links choose message thread, recording, or to-do and disappear for unavailable sources", () => {
  assert.deepEqual(workLogHref(saved), { pathname: "/thread", params: { conv: "ch_example", root: "7", focus: "10", from: "saved", title: "#example-app" } });
  assert.deepEqual(workLogHref(recording), { pathname: "/notetaker/[id]", params: { id: "rec_1" } });
  assert.deepEqual(workLogHref(todo), { pathname: "/todos", params: { id: "10" } });
  assert.equal(workLogHref({ ...recording, source: null }), null);
  assert.equal(workLogHref({ ...todo, source: null }), null);
  assert.equal(workLogHref({ ...saved, completion: { ...saved.completion, message: null, conversation: null } }), null);
});

test("voice memos have truthful title fallbacks", () => {
  const untitled = { ...recording, source: { ...recording.source!, title: null } };
  assert.equal(workLogLabel(untitled), "Notes");
  assert.equal(workLogPreview(untitled), "Notes");
  assert.equal(workLogPreview({ ...recording, source: null }), "These notes are no longer available.");
  assert.equal(workLogPreview({ ...todo, source: null }), "This to-do is no longer available.");
});

test("live source changes revalidate affected history, including bookmarks already removed", () => {
  const entries = [saved, recording, todo];
  assert.equal(workLogChanged(entries, { event: "ready", data: {} }), true);
  assert.equal(workLogChanged(entries, { event: "message.updated", data: saved.completion.message! }), true);
  assert.equal(workLogChanged(entries, { event: "message.updated", data: { ...saved.completion.message!, id: "999" } }), false);
  assert.equal(workLogChanged(entries, { event: "conversation.updated", data: { id: "ch_example" } }), true);
  assert.equal(workLogChanged(entries, { event: "conversation.read", data: { id: "ch_example" } }), false);
  assert.equal(workLogChanged(null, { event: "message.updated", data: saved.completion.message! }), true);
});

test("projection and counting leave supplied history unchanged", () => {
  const entries = Object.freeze([saved, recording, todo]);
  const before = JSON.stringify(entries);
  visibleWorkLog(entries, { channels: false, directMessages: false, secureInbox: false, people: false, home: false });
  workLogCounts(entries);
  assert.equal(JSON.stringify(entries), before);
});
