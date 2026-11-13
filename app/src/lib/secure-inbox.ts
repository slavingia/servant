export type InboxStatus = "open" | "resolved";
export type InboxFilter = InboxStatus | "all";
export type InboxScope = "all" | "mine" | "unassigned" | "due";
export type InboxAudience = "conversation" | "team";
export type InboxFile = { id: string; name: string; mime: string; size: number };
export type InboxUpload = { name: string; data: string; size: number };
export type InboxConversation = {
  id: string; name: string; email: string | null; subject: string; status: InboxStatus;
  assigneeId: string | null; assigneeName: string | null; createdAt: number; updatedAt: number; unread: number;
  lastMessage: { text: string; at: number; sender: "visitor" | "staff" } | null;
  reference: string; openTaskCount: number; nextAction: InboxTask | null;
};
export type InboxMessage = {
  id: string; sequence: number; conversationId: string; sender: "visitor" | "staff";
  senderName: string; text: string; createdAt: number; attachments: InboxFile[];
};
export type InboxPage = { conversation: InboxConversation; messages: InboxMessage[]; hasMore: boolean };
export type InboxListPage = { conversations: InboxConversation[]; hasMore: boolean; nextOffset: number | null; publicUrl: string | null };
export type InboxNote = { id: string; sequence: number; conversationId: string; senderName: string; text: string; createdAt: number; attachments: InboxFile[] };
export type InboxTask = { id: string; conversationId: string; text: string; status: "open" | "done"; assigneeId: string | null; assigneeName: string | null; dueDate: string | null; createdAt: number; createdByName: string; completedAt: number | null };
export type InboxActivity = { id: string; sequence: number; kind: string; actorName: string; at: number; text: string };
// Whether the visitor is emailed when the team replies. `available` is the server: it needs a mailer and a public
// address. `on` means the visitor typed the code sent to `email`, so that address is theirs.
export type InboxNotify = { available: boolean; state: "none" | "pending" | "on" | "off"; email: string | null };
export type InboxCase = { conversation: InboxConversation; reference: string; tasks: InboxTask[]; openTaskCount: number; nextAction: InboxTask | null; notify?: InboxNotify };
export type InboxTaskPatch = { status?: "open" | "done"; assigneeId?: string | null; dueDate?: string | null };
export const INBOX_FILE_LIMIT = 5 * 1024 * 1024;
export const INBOX_TOTAL_LIMIT = 10 * 1024 * 1024;

export function validateInboxFiles(files: readonly { size: number }[]) {
  if (files.length > 4) throw new Error("Attach up to 4 files per reply.");
  if (files.some(file => !Number.isSafeInteger(file.size) || file.size < 0 || file.size > INBOX_FILE_LIMIT)) throw new Error("Choose files no larger than 5 MB each.");
  if (files.reduce((total, file) => total + file.size, 0) > INBOX_TOTAL_LIMIT) throw new Error("Choose files no larger than 10 MB together.");
}

export function mergeInboxMessages<T extends { id: string; sequence: number }>(previous: readonly T[], incoming: readonly T[]): T[] {
  const messages = new Map(previous.map(message => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence);
}

export function inboxCursor(messages: readonly { sequence: number }[]) {
  return messages.reduce((last, message) => Math.max(last, message.sequence), 0);
}

export function parseInboxDueDate(value: string): string | null {
  const date = value.trim();
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Enter a due date as YYYY-MM-DD, or leave it blank.");
  if (date < "1900-01-01") throw new Error("Choose a due date on or after 1900-01-01.");
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("Enter a real calendar date, or leave the due date blank.");
  return date;
}

export function inboxDueLabel(value: string | null, now = new Date()): string {
  if (!value) return "No due date";
  const today = now.toISOString().slice(0, 10);
  if (value === today) return "Due today";
  const date = new Date(`${value}T12:00:00.000Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${value < today ? "Overdue" : "Due"} · ${date}`;
}

/** A due date before today (UTC): the one the label calls "Overdue". */
export function inboxOverdue(value: string | null, now = new Date()): boolean {
  return !!value && value < now.toISOString().slice(0, 10);
}

/** Retain the id after an uncertain send, but never reuse it for an edited draft. */
/** One sentence for the team: will this person be told that we replied? A server from before reply emails sends none. */
export function inboxReplyEmailLine(notify: InboxNotify | undefined): string {
  if (!notify?.available) return "This server does not send email. They see a reply when they come back to the page.";
  if (notify.state === "on" && notify.email) return `Emailed at ${notify.email} when the team replies.`;
  if (notify.state === "pending" && notify.email) return `Has not confirmed ${notify.email} yet, so no email when the team replies.`;
  return "No email when the team replies. They see a reply when they come back to the page.";
}

/** The contact address is self-reported until the visitor confirms that same address with a code. */
export function inboxContactConfirmed(email: string, notify: InboxNotify | undefined): boolean {
  return !!email.trim() && notify?.state === "on" && notify.email === email.trim().toLowerCase();
}

export function createInboxDraftId(makeId: () => string) {
  let id: string | null = null;
  return { current: () => id ??= makeId(), reset: () => { id = null; } };
}

type InboxRequest = (path: string, init?: RequestInit) => Promise<{ json: () => Promise<any> }>;
export function createInboxClient(request: InboxRequest) {
  const base = (id: string) => `/v1/inbox/${encodeURIComponent(id)}`;
  const json = async <T>(path: string, init: RequestInit = {}): Promise<T> => (await request(path, init)).json();
  const body = (method: string, value: unknown, signal?: AbortSignal): RequestInit => ({ method, body: JSON.stringify(value), signal });
  const uploadBody = (text: string, attachments: readonly InboxUpload[], requestId: string) => {
    validateInboxFiles(attachments);
    return { text, attachments: attachments.map(({ name, data }) => ({ name, data })), requestId };
  };
  const download = async (path: string, signal?: AbortSignal) => {
    const { file } = await json<{ file: InboxFile & { data: string } }>(path, { signal });
    if (!file || typeof file.data !== "string" || file.data.length > Math.ceil(INBOX_FILE_LIMIT / 3) * 4 || file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error("Couldn't download this file. Try again.");
    return { ...file, mime: "application/octet-stream" };
  };
  return {
    create: (fields: { name: string; email: string; subject: string }, requestId: string, signal?: AbortSignal) => json<{ conversation: InboxConversation }>("/v1/inbox", body("POST", { ...fields, requestId }, signal)),
    visitorLink: (id: string, signal?: AbortSignal) => json<{ url: string | null }>(`${base(id)}/visitor-link`, body("POST", {}, signal)),
    list: (status: InboxFilter, query: string, signal?: AbortSignal, offset = 0, scope: InboxScope = "all") => json<InboxListPage>(`/v1/inbox?status=${status}&q=${encodeURIComponent(query.trim())}&offset=${offset}&scope=${scope}`, { signal }),
    page: (id: string, after = 0, signal?: AbortSignal) => json<InboxPage>(`${base(id)}?after=${after}`, { signal }),
    send: (id: string, text: string, attachments: readonly InboxUpload[], requestId: string, signal?: AbortSignal) => {
      return json<{ message: InboxMessage }>(`${base(id)}/messages`, body("POST", uploadBody(text, attachments, requestId), signal));
    },
    read: (id: string, through: number, signal?: AbortSignal) => json(`${base(id)}/read`, body("POST", { through }, signal)),
    update: (id: string, patch: { status?: InboxStatus; assigneeId?: string | null }, signal?: AbortSignal) => json<{ conversation: InboxConversation }>(base(id), body("PATCH", patch, signal)),
    file: (id: string, fileId: string, signal?: AbortSignal) => download(`${base(id)}/files/${encodeURIComponent(fileId)}`, signal),
    case: (id: string, signal?: AbortSignal) => json<InboxCase>(`${base(id)}/case`, { signal }),
    notes: (id: string, after = 0, signal?: AbortSignal) => json<{ notes: InboxNote[]; hasMore: boolean }>(`${base(id)}/notes?after=${after}`, { signal }),
    addNote: (id: string, text: string, attachments: readonly InboxUpload[], requestId: string, signal?: AbortSignal) => json<{ note: InboxNote }>(`${base(id)}/notes`, body("POST", uploadBody(text, attachments, requestId), signal)),
    noteFile: (id: string, fileId: string, signal?: AbortSignal) => download(`${base(id)}/notes/files/${encodeURIComponent(fileId)}`, signal),
    addTask: (id: string, task: { text: string; assigneeId: string | null; dueDate: string | null }, requestId: string, signal?: AbortSignal) => json<{ task: InboxTask }>(`${base(id)}/tasks`, body("POST", { ...task, requestId }, signal)),
    updateTask: (id: string, taskId: string, patch: InboxTaskPatch, requestId: string, signal?: AbortSignal) => json<{ task: InboxTask }>(`${base(id)}/tasks/${encodeURIComponent(taskId)}`, body("PATCH", { ...patch, requestId }, signal)),
    activity: (id: string, after = 0, signal?: AbortSignal) => json<{ activity: InboxActivity[]; hasMore: boolean }>(`${base(id)}/activity?after=${after}`, { signal }),
  };
}

export type InboxClient = ReturnType<typeof createInboxClient>;

/** Capture the audience once. A Team draft never inherits a public send endpoint on a tab change. */
export function createInboxLane(client: InboxClient, id: string, audience: InboxAudience) {
  return audience === "team" ? {
    async page(after: number, signal?: AbortSignal) { const page = await client.notes(id, after, signal); return { items: page.notes, hasMore: page.hasMore }; },
    send: (text: string, files: readonly InboxUpload[], requestId: string, signal?: AbortSignal) => client.addNote(id, text, files, requestId, signal),
    file: (fileId: string, signal?: AbortSignal) => client.noteFile(id, fileId, signal),
    read: async (_through: number, _signal?: AbortSignal) => {},
  } : {
    async page(after: number, signal?: AbortSignal) { const page = await client.page(id, after, signal); return { items: page.messages, hasMore: page.hasMore }; },
    send: (text: string, files: readonly InboxUpload[], requestId: string, signal?: AbortSignal) => client.send(id, text, files, requestId, signal),
    file: (fileId: string, signal?: AbortSignal) => client.file(id, fileId, signal),
    read: (through: number, signal?: AbortSignal) => client.read(id, through, signal),
  };
}

/** A slow request finishes before another begins; leaving the screen aborts it. */
export function pollInbox(task: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void, interval = 3000) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try { await task(controller.signal); }
    catch (error) { if (!controller.signal.aborted) onError(error); }
    if (!controller.signal.aborted) timer = setTimeout(() => { void run(); }, interval);
  };
  void run();
  return () => { controller.abort(); clearTimeout(timer); };
}
