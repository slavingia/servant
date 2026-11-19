import type { Features } from "./features.ts";
import type { LiveEvent, WorkLogEntry } from "./server.ts";
import { savedMessageHref, savedMessagePreview, visibleSavedMessages } from "./saved-messages.ts";

/** Conceal task sources according to this device's feature/Deep work settings. */
export function visibleWorkLog(entries: readonly WorkLogEntry[], features: Features): WorkLogEntry[] {
  return entries.map(entry => {
    if (entry.kind === "saved") {
      const visible = visibleSavedMessages([entry.completion], features)[0];
      return { ...entry, completion: { ...entry.completion, message: visible.message, conversation: visible.conversation } };
    }
    if (entry.kind === "todo") {
      return entry.source && !features.channels ? { ...entry, source: { ...entry.source, channelId: null, channelName: null } } : entry;
    }
    return entry;
  });
}

export function workLogLabel(entry: WorkLogEntry): string {
  if (entry.kind === "recording") return "Notes";
  if (entry.kind === "saved") return "Completed saved task";
  return entry.completedBy.kind === "agent" ? "Completed by Agent" : "To-do completed";
}

/** Attribution comes from the actor kind, never from a person's display name. */
export function workLogActor(entry: Extract<WorkLogEntry, { kind: "todo" }>): string {
  if (entry.completedBy.kind === "agent") return "Agent";
  if (entry.completedBy.kind === "person") return entry.completedBy.name ? `Person: ${entry.completedBy.name}` : "Person (name unavailable)";
  return "Not recorded";
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * Whether a finished to-do met its due date: "Due Nov 20, 2026. Done on time", "Done 1 day late", "Done 4 days late".
 * Days are whole calendar days in the reader's time zone, the same days the board shows. Nothing when it had no due date.
 */
export function workLogDue(entry: Extract<WorkLogEntry, { kind: "todo" }>, timeZone?: string): string {
  const match = DAY.exec(entry.due ?? "");
  if (!match) return "";
  const done = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(entry.at));
  const days = (day: string) => { const m = DAY.exec(day)!; return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / 86_400_000; };
  const late = days(done) - days(match[0]);
  const due = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!)));
  return `Due ${due}. ${late <= 0 ? "Done on time" : `Done ${late} ${late === 1 ? "day" : "days"} late`}`;
}

export function workLogPreview(entry: WorkLogEntry): string {
  if (entry.kind === "saved") return savedMessagePreview(entry.completion);
  if (entry.kind === "todo") return entry.source?.text ?? "This to-do is no longer available.";
  return entry.source ? entry.source.title || "Notes" : "These notes are no longer available.";
}

export function workLogHref(entry: WorkLogEntry) {
  if (entry.kind === "saved") return savedMessageHref(entry.completion);
  if (!entry.source) return null;
  if (entry.kind === "recording") return { pathname: "/notetaker/[id]" as const, params: { id: entry.recordingId } };
  return { pathname: "/todos" as const, params: { id: entry.todoId } };
}

export function workLogCounts(entries: readonly WorkLogEntry[]) {
  const tasks = new Set<string>();
  let completionCount = 0;
  let recordingCount = 0;
  let agentCompletionCount = 0;
  for (const entry of entries) {
    if (entry.kind === "recording") {
      recordingCount++;
      continue;
    }
    completionCount++;
    tasks.add(entry.kind === "saved" ? `saved:${entry.completion.messageId}` : `todo:${entry.todoId}`);
    if (entry.kind === "todo" && entry.completedBy.kind === "agent") agentCompletionCount++;
  }
  return { entryCount: entries.length, completionCount, taskCount: tasks.size, recordingCount, agentCompletionCount };
}

export function workLogChanged(entries: readonly WorkLogEntry[] | null, event: LiveEvent): boolean {
  if (event.event === "ready") return true;
  if (event.event !== "message.updated" && event.event !== "conversation.updated") return false;
  if (!entries) return true;
  return entries.some(entry => {
    if (event.event === "message.updated") return entry.kind === "saved" && entry.completion.messageId === event.data.id;
    const conversationId = entry.kind === "saved" ? entry.completion.conversation?.id
      : entry.kind === "todo" ? entry.source?.channelId : null;
    return conversationId === event.data.id;
  });
}
