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
const meeting: Extract<WorkLogEntry, { kind: "meeting" }> = {
  kind: "meeting", id: "meeting:call:meeting_1", at: 4000, meetingId: "meeting_1", meetingKind: "call", timeBasis: "meeting",
  startedAt: 2000, endedAt: 4000, durationMs: 2000, source: { title: "Release review", summary: "Reviewed the plan", conversationId: "ch_example" },
};
const todo: Extract<WorkLogEntry, { kind: "todo" }> = {
  kind: "todo", id: "todo:completion_2", at: 5000, todoId: "10", createdAt: 1000, reopenedAt: null, originKind: null,
  completedBy: { kind: "agent" }, source: { text: "Check the links", projectId: "p_1", projectName: "example-app", releaseId: null, releaseName: null, channelId: "ch_example", channelName: "example-app" },
};
const allFeatures = { channels: true, directMessages: true, meetings: true };

test("counts completion events, namespaced distinct tasks, meetings and Agent work separately", () => {
  const again = { ...saved, id: "saved:completion_3", completion: { ...saved.completion, id: "completion_3", reopenedAt: 3500 } };
  const recording = { ...meeting, id: "meeting:recording:rec_1", meetingId: "rec_1", meetingKind: "recording" as const, timeBasis: "recording-upload" as const, startedAt: null, endedAt: null };
  assert.deepEqual(workLogCounts([saved, again, todo, meeting, recording]), {
    entryCount: 5, completionCount: 3, taskCount: 2, meetingCount: 2, attendedMeetingCount: 1, recordingCount: 1, agentCompletionCount: 1,
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

test("meeting flags hide meeting activity; conversation flags conceal sources and preserve task history", () => {
  const hidden = visibleWorkLog([saved, meeting, todo], { ...allFeatures, channels: false });
  assert.equal(hidden.length, 3);
  assert.equal((hidden[0] as typeof saved).completion.message, null);
  assert.equal((hidden[0] as typeof saved).completion.note, saved.completion.note);
  assert.equal((hidden[1] as typeof meeting).source, null);
  assert.deepEqual((hidden[2] as typeof todo).source, { ...todo.source, channelId: null, channelName: null });
  const fromMeeting = { ...todo, originKind: "recording" as const };
  const meetingsOff = visibleWorkLog([meeting, todo, fromMeeting], { ...allFeatures, meetings: false });
  assert.equal(meetingsOff.length, 2);
  assert.equal(workLogCounts(meetingsOff).meetingCount, 0);
  assert.deepEqual((meetingsOff[0] as typeof todo).source, todo.source);
  assert.equal((meetingsOff[1] as typeof todo).source, null);
  const dmCall = { ...meeting, source: { ...meeting.source!, conversationId: "dm_example" } };
  assert.equal((visibleWorkLog([dmCall], { ...allFeatures, directMessages: false })[0] as typeof meeting).source, null);
});

test("source links choose message thread, meeting kind, or to-do and disappear for unavailable sources", () => {
  assert.deepEqual(workLogHref(saved), { pathname: "/thread", params: { conv: "ch_example", root: "7", focus: "10", from: "saved", title: "#example-app" } });
  assert.deepEqual(workLogHref(meeting), { pathname: "/meetings/[id]", params: { id: "meeting_1", kind: "call" } });
  assert.deepEqual(workLogHref(todo), { pathname: "/todos", params: { id: "10" } });
  assert.equal(workLogHref({ ...meeting, source: null }), null);
  assert.equal(workLogHref({ ...todo, source: null }), null);
  assert.equal(workLogHref({ ...saved, completion: { ...saved.completion, message: null, conversation: null } }), null);
});

test("recordings are labeled as recorded meetings, with truthful title fallbacks", () => {
  const recording = { ...meeting, meetingKind: "recording" as const, timeBasis: "recording-upload" as const, startedAt: null, endedAt: null, source: { ...meeting.source!, title: null } };
  assert.equal(workLogLabel(recording), "Recorded meeting");
  assert.equal(workLogPreview(recording), "Recorded meeting");
  assert.equal(workLogLabel(meeting), "Attended meeting");
  assert.equal(workLogPreview({ ...meeting, source: null }), "This meeting is no longer available.");
  assert.equal(workLogPreview({ ...todo, source: null }), "This to-do is no longer available.");
});

test("live source changes revalidate affected history, including bookmarks already removed", () => {
  const entries = [saved, meeting, todo];
  assert.equal(workLogChanged(entries, { event: "ready", data: {} }), true);
  assert.equal(workLogChanged(entries, { event: "message.updated", data: saved.completion.message! }), true);
  assert.equal(workLogChanged(entries, { event: "message.updated", data: { ...saved.completion.message!, id: "999" } }), false);
  assert.equal(workLogChanged(entries, { event: "conversation.updated", data: { id: "ch_example" } }), true);
  assert.equal(workLogChanged(entries, { event: "conversation.read", data: { id: "ch_example" } }), false);
  assert.equal(workLogChanged(null, { event: "message.updated", data: saved.completion.message! }), true);
});

test("projection and counting leave supplied history unchanged", () => {
  const entries = Object.freeze([saved, meeting, todo]);
  const before = JSON.stringify(entries);
  visibleWorkLog(entries, { channels: false, directMessages: false, meetings: false });
  workLogCounts(entries);
  assert.equal(JSON.stringify(entries), before);
});
