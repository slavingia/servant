import type { SavedCompletion, WorkLogEntry } from "./server.ts";
import { workLogActor, workLogCounts, workLogDue, workLogLabel } from "./work-log.ts";

export type SavedCompletionRecord = SavedCompletion;
export type SavedReportPeriod = "today" | "week" | "all" | { from: string; to: string };
export type SavedReportClock = { now?: number; timeZone?: string };
export type SavedReportOptions = {
  period?: SavedReportPeriod;
  generatedAt?: number;
  timeZone?: string;
  serverName?: string;
  personName?: string;
};

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function validTime(value: number): Date {
  const date = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) throw new RangeError("Choose a valid report time.");
  return date;
}

/** A readable local timestamp for rows. The zone keeps repeated daylight-saving hours distinct. */
export function savedWorkLabel(value: number, timeZone = localTimeZone()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
    hour12: true, timeZoneName: "short",
  }).format(validTime(value));
}

/** Includes the zone and UTC instant so a repeated clock hour at the end of daylight saving is unambiguous. */
export function savedWorkTime(value: number, timeZone = localTimeZone()): string {
  const date = validTime(value);
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZoneName: "short",
  }).format(date);
  return `${local} [${timeZone}; ${date.toISOString()}]`;
}

function calendarDay(value: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(validTime(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function checkDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError("Use YYYY-MM-DD for report dates.");
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) throw new RangeError("Choose valid report dates.");
  return day;
}

function reportRange(period: SavedReportPeriod, now: number, timeZone: string) {
  // Validate the clock and zone even for an all-time report.
  const today = calendarDay(now, timeZone);
  if (period === "all") return { from: null, to: null, label: "All completion history" };
  if (period === "today") return { from: today, to: today, label: `Today (${today})` };
  if (period === "week") {
    // Subtract calendar days, not 24-hour durations, across daylight-saving changes.
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - 6);
    const from = date.toISOString().slice(0, 10);
    return { from, to: today, label: `Past 7 calendar days (${from} through ${today}, inclusive)` };
  }
  const from = checkDay(period.from);
  const to = checkDay(period.to);
  if (from > to) throw new RangeError("The report's start date must be on or before its end date.");
  return { from, to, label: `${from} through ${to} (inclusive)` };
}

/** Filters completion events, including older events for tasks that were reopened or removed from Saved. */
export function filterSavedCompletions(history: readonly SavedCompletionRecord[], period: SavedReportPeriod, clock: SavedReportClock = {}): SavedCompletionRecord[] {
  const timeZone = clock.timeZone ?? localTimeZone();
  const range = reportRange(period, clock.now ?? Date.now(), timeZone);
  return history.filter(item => {
    const day = calendarDay(item.completedAt, timeZone);
    return (!range.from || day >= range.from) && (!range.to || day <= range.to);
  }).sort((a, b) => b.completedAt - a.completedAt || a.id.localeCompare(b.id));
}

/** Uses the recorded event time: call end, recording upload, or task completion. */
export function filterWorkLog(history: readonly WorkLogEntry[], period: SavedReportPeriod, clock: SavedReportClock = {}): WorkLogEntry[] {
  const timeZone = clock.timeZone ?? localTimeZone();
  const range = reportRange(period, clock.now ?? Date.now(), timeZone);
  return history.filter(item => {
    const day = calendarDay(item.at, timeZone);
    return (!range.from || day >= range.from) && (!range.to || day <= range.to);
  }).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/** Preserve every word while making control characters and direction overrides visible. */
function reportText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Every data line remains quoted. Escape structural Markdown/HTML characters while keeping
// ordinary punctuation, file names, URLs, and exact timestamps readable in copied text.
function quote(value: string): string {
  return reportText(value).split("\n").map(line => `> ${line.replace(/[\\`*_\[\]<>#|]/g, "\\$&")}`).join("\n");
}

function completionData(item: SavedCompletionRecord, timeZone: string) {
  const available = !!item.message && !!item.conversation && !item.message.deleted && !item.message.pending && !item.message.activity;
  return {
    completionId: reportText(item.id),
    messageId: reportText(item.messageId),
    completedAt: savedWorkTime(item.completedAt, timeZone),
    savedAt: savedWorkTime(item.savedAt, timeZone),
    reopenedAt: item.reopenedAt === null ? null : savedWorkTime(item.reopenedAt, timeZone),
    completionState: item.reopenedAt === null ? "Completed; this completion has not been reopened" : "This completion was later reopened",
    workNote: typeof item.note === "string" && item.note.trim() ? reportText(item.note) : null,
    // Only this allowlist is exported. Account credentials, attachment ids, device details,
    // API URLs, and other response fields never enter the report.
    currentSource: available ? {
      conversation: reportText(item.conversation!.name),
      conversationKind: item.conversation!.kind,
      author: reportText(item.message!.user.name),
      text: reportText(item.message!.text),
      attachments: (item.message!.attachments ?? []).map(file => reportText(file.name)),
    } : null,
  };
}

function completionSections(entry: ReturnType<typeof completionData>): string[] {
  const sections = [
    `**Trace**\n\n${quote(`Completion ID: ${entry.completionId}\nMessage ID: ${entry.messageId}`)}`,
    `**Completed**\n\n${quote(entry.completedAt)}`,
    `**Saved**\n\n${quote(entry.savedAt)}`,
    `**Completion state**\n\n${quote(entry.completionState)}`,
    ...(entry.reopenedAt ? [`**Reopened**\n\n${quote(entry.reopenedAt)}`] : []),
    `**Work note**\n\n${entry.workNote ? quote(entry.workNote) : "No completion note recorded."}`,
  ];
  if (entry.currentSource) {
    const source = entry.currentSource;
    sections.push("**Current source message**",
      quote(`Conversation: ${source.conversation}${source.conversationKind === "channel" ? " (channel)" : " (direct message)"}\nAuthor: ${source.author}`),
      source.text ? quote(source.text) : "The source message has no text.",
      ...(source.attachments.length ? ["**Current source attachments**", ...source.attachments.map(name => quote(name))] : []));
  } else sections.push("**Current source message**\n\nSource unavailable. Message text, author, conversation, and attachment names are omitted.");
  return sections;
}

/** Produces clipboard text only. The caller decides when to copy it; nothing is sent to a service. */
export function buildSavedReport(history: readonly SavedCompletionRecord[], options: SavedReportOptions = {}) {
  const timeZone = options.timeZone ?? localTimeZone();
  const generatedAt = options.generatedAt ?? Date.now();
  const period = options.period ?? "week";
  const range = reportRange(period, generatedAt, timeZone);
  const selected = filterSavedCompletions(history, period, { now: generatedAt, timeZone });
  const entries = selected.map(item => completionData(item, timeZone));
  const completionCount = entries.length;
  const taskCount = new Set(selected.map(item => item.messageId)).size;
  const context = {
    ...(options.serverName ? { server: reportText(options.serverName) } : {}),
    ...(options.personName ? { person: reportText(options.personName) } : {}),
    generatedAt: savedWorkTime(generatedAt, timeZone),
    timeZone,
    period: range.label,
    completionCount,
    distinctTaskCount: taskCount,
  };
  const sections = [
    "# Saved message work log",
    ...(context.server ? [`**Server**\n\n${quote(context.server)}`] : []),
    ...(context.person ? [`**Person**\n\n${quote(context.person)}`] : []),
    `**Generated**\n\n${quote(context.generatedAt)}`,
    `**Period**\n\n${quote(`${range.label}; ${timeZone}`)}`,
    `**Summary:** ${completionCount} completion ${completionCount === 1 ? "event" : "events"}; ${taskCount} distinct ${taskCount === 1 ? "task" : "tasks"}.`,
    "Completion timestamps record check-offs, not time worked.",
  ];
  if (!entries.length) sections.push("No completion events in this period.");
  entries.forEach((entry, index) => {
    sections.push(`## Completion ${index + 1}`, ...completionSections(entry));
  });
  const markdown = sections.join("\n\n") + "\n";
  return { markdown, completionCount, taskCount, periodLabel: range.label };
}

/** One clipboard report of saved tasks, completed to-dos, and voice memos. */
export function buildWorkLogReport(history: readonly WorkLogEntry[], options: SavedReportOptions = {}) {
  const timeZone = options.timeZone ?? localTimeZone();
  const generatedAt = options.generatedAt ?? Date.now();
  const period = options.period ?? "week";
  const range = reportRange(period, generatedAt, timeZone);
  const periodLabel = period === "all" ? "All work history" : range.label;
  const entries = filterWorkLog(history, period, { now: generatedAt, timeZone });
  const counts = workLogCounts(entries);
  const sections = [
    "# Work log",
    ...(options.serverName ? [`**Server**\n\n${quote(options.serverName)}`] : []),
    ...(options.personName ? [`**Person**\n\n${quote(options.personName)}`] : []),
    `**Generated**\n\n${quote(savedWorkTime(generatedAt, timeZone))}`,
    `**Period**\n\n${quote(`${periodLabel}; ${timeZone}`)}`,
    `**Summary:** ${counts.completionCount} completion ${counts.completionCount === 1 ? "event" : "events"}; ${counts.taskCount} distinct ${counts.taskCount === 1 ? "task" : "tasks"}; ${counts.recordingCount} voice ${counts.recordingCount === 1 ? "memo" : "memos"}; ${counts.agentCompletionCount} ${counts.agentCompletionCount === 1 ? "completion" : "completions"} by Agent.`,
    "Completion timestamps record check-offs, not time worked.",
  ];
  if (!entries.length) sections.push("No work log entries in this period.");
  for (const [index, entry] of entries.entries()) {
    sections.push(`## ${index + 1}. ${workLogLabel(entry)}`);
    if (entry.kind === "saved") {
      sections.push(...completionSections(completionData(entry.completion, timeZone)));
    } else if (entry.kind === "recording") {
      sections.push(`**Recording ID**\n\n${quote(entry.recordingId)}`);
      sections.push(`**Recording added**\n\n${quote(savedWorkTime(entry.at, timeZone))}`);
      if (entry.durationMs !== null) sections.push(`**Recording duration**\n\n${quote(`${entry.durationMs / 1000} seconds`)}`);
      if (entry.source) {
        sections.push("**Current recording details**", quote(entry.source.title || "Voice memo"));
        if (entry.source.summary) sections.push("**Current recording summary**", quote(entry.source.summary));
      } else sections.push("**Current recording details**\n\nSource unavailable.");
    } else {
      sections.push(`**To-do ID**\n\n${quote(entry.todoId)}`,
        `**Completed**\n\n${quote(savedWorkTime(entry.at, timeZone))}`,
        `**Completed by**\n\n${quote(workLogActor(entry))}`,
        `**Created**\n\n${quote(savedWorkTime(entry.createdAt, timeZone))}`);
      if (entry.startedAt) sections.push(`**Started**\n\n${quote(savedWorkTime(entry.startedAt, timeZone))}`);
      if (workLogDue(entry, timeZone)) sections.push(`**Due**\n\n${quote(workLogDue(entry, timeZone))}`);
      if (entry.reopenedAt !== null) sections.push(`**Reopened**\n\n${quote(savedWorkTime(entry.reopenedAt, timeZone))}`);
      if (entry.source) {
        sections.push("**Current to-do**", quote(entry.source.text));
        const tags = [entry.source.projectName && `Project: ${entry.source.projectName}`, entry.source.releaseName && `Release: ${entry.source.releaseName}`, entry.source.channelName && `Channel: ${entry.source.channelName}`].filter(Boolean);
        if (tags.length) sections.push(quote(tags.join("\n")));
      } else sections.push("**Current to-do**\n\nSource unavailable.");
    }
  }
  return { markdown: sections.join("\n\n") + "\n", ...counts, periodLabel };
}
