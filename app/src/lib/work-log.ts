import type { Features } from "./features.ts";
import type { LiveEvent, WorkLogEntry } from "./server.ts";
import { savedMessageHref, savedMessagePreview, visibleSavedMessages } from "./saved-messages.ts";

/** Hide meeting activity and conceal task sources according to this device's feature/Deep work settings. */
export function visibleWorkLog(entries: readonly WorkLogEntry[], features: Features): WorkLogEntry[] {
  return entries.filter(entry => entry.kind !== "meeting" || features.meetings).map(entry => {
    if (entry.kind === "saved") {
      const visible = visibleSavedMessages([entry.completion], features)[0];
      return { ...entry, completion: { ...entry.completion, message: visible.message, conversation: visible.conversation } };
    }
    if (entry.kind === "todo") {
      if (entry.originKind && !features.meetings) return { ...entry, source: null };
      return entry.source && !features.channels ? { ...entry, source: { ...entry.source, channelId: null, channelName: null } } : entry;
    }
    const conversationId = entry.source?.conversationId;
    const hidden = (conversationId?.startsWith("ch_") && !features.channels)
      || (conversationId?.startsWith("dm_") && !features.directMessages);
    return hidden ? { ...entry, source: null } : entry;
  });
}

export function workLogLabel(entry: WorkLogEntry): string {
  if (entry.kind === "meeting") return entry.timeBasis === "recording-upload" ? "Recorded meeting" : "Attended meeting";
  if (entry.kind === "saved") return "Completed saved task";
  return entry.completedBy.kind === "agent" ? "Completed by Agent" : "To-do completed";
}

/** Attribution comes from the actor kind, never from a person's display name. */
export function workLogActor(entry: Extract<WorkLogEntry, { kind: "todo" }>): string {
  if (entry.completedBy.kind === "agent") return "Agent";
  if (entry.completedBy.kind === "person") return entry.completedBy.name ? `Person: ${entry.completedBy.name}` : "Person (name unavailable)";
  return "Not recorded";
}

export function workLogPreview(entry: WorkLogEntry): string {
  if (entry.kind === "saved") return savedMessagePreview(entry.completion);
  if (entry.kind === "todo") return entry.source?.text ?? "This to-do is no longer available.";
  return entry.source ? entry.source.title || (entry.meetingKind === "recording" ? "Recorded meeting" : "Meeting") : "This meeting is no longer available.";
}

export function workLogHref(entry: WorkLogEntry) {
  if (entry.kind === "saved") return savedMessageHref(entry.completion);
  if (!entry.source) return null;
  if (entry.kind === "meeting") return { pathname: "/meetings/[id]" as const, params: { id: entry.meetingId, kind: entry.meetingKind } };
  return { pathname: "/todos" as const, params: { id: entry.todoId } };
}

export function workLogCounts(entries: readonly WorkLogEntry[]) {
  const tasks = new Set<string>();
  let completionCount = 0;
  let meetingCount = 0;
  let attendedMeetingCount = 0;
  let recordingCount = 0;
  let agentCompletionCount = 0;
  for (const entry of entries) {
    if (entry.kind === "meeting") {
      meetingCount++;
      if (entry.timeBasis === "recording-upload") recordingCount++;
      else attendedMeetingCount++;
      continue;
    }
    completionCount++;
    tasks.add(entry.kind === "saved" ? `saved:${entry.completion.messageId}` : `todo:${entry.todoId}`);
    if (entry.kind === "todo" && entry.completedBy.kind === "agent") agentCompletionCount++;
  }
  return { entryCount: entries.length, completionCount, taskCount: tasks.size, meetingCount, attendedMeetingCount, recordingCount, agentCompletionCount };
}

export function workLogChanged(entries: readonly WorkLogEntry[] | null, event: LiveEvent): boolean {
  if (event.event === "ready") return true;
  if (event.event !== "message.updated" && event.event !== "conversation.updated") return false;
  if (!entries) return true;
  return entries.some(entry => {
    if (event.event === "message.updated") return entry.kind === "saved" && entry.completion.messageId === event.data.id;
    const conversationId = entry.kind === "saved" ? entry.completion.conversation?.id
      : entry.kind === "meeting" ? entry.source?.conversationId : entry.source?.channelId;
    return conversationId === event.data.id;
  });
}
