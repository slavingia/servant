import type { ChatHistory, ChatMember } from "./chat-members";
import { termsAcceptance, type TermsAcceptance } from "./terms";
import { piiFlags, type PiiChoice } from "./pii-warning";
import { Platform } from "react-native";
import { secureFetch, type SecureResponse } from "./secure-fetch";
import { validServerKey } from "./tunnel-crypto";
import { getItem, removeItem, setItem } from "./storage";
import type { Invite } from "./invite";
import { createLiveEventDecoder } from "./live-events";
import { createAgentEventDecoder, type StreamEvent } from "./agent-events";
import { parseAgentTurn, type AgentTurn } from './agent-turns';
import { isDesktop } from './desktop';
import { createAccountsStore, createLegacyAccountsStore, accountId, type Account, type AccountStorage } from './accounts-store';
import type { SourceDevice } from './message-device';
import { normalizeFeatures } from './features.ts';
import { deepWorkFromServer } from './deep-work.ts';
import { bannerFromServer } from './banner.ts';
import { normalizeTheme } from './theme-colors.ts';
import { noteSessionExpired } from './session-expiry';
import { SESSION_EXPIRED, type SessionInfo } from './session-expiry-rules';
import type { ConnectPart, ConnectTool, ConnectionStanding, ConnectionsPage } from "./connections.ts";
export { accountId } from './accounts-store';
export type { Account, Accounts } from './accounts-store';
export type { SessionInfo } from './session-expiry-rules';
export type { StreamEvent } from "./agent-events";

export type Role = "owner" | "member";
// shared: the author chose to let the rest of the server read it (off when a chat starts). author/readOnly: someone else's chat.
export type ChatLastMessage = { role: "user" | "assistant"; text: string; at: number; attachments: number; pending?: boolean };
export type PrototypeChanges = { edits: { from: string; to: string }[]; styles: { selector: string; css: Record<string, string> }[] };
export type ProjectLevel = "read" | "write" | "merge";
export type ProjectPerson = { key: string; id?: string; name: string; github?: string; level: ProjectLevel; owner: boolean };
// A body of work the team shares (docs/projects.md). access: your level (null for an admin who isn't listed);
// canEdit: you own it or are an admin; canWrite: you may change its notes and files.
export type Project = { id: string; name: string; description: string; notes: string; repo: string; path: string; pages: string; workflow: "main" | "pr"; rules: string[]; files: { id: string; name: string; size: number }[]; people: ProjectPerson[]; access: ProjectLevel | null; canEdit: boolean; canWrite: boolean; chatCount: number; sharedCount: number; stages: string[]; releases: ProjectRelease[]; reviewers?: Record<string, Reviewer[]>; createdAt?: number; updatedAt?: number };
// Who reviews a stage on every feature (Design: jo-park). A cell with no owner of its own is theirs to tick.
export type Reviewer = { key: string; id?: string; name: string; github?: string };
// Releases: a project's dated drops. Every item (a feature) goes through the project's stages, and each
// stage of each item has a status and an owner: that cell is one person's to-do.
export type StageStatus = "todo" | "doing" | "done" | "blocked";
export type StageCell = { status: StageStatus; owner: string | null; ownerName: string; note?: string };
// A feature can carry its own parts (sub-checkboxes). It's checked (done) when every stage is done and every part is ticked.
export type ReleasePart = { id: string; title: string; done: boolean };
export type ReleaseItem = { id: string; title: string; stages: Record<string, StageCell>; done?: boolean; parts?: ReleasePart[] };
// To-dos (server/todos.mjs): next steps with a project, a release and a channel tag, that the agent can work on.
export type TodoItem = {
  id: string; text: string; status: "open" | "done"; position: number;
  assignee: { id?: string; name: string } | null;
  projectId: string | null; projectName: string | null; releaseId: string | null; releaseName: string | null;
  channelId: string | null; channelName: string | null;
  source: { kind: string; id: string; title: string } | null;
  chatId: string | null; withAgent: boolean;
  createdBy: string; createdByName: string; createdAt: number; updatedAt: number; doneAt: number | null; doneBy: string | null;
  canEdit: boolean;
  // The board: its column, its own due date, and the date it is due (its own, or its release's when it has none).
  stage?: TodoStage; dueDate?: string | null; due?: string | null; dueFrom?: "own" | "release" | null;
  // The tracker: a key ("EA-42": the project's initials and a number that never changes), a kind, a priority, an
  // estimate in points, a longer description, the epic it belongs to, and its issue's key in Jira once it has one.
  number?: number; key?: string; type?: TodoType; priority?: TodoPriority | null; estimate?: number | null; description?: string;
  parentId?: string | null; parentText?: string | null; jiraKey?: string | null; commentCount?: number;
};
export type TodoType = "task" | "bug" | "story" | "epic";
export type TodoPriority = "high" | "medium" | "low";
export type TodoComment = { id: string; text: string; createdAt: number; author: { id: string; name: string } };
export type TodoStage = "todo" | "doing" | "done";
export type TodoPatch = { text?: string; status?: "open" | "done"; stage?: TodoStage; dueDate?: string | null;
  type?: TodoType; priority?: TodoPriority | null; estimate?: number | string | null; description?: string; parentId?: string | null; jiraKey?: string | null; assigneeName?: string; assigneeId?: string; projectId?: string | null; releaseId?: string | null; channelId?: string | null };
// ready: every feature is checked, so the final box opens. shipped: someone ticked that box.
export type ProjectRelease = { id: string; name: string; date: string; items: ReleaseItem[]; ready?: boolean; shipped?: { at: number; by: string | null; byName: string } | null };
// mode "vibe": a vibe-coding chat that builds a prototype with a preview link.
export type Chat = { usage?: { input: number; output: number; total: number; turns: number }; projectId?: string; projectShared?: boolean; project?: { id: string; name: string }; mode?: "vibe"; previewUrl?: string; files?: boolean; id: string; title: string; titledBy?: "user" | "agent"; createdAt: number; updatedAt: number; lastMessage?: ChatLastMessage | null; unread?: number; shared?: boolean; author?: { id: string; name: string }; readOnly?: boolean; archived?: boolean; latestTurn?: AgentTurn | null; members?: ChatMember[] };
export type Reaction = { emoji: string; userIds: string[] };
export type Message = { /** The form the agent asked for, to connect a tool of your own (docs/connections.md). */ connect?: ConnectPart[]; id: string; role: "user" | "assistant"; text: string; reactions?: Reaction[]; at?: number | string | null; attachments?: Attachment[]; pending?: boolean; interrupted?: boolean; sourceDevice?: SourceDevice; postedBy?: { id: string; name: string } };

// ----- token leaderboard -----
export type LeaderboardPeriod = "day" | "week" | "month" | "all";
export type LeaderboardRow = { rank: number; user: { id: string; name: string }; input: number; output: number; total: number; turns: number; chat: number; channel: number };
export type Leaderboard = { period: LeaderboardPeriod; since: number; totals: { input: number; output: number; total: number; turns: number }; people: LeaderboardRow[] };


// ----- channels, direct messages, threads -----
// deepWork: they switched Deep work on (deep-work.ts); absent while off.
export type Presence = { userId: string; online: boolean; lastSeenAt: number | null; deepWork?: boolean };
// photo: version of their profile photo, when they have one.
export type Person = { /** Who decides this person's entitlement requests; owners have none. */ managerId?: string; email?: string | null; emailVerified?: boolean; agentTier?: number; tokenLimit?: number; vibeCoder?: boolean; unlimitedTokens?: boolean; id: string; name: string; agent?: boolean; owner?: boolean; online?: boolean; lastSeenAt?: number | null; deepWork?: boolean; photo?: string | null };
export type EntitlementStanding = { entitlementId: string; userId: string; status: "requested" | "granted" | "once" | "used" | "denied" | "revoked"; note: string; requestedAt: number; /** "use": the agent asked by trying; `detail` is what it was about to do. */ via?: "use"; detail?: string; decidedBy?: string; decidedAt?: number; reason?: string; name?: string; decidedByName?: string };
export type Entitlement = { /** Built in: on every server, asked for by use. */ native?: boolean; capability?: string; id: string; name: string; description: string; hosts: string[]; confirmation: string; mine: EntitlementStanding | null; people: EntitlementStanding[] };
export type AgentAction = { seq: number; userId: string; name: string; chatId?: string; needs: string[]; verdict: "allowed" | "allowed-once" | "allowed-owner" | "denied" | "waiting"; detail: string; at: number };
export type PrototypeComment = { id: string; page: string; /** Where on the page, as a share of its width and height. */ x?: number; y?: number; anchor: string; text: string; createdAt: number; todoId?: string };
export type PrototypeShare = { id: string; email: string; createdAt: number; verifiedAt?: number; lastSeenAt?: number; endedAt?: number; comments: PrototypeComment[] };
export type EntitlementDraft = { name: string; description: string; hosts: string[]; confirmation: string };
export type EntitlementsPage = { /** Whether built-in entitlements are checked before the agent acts. */ capabilities?: { mode: "ask" | "off" }; entitlements: Entitlement[]; canCreate: boolean; waiting: number; manager: { id: string; name: string } | null; reports: { id: string; name: string }[];
  egress: { mode: "ask" | "off"; always?: string[]; refused?: { userId: string; name: string; host: string; attempts: number; lastAt: number }[]; /** What agents did reach: per person (or the agent itself), host and day. */ reached?: { userId: string; name: string; host: string; day: string; connections: number; lastAt: number }[] } };
// width, height: a picture's size in pixels as it is shown, read by the server when the file was stored. Absent
// for a file from before the server kept sizes and for one that is not a picture (lib/picture-box.ts).
export type Attachment = { id: string; name: string; mime: string; size: number; width?: number; height?: number };
// Documents skip base64: `document` points at the local file until it's
// uploaded in chunks, then `upload` names the server copy.
export type LocalDocument = { uri: string; size: number; blob?: Blob };
// width, height: a picture's size when the app already knows it (the photo library says, or the app shrank it).
export type Upload = { name: string; data: string; document?: LocalDocument; upload?: string; width?: number; height?: number };
export type Post = {
  sourceDevice?: SourceDevice;
  readBy?: { userId: string; readAt: number }[];
  reactions?: { emoji: string; userIds: string[] }[];
  attachments?: Attachment[];
  /** The first linked page's own title and description, read once by the server when the message was posted. */
  preview?: LinkPreview;
  activity?: "joined" | "left" | "todo";
  /** One-tap replies the agent offers under its message. */
  suggestions?: string[];
  id: string;
  conversationId: string;
  user: Person;
  threadRoot: string | null;
  /** A thread reply its author also sent to the conversation, and the first message it answers. */
  alsoInChannel?: boolean;
  replyTo?: { user: string; text: string };
  text: string;
  deleted: boolean;
  pending: boolean;
  /** Only on this device: shown the moment Send was pressed, before the server has answered (outbox.ts). */
  sending?: boolean;
  replyCount: number;
  lastReplyAt: number | null;
  createdAt: number;
  editedAt: number | null;
};
/** A private checklist reference. Unavailable sources have no message or conversation details. */
export type SavedMessage = {
  messageId: string;
  savedAt: number;
  completedAt: number | null;
  message: Post | null;
  conversation: { id: string; kind: "channel" | "dm"; name: string } | null;
};
/** Authored work notes and completion times survive reopening or removing a saved task. */
export type SavedCompletion = SavedMessage & { id: string; completedAt: number; note: string; reopenedAt: number | null };
/** Private activity history with current, access-checked sources. Recording times are when the upload finished. */
export type WorkLogEntry =
  | { kind: "saved"; id: string; at: number; completion: SavedCompletion }
  | { kind: "recording"; id: string; at: number; recordingId: string; durationMs: number | null;
      source: { title: string | null; summary: string | null } | null }
  | { kind: "todo"; id: string; at: number; todoId: string; createdAt: number; reopenedAt: number | null; originKind: "recording" | "call" | null;
      // From the board, as they were when it was finished: when work began, and the day it was due (YYYY-MM-DD).
      startedAt?: number | null; due?: string | null;
      completedBy: { kind: "agent" | "person" | "unknown"; id?: string; name?: string };
      source: { text: string; projectId: string | null; projectName: string | null; releaseId: string | null; releaseName: string | null; channelId: string | null; channelName: string | null } | null };
// A voice memo (server/recordings.mjs): private to the person who made it.
export type RecordingStep = { n: number; text: string; owner: string | null; status: "open" | "accepted" | "skipped"; chatId: string | null };
export type RecordingSummary = {
  id: string; title: string | null; status: "uploading" | "processing" | "done" | "failed"; createdAt: number; durationMs: number;
  summary: string | null; error: string | null; openSteps: number;
};
export type Recording = {
  id: string; title: string | null; status: "uploading" | "processing" | "done" | "failed"; createdAt: number; durationMs: number;
  summary: string | null; error: string | null; openSteps: number; notes: string[]; transcript: string; steps: RecordingStep[]; todos?: TodoItem[];
};
export type LinkPreview = { url: string; title: string; description: string; site: string };
export type Conversation = {
  id: string;
  kind: "channel" | "dm";
  name: string | null;
  title: string;
  topic: string;
  private: boolean;
  createdBy: string;
  archived: boolean;
  /** You muted it (like Slack): it stays in your list, greyed, adds nothing to your badges, and only @mentions of you and your threads alert you. */
  muted?: boolean;
  /** Where this person dragged the channel; null until they sort by hand. */
  position?: number | null;
  memberCount: number;
  members?: Person[];
  unread: number;
  /** How far you have read here, as a message id: the "New" line goes above the first message after it (unread-line.ts). Absent on an older server, and for a channel you are only previewing. */
  readThrough?: string;
  /** The person's own private conversation with the agent. */
  agentDm?: boolean;
  lastMessage: Post | null;
  updatedAt: number;
};
export type BrowseChannel = { id: string; name: string; topic: string; memberCount: number };
export type SearchChannel = BrowseChannel & { archived: boolean; joined: boolean; private: boolean };
export type SearchMessage = {
  sourceDevice?: SourceDevice;
  id: string;
  conversationId: string;
  conversationTitle: string;
  conversationKind: "channel" | "dm";
  threadRoot: string | null;
  text: string;
  user: Person;
  createdAt: number;
};
/** `more`: there are more matching messages than the page that came back (absent on an older server). */
export type SearchResults = { channels: SearchChannel[]; people: Person[]; messages: SearchMessage[]; more?: boolean };
export type LiveEvent =
  | { event: "message.created" | "message.updated"; data: Post }
  | { event: "conversation.updated" | "conversation.read"; data: { id: string } }
  | { event: "messages.read"; data: { conversationId: string; userId: string; messageIds: string[]; readAt: number } }
  | { event: "presence.updated"; data: Presence }
  | { event: "person.updated"; data: Person }
  | { event: "typing"; data: { conversationId: string; threadRoot: string | null; user: Person } }
  | { event: "code.requested"; data: { requestId: string } }
  | { event: "ready"; data: { cursor?: string; reset?: boolean } }
  | { event: "checkpoint"; data: { cursor: string } };

export class ServerError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "network",
    /** Extra fields the server put beside code and message (for example `existing` on name_taken). */
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const supportsMultipleServers = !(isDesktop() && window.servantDesktop?.storage?.version !== 2);
const accountStorage: AccountStorage = { getItem, setItem, removeItem };
if (Platform.OS === "web" && typeof window !== "undefined" && !isDesktop()) {
  accountStorage.transaction = work => {
    if (!navigator.locks?.request) return Promise.reject(new Error("This browser cannot safely save server accounts. Update your browser and use HTTPS."));
    return navigator.locks.request("servant.accounts", work);
  };
  accountStorage.subscribe = listener => {
    const changed = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === null || event.key === "servant.accounts" || event.key === "servant.account" || event.key.startsWith("servant.account."))) listener();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  };
}
const accountsStore = (supportsMultipleServers ? createAccountsStore : createLegacyAccountsStore)(accountStorage);
export const loadAccounts = accountsStore.load;
export const subscribeAccounts = accountsStore.subscribe;
export async function loadAccount(): Promise<Account | null> {
  const saved = await loadAccounts();
  return saved.accounts.find(a => accountId(a) === saved.activeId) ?? null;
}
/** Updates only a retained account. It never changes the active server. */
export const saveAccount = async (account: Account) => { await accountsStore.update(account); };
export const addAccount = async (account: Account) => { await accountsStore.add(account); };
export const saveAccountIfCurrent = accountsStore.add;
export const activateAccount = accountsStore.activate;
export const removeAccount = accountsStore.remove;

const trim = (u: string) => u.replace(/\/+$/, "");

// The tunnel address changes when the server restarts; the discovery file always
// has the current one.
export async function discover(discovery: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${discovery}${discovery.includes("?") ? "&" : "?"}t=${Date.now()}`, { signal });
  if (!res.ok) throw new ServerError("Couldn't find the server", res.status);
  const data = await res.json();
  if (typeof data.url !== "string" || !/^https?:\/\//.test(data.url)) throw new ServerError("Couldn't find the server");
  return trim(data.url);
}

async function readError(res: SecureResponse, identity?: string): Promise<ServerError> {
  try {
    const body = await res.json();
    if (body?.error?.message) {
      const { code, message, ...details } = body.error as { code?: string; message: string } & Record<string, unknown>;
      // The session ended (sessionMaxHours on the server): hold the app on the confirm screen, keep the account.
      if (code === SESSION_EXPIRED && identity) noteSessionExpired(details.maxHours, identity);
      return new ServerError(message, res.status, code, details);
    }
  } catch {
    /* not JSON (for example a tunnel error page) */
  }
  if (res.status === 530 || res.status === 502 || res.status === 503 || res.status === 404) {
    return new ServerError("The server isn't reachable right now", res.status, "unreachable");
  }
  return new ServerError(`Something went wrong (${res.status})`, res.status, "http");
}

export function deviceLabel() {
  return isDesktop() ? "Mac" : Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android phone" : "Browser";
}

export type SignInLinkStatus = { status: "live" | "used" | "expired"; createdAt: number; expiresAt: number; usedAt?: number; device?: string };

// Email code sign-in: `emailChallenge` comes from sendEmailCode, `emailCode` is what the person typed.
export type EmailProof = { challenge: string; code: string };
export async function sendEmailCode(invite: Invite, email: string): Promise<{ challenge: string; email: string }> {
  if (!validServerKey(invite.serverKey)) throw new ServerError("This invite needs an encryption key. Ask your admin for a new invite.", 0, "encryption_required");
  const serverUrl = invite.discovery ? await discover(invite.discovery) : trim(invite.server!);
  let res: SecureResponse;
  try {
    res = await secureFetch(serverUrl, invite.serverKey, "/v1/pair/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: invite.code, email }),
    });
  } catch {
    throw new ServerError("The server isn't reachable right now");
  }
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function pair(invite: Invite, name?: string, terms: TermsAcceptance = termsAcceptance(), email?: EmailProof): Promise<Account> {
  if (!validServerKey(invite.serverKey)) throw new ServerError("This invite needs an encryption key. Ask your admin for a new invite.", 0, "encryption_required");
  const serverUrl = invite.discovery ? await discover(invite.discovery) : trim(invite.server!);
  let res: SecureResponse;
  try {
    res = await secureFetch(serverUrl, invite.serverKey, "/v1/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: invite.code, device: deviceLabel(), terms, ...(name ? { name } : {}), ...(email ? { emailChallenge: email.challenge, emailCode: email.code } : {}) }),
    });
  } catch {
    throw new ServerError("The server isn't reachable right now");
  }
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  const account: Account = { token: data.token, serverUrl, serverKey: invite.serverKey, discovery: invite.discovery, serverName: data.server?.name || data.hub?.name || "Server", user: data.user, banner: bannerFromServer(data.banner), theme: normalizeTheme(data.theme), features: normalizeFeatures(data.features), deepWork: deepWorkFromServer(data.deepWork) };
  await addAccount(account);
  return account;
}

// The quick tunnel's address changes when the server restarts. Returns the account
// pointed at the current address (saved), or null if it hasn't moved.
export async function relocate(account: Account, signal?: AbortSignal): Promise<Account | null> {
  if (!account.discovery) return null;
  try {
    const fresh = await discover(account.discovery, signal);
    if (fresh === account.serverUrl) return null;
    const moved = { ...account, serverUrl: fresh };
    await saveAccount(moved);
    return moved;
  } catch {
    return null;
  }
}

// A request that re-discovers the server once if the tunnel moved.
export async function request(account: Account, path: string, init: RequestInit = {}, onMove?: (a: Account) => void): Promise<SecureResponse> {
  if (!validServerKey(account.serverKey)) throw new ServerError("Encryption setup required. Open a new invite from your admin.", 0, "encryption_required");
  const go = (base: string) =>
    secureFetch(base, account.serverKey, path, {
      ...init,
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
  let res: SecureResponse | null = null;
  try {
    res = await go(account.serverUrl);
  } catch {
    res = null;
  }
  if (init.signal?.aborted) throw new ServerError("Request cancelled");
  const looksMoved = !res || res.status === 530 || res.status === 1033 || (res.status === 404 && !(res.headers.get("content-type") || "").includes("json"));
  const moved = looksMoved ? await relocate(account, init.signal ?? undefined) : null;
  if (moved) {
    account = moved;
    onMove?.(moved);
    res = await go(moved.serverUrl).catch(() => null);
  }
  if (!res) throw new ServerError("The server isn't reachable right now");
  if (!res.ok) throw await readError(res, `${accountId(account)}:${account.token}`);
  return res;
}

// Sends a message and yields the agent's reply as it streams in.
export async function sendMessage(
  account: Account,
  chatId: string,
  text: string,
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
  onMove?: (a: Account) => void,
  attachments: Upload[] = [],
  requestId?: string,
  forward?: string,
  confirmPii: PiiChoice = false,
): Promise<void> {
  if (!validServerKey(account.serverKey)) throw new ServerError("Encryption setup required. Open a new invite from your admin.", 0, "encryption_required");
  const go = (base: string) =>
    secureFetch(base, account.serverKey, `/v1/chats/${chatId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ text, attachments: attachments.map(({ name, data, upload, width, height }) => upload ? { name, upload } : { name, data, ...(width && height ? { width, height } : {}) }), requestId, ...(forward ? { forward } : {}), ...piiFlags(confirmPii) }),
      signal,
    });
  let res = await go(account.serverUrl).catch(() => null);
  if (!res || res.status === 530) {
    const moved = await relocate(account);
    if (moved) {
      onMove?.(moved);
      res = await go(moved.serverUrl);
    }
  }
  if (!res) throw new ServerError("The server isn't reachable right now");
  if (!res.ok) throw await readError(res as SecureResponse, `${accountId(account)}:${account.token}`);
  if (!res.body) throw new ServerError("The agent didn't answer");
  const reader = res.body.getReader();
  const decoder = createAgentEventDecoder(onEvent);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { decoder.finish(); return; }
      if (value) decoder.push(value);
    }
  } finally { await reader.cancel(); }
}

// Opens the server's live event stream. Resolves when the stream ends; throws on
// connection errors so the caller can back off and reconnect.
export async function listen(account: Account, onEvent: (e: LiveEvent) => void, signal: AbortSignal,
  resume: { cursor?: string; onCursor?: (cursor: string | undefined) => void } = {},
): Promise<void> {
  // POST, not GET: Cloudflare's quick tunnel holds streamed GET responses until they end.
  const decoder = createLiveEventDecoder(frame => onEvent(frame as LiveEvent), resume);
  const route = `/v1/events${resume.cursor === undefined ? "" : `?after=${encodeURIComponent(resume.cursor)}`}`;
  const res = await secureFetch(account.serverUrl, account.serverKey, route, {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.token}`, Accept: "text/event-stream" },
    signal,
  });
  if (!res.ok) throw await readError(res as SecureResponse, `${accountId(account)}:${account.token}`);
  if (!res.body) throw new ServerError("No live updates");
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { decoder.finish(); return; }
      if (value) decoder.push(value);
    }
  } finally { await reader.cancel(); }
}

const json = <T,>(r: SecureResponse) => r.json() as Promise<T>;
// A one-time code an automation signed in as you is waiting for (server: code-requests.mjs). Never holds the code.
export type CodeRequest = { id: string; label: string; hint?: string; length?: number; device: string; status: "pending" | "answered" | "claimed" | "cancelled" | "expired"; createdAt: number; expiresAt: number };

// A build's notes, posted in #whats-new. Testers discuss it in the post's thread.
export type Release = { build: string; conversationId: string; messageId: string; text: string; createdAt: number };

export type FeedbackReport = { id: string; text: string; status: string; result: string | null; createdAt: number; screenshots?: number };

/** POST helper for chunked document uploads: JSON in, JSON out, ServerError on failure. */
export const uploadPost = (account: Account, onMove?: (a: Account) => void) => (path: string, body: unknown) =>
  request(account, path, { method: "POST", body: JSON.stringify(body) }, onMove).then(r => r.json());

export const api = {
  todos: (a: Account, query: { project?: string; release?: string; source?: string; status?: "open" | "done" | "all"; mine?: boolean; epic?: string } = {}) => {
    const q = new URLSearchParams();
    if (query.project) q.set("project", query.project);
    if (query.release) q.set("release", query.release);
    if (query.source) q.set("source", query.source);
    if (query.status) q.set("status", query.status);
    if (query.mine) q.set("mine", "1");
    if (query.epic) q.set("epic", query.epic);
    return request(a, `/v1/todos${q.toString() ? `?${q}` : ""}`).then(json<{ todos: TodoItem[] }>);
  },
  addTodo: (a: Account, body: TodoPatch & { text: string }) => request(a, "/v1/todos", { method: "POST", body: JSON.stringify(body) }).then(json<{ todo: TodoItem }>),
  todo: (a: Account, id: string) => request(a, `/v1/todos/${encodeURIComponent(id)}`).then(json<{ todo: TodoItem }>),
  updateTodo: (a: Account, id: string, patch: TodoPatch) => request(a, `/v1/todos/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }).then(json<{ todo: TodoItem }>),
  todoComments: (a: Account, id: string) => request(a, `/v1/todos/${encodeURIComponent(id)}/comments`).then(json<{ comments: TodoComment[] }>),
  addTodoComment: (a: Account, id: string, text: string) => request(a, `/v1/todos/${encodeURIComponent(id)}/comments`, { method: "POST", body: JSON.stringify({ text }) }).then(json<{ comment: TodoComment }>),
  deleteTodo: (a: Account, id: string) => request(a, `/v1/todos/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json<{ ok: true }>),
  reorderTodos: (a: Account, ids: string[]) => request(a, "/v1/todos/reorder", { method: "POST", body: JSON.stringify({ ids }) }).then(json<{ todos: TodoItem[] }>),
  bulkTodos: (a: Account, ids: string[], patch: TodoPatch) => request(a, "/v1/todos/bulk", { method: "POST", body: JSON.stringify({ ids, patch }) }).then(json<{ todos: TodoItem[] }>),
  sendTodoToAgent: (a: Account, id: string) => request(a, `/v1/todos/${encodeURIComponent(id)}/agent`, { method: "POST", body: "{}" }).then(json<{ todo: TodoItem; chatId: string | null; started: boolean }>),
  search: (a: Account, query: string, signal?: AbortSignal) =>
    request(a, `/v1/search?q=${encodeURIComponent(query)}`, { signal }).then(json<SearchResults>),
  feedback: (a: Account) => request(a, "/v1/feedback").then(json<{ reports: FeedbackReport[] }>).then(d => d.reports),
  sendFeedback: (a: Account, body: { text: string; requestId: string; context: Record<string, string>; attachments?: { name: string; data: string }[] }) =>
    request(a, "/v1/feedback", { method: "POST", body: JSON.stringify(body) }).then(json<{ report: FeedbackReport }>).then(d => d.report),
  retryFeedback: (a: Account, id: string) => request(a, `/v1/feedback/${id}/retry`, { method: "POST", body: "{}" }),
  me: (a: Account, m?: (a: Account) => void) => request(a, "/v1/me", {}, m).then((r) => r.json()),
  chats: (a: Account, m?: (a: Account) => void) => request(a, "/v1/chats", {}, m).then((r) => r.json()).then((d) => d.chats as Chat[]),
  // Your chats plus other people's shared ones (all of them, for the owner).
  orgChats: (a: Account, m?: (a: Account) => void) => request(a, "/v1/chats?scope=org", {}, m).then((r) => r.json()).then((d) => ({ mine: d.chats as Chat[], others: (d.orgChats ?? []) as Chat[] })),
  leaderboard: (a: Account, period: LeaderboardPeriod) => request(a, `/v1/leaderboard?period=${period}`).then((r) => r.json()) as Promise<Leaderboard>,
  // The author has seen every finished reply in this agent conversation.
  // Mark every conversation read: yours and everyone else's you can see.
  readAllChats: (a: Account) => request(a, "/v1/chats/read-all", { method: "POST", body: "{}" }).then(() => undefined),
  readChat: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/read`, { method: "POST", body: "{}" }).then(() => undefined),
  chat: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}`).then((r) => r.json()).then((d) => d.chat as Chat),
  // Share a prototype with a business owner by work email; they confirm a code, see it and comment (docs/prototype-reviews.md).
  prototypeShares: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/prototype/shares`).then(json<{ shares: PrototypeShare[] }>),
  sharePrototype: (a: Account, id: string, email: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/prototype/shares`, { method: "POST", body: JSON.stringify({ email }) }).then(json<{ shares: PrototypeShare[] }>),
  endPrototypeShare: (a: Account, id: string, shareId: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/prototype/shares/${encodeURIComponent(shareId)}`, { method: "DELETE" }).then(json<{ shares: PrototypeShare[] }>),
  // Edit mode in the prototype preview: save the changed page over the prototype's file.
  savePrototype: (a: Account, id: string, path: string, changes: PrototypeChanges) => request(a, `/v1/chats/${encodeURIComponent(id)}/prototype`, { method: "POST", body: JSON.stringify({ path, ...changes }) }).then(json<{ ok: true; path: string; missed: string[] }>),
  setChatShared: (a: Account, id: string, shared: boolean) => request(a, `/v1/chats/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ shared }) }).then((r) => r.json()).then((d) => d.chat as Chat),
  // Projects: shared bodies of work with notes, files, rules and who can read, write or merge (docs/projects.md).
  projects: (a: Account) => request(a, "/v1/projects").then(json<{ projects: Project[]; vibeCoder: boolean; vibe: boolean; vibeProject?: string; vibeLinks?: { primary: string; backup: string } }>),
  project: (a: Account, id: string) => request(a, `/v1/projects/${encodeURIComponent(id)}`).then(json<{ project: Project; sharedChats: Chat[]; appPreview?: { path: string; url: string; builtAt: string | null; commit: string | null } | null }>),
  createProject: (a: Account, body: { name: string; description?: string; notes?: string }) => request(a, "/v1/projects", { method: "POST", body: JSON.stringify(body) }).then(json<{ project: Project }>).then(d => d.project),
  updateProject: (a: Account, id: string, change: Partial<Pick<Project, "name" | "description" | "notes" | "repo" | "path" | "pages" | "workflow" | "rules" | "stages">> & { reviewers?: Record<string, string[]> }) => request(a, `/v1/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(change) }).then(json<{ project: Project }>).then(d => d.project),
  projectReadme: (a: Account, id: string) => request(a, `/v1/projects/${encodeURIComponent(id)}/readme`).then(json<{ readme: { repo: string; name: string; text: string; fetchedAt: number; stale: boolean } | null }>).then(d => d.readme),
  deleteProject: (a: Account, id: string) => request(a, `/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addProjectFile: (a: Account, id: string, name: string, data: string) => request(a, `/v1/projects/${encodeURIComponent(id)}/files`, { method: "POST", body: JSON.stringify({ name, data }) }).then(json<{ project: Project }>).then(d => d.project),
  removeProjectFile: (a: Account, id: string, fileId: string) => request(a, `/v1/projects/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }).then(json<{ project: Project }>).then(d => d.project),
  // who: a Servant person (userId), a GitHub login (github) or someone already listed (key).
  setProjectPerson: (a: Account, id: string, who: { userId?: string; github?: string; key?: string }, level: ProjectLevel, owner?: boolean) => request(a, `/v1/projects/${encodeURIComponent(id)}/people`, { method: "POST", body: JSON.stringify({ ...who, level, ...(owner === undefined ? {} : { owner }) }) }).then(json<{ project: Project }>).then(d => d.project),
  removeProjectPerson: (a: Account, id: string, key: string) => request(a, `/v1/projects/${encodeURIComponent(id)}/people/${encodeURIComponent(key)}`, { method: "DELETE" }).then(json<{ project?: Project }>),
  // Releases (docs/projects.md): every call answers with the whole project again.
  addRelease: (a: Account, id: string, body: { name: string; date: string }) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases`, { method: "POST", body: JSON.stringify(body) }).then(json<{ project: Project }>).then(d => d.project),
  updateRelease: (a: Account, id: string, rid: string, body: { name?: string; date?: string }) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}`, { method: "PATCH", body: JSON.stringify(body) }).then(json<{ project: Project }>).then(d => d.project),
  deleteRelease: (a: Account, id: string, rid: string) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}`, { method: "DELETE" }).then(json<{ project: Project }>).then(d => d.project),
  addReleaseItem: (a: Account, id: string, rid: string, title: string) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}/items`, { method: "POST", body: JSON.stringify({ title }) }).then(json<{ project: Project }>).then(d => d.project),
  updateReleaseItem: (a: Account, id: string, rid: string, iid: string, title: string) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}/items/${encodeURIComponent(iid)}`, { method: "PATCH", body: JSON.stringify({ title }) }).then(json<{ project: Project }>).then(d => d.project),
  deleteReleaseItem: (a: Account, id: string, rid: string, iid: string) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}/items/${encodeURIComponent(iid)}`, { method: "DELETE" }).then(json<{ project: Project }>).then(d => d.project),
  // One stage of one item: status, owner (a user id, or null for nobody) and note. The cell's owner or anyone who can write.
  setReleaseItemDone: (a: Account, id: string, rid: string, iid: string, done: boolean) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}/items/${encodeURIComponent(iid)}`, { method: "PATCH", body: JSON.stringify({ done }) }).then(json<{ project: Project }>).then(d => d.project),
  addReleasePart: (a: Account, id: string, rid: string, iid: string, title: string) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}/items/${encodeURIComponent(iid)}/parts`, { method: "POST", body: JSON.stringify({ title }) }).then(json<{ project: Project }>).then(d => d.project),
  updateReleasePart: (a: Account, id: string, rid: string, iid: string, pid: string, change: { title?: string; done?: boolean }) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}/items/${encodeURIComponent(iid)}/parts/${encodeURIComponent(pid)}`, { method: "PATCH", body: JSON.stringify(change) }).then(json<{ project: Project }>).then(d => d.project),
  deleteReleasePart: (a: Account, id: string, rid: string, iid: string, pid: string) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}/items/${encodeURIComponent(iid)}/parts/${encodeURIComponent(pid)}`, { method: "DELETE" }).then(json<{ project: Project }>).then(d => d.project),
  setReleaseShipped: (a: Account, id: string, rid: string, shipped: boolean) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}`, { method: "PATCH", body: JSON.stringify({ shipped }) }).then(json<{ project: Project }>).then(d => d.project),
  setStageCell: (a: Account, id: string, rid: string, iid: string, change: { stage: string; status?: StageStatus; owner?: string | null; note?: string }) => request(a, `/v1/projects/${encodeURIComponent(id)}/releases/${encodeURIComponent(rid)}/items/${encodeURIComponent(iid)}/stages`, { method: "PATCH", body: JSON.stringify(change) }).then(json<{ project: Project }>).then(d => d.project),
  shareChatWithProject: (a: Account, id: string, projectShared: boolean) => request(a, `/v1/chats/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ projectShared }) }).then((r) => r.json()).then((d) => d.chat as Chat),
  renameChat: (a: Account, id: string, title: string) => request(a, `/v1/chats/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) }).then((r) => r.json()).then((d) => d.chat as Chat),
  moveChat: (a: Account, id: string, projectId: string | null) => request(a, `/v1/chats/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ projectId }) }).then((r) => r.json()).then((d) => d.chat as Chat),
  newChat: (a: Account, options: { projectId?: string | null; mode?: "vibe"; id?: string } = {}) => request(a, "/v1/chats", { method: "POST", body: JSON.stringify(options) }).then((r) => r.json()).then((d) => d.chat as Chat),
  /** Owner only: take someone who left the team off the server. Signs out all their devices. */
  removePerson: (a: Account, userId: string) => request(a, `/v1/people/${encodeURIComponent(userId)}`, { method: "DELETE" }).then(json<{ ok: true }>),
  /** Owner only: one person's daily agent limit (token-limit.ts): a step, their role's default (null), or none. */
  setDailyLimit: (a: Account, userId: string, change: { unlimitedTokens: boolean; tokenLimit?: number | null }) => request(a, `/v1/people/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify(change) }).then(json<{ person: Person }>),
  // Personal connections (docs/connections.md): your own credentials for the tools your agent works with. A value
  // goes up once and is never returned; the app only learns its last four characters.
  connections: (a: Account) => request(a, "/v1/connections").then(json<ConnectionsPage>),
  saveConnection: (a: Account, type: string, values: Record<string, string>) => request(a, `/v1/connections/${encodeURIComponent(type)}`, { method: "PUT", body: JSON.stringify({ values }) }).then(json<{ tool: ConnectTool & { mine: ConnectionStanding | null }; replaced: boolean; checked: boolean }>),
  removeConnection: (a: Account, type: string) => request(a, `/v1/connections/${encodeURIComponent(type)}`, { method: "DELETE" }).then(json<{ tool: ConnectTool & { mine: ConnectionStanding | null } }>),
  declineConnection: (a: Account, requestId: string) => request(a, `/v1/connections/requests/${encodeURIComponent(requestId)}/decline`, { method: "POST", body: "{}" }).then(json<{ request: { id: string; status: string } }>),
  // Entitlements (docs/entitlements.md): named access people ask for and their manager grants.
  entitlements: (a: Account) => request(a, "/v1/entitlements").then(json<EntitlementsPage>),
  // Owners: what agents did or were stopped from doing, newest first.
  agentActions: (a: Account, limit = 30) => request(a, `/v1/entitlements/actions?limit=${limit}`).then(json<{ actions: AgentAction[] }>),
  createEntitlement: (a: Account, body: EntitlementDraft) => request(a, "/v1/entitlements", { method: "POST", body: JSON.stringify(body) }).then(json<{ entitlement: Entitlement }>),
  updateEntitlement: (a: Account, id: string, body: Partial<EntitlementDraft>) => request(a, `/v1/entitlements/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }).then(json<{ entitlement: Entitlement }>),
  retireEntitlement: (a: Account, id: string) => request(a, `/v1/entitlements/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json<{ ok: true }>),
  askForEntitlement: (a: Account, id: string, note: string) => request(a, `/v1/entitlements/${encodeURIComponent(id)}/request`, { method: "POST", body: JSON.stringify({ confirmed: true, note }) }).then(json<{ entitlement: Entitlement }>),
  decideEntitlement: (a: Account, id: string, userId: string, decision: "grant" | "once" | "deny" | "revoke") => request(a, `/v1/entitlements/${encodeURIComponent(id)}/people/${encodeURIComponent(userId)}`, { method: "POST", body: JSON.stringify({ decision }) }).then(json<{ entitlement: Entitlement }>),
  // The org chart (docs/entitlements.md): an owner or the person's current manager hands them to another manager.
  setManager: (a: Account, userId: string, managerId: string) => request(a, `/v1/people/${encodeURIComponent(userId)}/manager`, { method: "PUT", body: JSON.stringify({ managerId }) }).then(json<{ person: { id: string; name: string; manager: { id: string; name: string } } }>),
  // "Invite your manager": a one-use link; whoever joins with it becomes your manager.
  inviteManager: (a: Account, name: string) => request(a, "/v1/people/me/manager-invite", { method: "POST", body: JSON.stringify({ name }) }).then(json<{ code: string; link: string; webLink?: string; expiresAt: number }>),
  setAgentTier: (a: Account, userId: string, agentTier: number) => request(a, `/v1/people/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ agentTier }) }).then(json<{ person: Person }>),
  setVibeCoder: (a: Account, userId: string, vibeCoder: boolean) => request(a, `/v1/people/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ vibeCoder }) }).then(json<{ person: Person }>),
  // Invite people to read an agent chat, with how much of the past they see; take someone out again.
  addChatMembers: (a: Account, id: string, userIds: string[], history: ChatHistory) => request(a, `/v1/chats/${encodeURIComponent(id)}/members`, { method: "POST", body: JSON.stringify({ userIds, history }) }).then((r) => r.json()).then((d) => d.chat as Chat),
  removeChatMember: (a: Account, id: string, userId: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }).then((r) => r.json()).then((d) => d.chat as Chat),
  deleteChat: (a: Account, id: string) => request(a, `/v1/chats/${id}`, { method: "DELETE" }),
  archiveChat: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
  restoreChat: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/restore`, { method: "POST", body: "{}" }),
  messages: (a: Account, id: string) => request(a, `/v1/chats/${id}/messages`).then((r) => r.json()).then((d) => d.messages as Message[]),
  agentTurns: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/turns`).then(json<{ turns: unknown[] }>).then(d => d.turns.map(parseAgentTurn).filter((t): t is AgentTurn => t !== null)),
  /** One turn with every step it took, for a finished reply's summary when it is opened. */
  agentTurn: (a: Account, chatId: string, turnId: string) => request(a, `/v1/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turnId)}`).then(json<{ turn: unknown }>).then(d => parseAgentTurn(d.turn)),
  steerAgent: (a: Account, chatId: string, turnId: string) => request(a, `/v1/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turnId)}/steer`, { method: 'POST', body: '{}' }),
  stopAgent: (a: Account, chatId: string, turnId: string) => request(a, `/v1/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turnId)}/stop`, { method: 'POST', body: '{}' }),
  answerApproval: (a: Account, chatId: string, turnId: string, approvalId: string, choice: 'once' | 'deny') => request(a, `/v1/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turnId)}/approval`, { method: 'POST', body: JSON.stringify({ approvalId, choice }) }),
  signInLink: (a: Account) =>
    request(a, "/v1/sign-in-links", { method: "POST", body: "{}" }).then(json<{ code: string; link: string; expiresAt: number }>),
  /** The newest sign-in link this person made: live, used (and on what), expired, or null. */
  signInLinkStatus: (a: Account, signal?: AbortSignal) =>
    request(a, "/v1/sign-in-links", { signal }).then(json<{ link: SignInLinkStatus | null }>).then(d => d.link),
  joinLink: (a: Account, fresh = false) =>
    request(a, "/v1/invites", { method: "POST", body: JSON.stringify({ fresh }) }).then(json<{ code: string; link: string; expiresAt: number }>),
  people: (a: Account) => request(a, "/v1/people").then(json<{ people: Person[]; agent: Person; me: string; emailChecks?: boolean; tierTokenLimits?: Record<string, number>; tierCosts?: Record<string, { model: string | null; input: number; output: number; priced: boolean; perMillion: number }> }>),
  photo: (a: Account, userId: string) => request(a, `/v1/people/${encodeURIComponent(userId)}/photo`).then(json<{ mime: string; data: string; version: string }>),
  setPhoto: (a: Account, data: string) => request(a, "/v1/people/me/photo", { method: "PUT", body: JSON.stringify({ data }) }).then(json<{ person: Person }>),
  rename: (a: Account, name: string) => request(a, "/v1/people/me", { method: "PATCH", body: JSON.stringify({ name }) }).then(json<{ user: Account["user"] }>),
  // Your deep work switch (deep-work.ts). Switching off answers with the calls that didn't ring while it was on.
  setDeepWork: (a: Account, deepWork: boolean) => request(a, "/v1/people/me", { method: "PATCH", body: JSON.stringify({ deepWork }) }).then(json<{ user: Account["user"]; deepWork: boolean }>),
  removePhoto: (a: Account) => request(a, "/v1/people/me/photo", { method: "DELETE" }).then(json<{ person: Person }>),
  conversations: (a: Account, m?: (a: Account) => void) =>
    request(a, "/v1/conversations?includeArchived=1", {}, m).then(json<{ conversations: Conversation[] }>).then((d) => d.conversations),
  conversation: (a: Account, id: string) => request(a, `/v1/conversations/${id}`).then(json<{ conversation: Conversation; joined: boolean }>),
  browsePage: (a: Account, after?: string) => request(a, `/v1/channels/browse?limit=20${after ? `&after=${encodeURIComponent(after)}` : ""}`)
    .then(json<{ channels: BrowseChannel[]; nextCursor: string | null }>),
  browse: (a: Account) => request(a, "/v1/channels/browse").then(json<{ channels: BrowseChannel[] }>).then((d) => d.channels),
  createChannel: (a: Account, body: { name: string; topic?: string; private?: boolean; memberIds?: string[] }) =>
    request(a, "/v1/conversations", { method: "POST", body: JSON.stringify(body) }).then(json<{ conversation: Conversation }>).then((d) => d.conversation),
  reactChatMessage: (a: Account, chatId: string, messageId: string, emoji: string, active: boolean) =>
    request(a, `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/reactions`, { method: "POST", body: JSON.stringify({ emoji, active }) })
      .then(json<{ reactions: Reaction[] }>).then((d) => d.reactions),
  forwardChatMessage: (a: Account, chatId: string, messageId: string, body: { conversationId: string; text?: string }) =>
    request(a, `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/forward`, { method: "POST", body: JSON.stringify(body) })
      .then(json<{ conversation: Conversation; message: Post }>),
  openDm: (a: Account, userIds: string[]) =>
    request(a, "/v1/conversations", { method: "POST", body: JSON.stringify({ kind: "dm", userIds }) })
      .then(json<{ conversation: Conversation }>)
      .then((d) => d.conversation),
  updateChannel: (a: Account, id: string, body: { name?: string; topic?: string }) =>
    request(a, `/v1/conversations/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then(json<{ conversation: Conversation }>),
  setChannelOrder: (a: Account, ids: string[]) => request(a, "/v1/conversations/order", { method: "POST", body: JSON.stringify({ ids }) }),
  archiveChannel: (a: Account, id: string) => request(a, `/v1/conversations/${id}/archive`, { method: "POST", body: "{}" }),
  muteConversation: (a: Account, id: string, muted: boolean) => request(a, `/v1/conversations/${id}/${muted ? "mute" : "unmute"}`, { method: "POST", body: "{}" }),
  restoreChannel: (a: Account, id: string) => request(a, `/v1/conversations/${id}/restore`, { method: "POST", body: "{}" }),
  deleteChannel: (a: Account, id: string) => request(a, `/v1/conversations/${id}`, { method: "DELETE" }),
  join: (a: Account, id: string) => request(a, `/v1/conversations/${id}/join`, { method: "POST", body: "{}" }),
  leave: (a: Account, id: string) => request(a, `/v1/conversations/${id}/leave`, { method: "POST", body: "{}" }),
  addMembers: (a: Account, id: string, userIds: string[]) =>
    request(a, `/v1/conversations/${id}/members`, { method: "POST", body: JSON.stringify({ userIds }) }),
  typing: (a: Account, id: string, threadRoot?: string) =>
    request(a, `/v1/conversations/${id}/typing`, { method: "POST", body: JSON.stringify({ threadRoot }) }).catch(() => undefined),
  markRead: (a: Account, id: string, seq?: string) =>
    request(a, `/v1/conversations/${id}/read`, { method: "POST", body: JSON.stringify({ seq: seq ? Number(seq) : undefined }) }).catch(() => undefined),
  markMessagesRead: async (a: Account, id: string, messageIds: string[]) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      return await request(a, `/v1/conversations/${id}/read`, { method: "POST", body: JSON.stringify({ messageIds }), signal: controller.signal });
    } finally { clearTimeout(timeout); }
  },
  emailRequired: (a: Account) => request(a, "/v1/me").then(json<{ emailRequired?: boolean }>).then(d => d.emailRequired === true),
  // Sessions that end (server: session-expiry.mjs): a code to the email on file, then this same device is fresh again.
  codeRequests: (a: Account) => request(a, "/v1/code-requests").then(json<{ requests: CodeRequest[] }>),
  codeRequest: (a: Account, id: string) => request(a, `/v1/code-requests/${encodeURIComponent(id)}`).then(json<{ request: CodeRequest }>),
  answerCodeRequest: (a: Account, id: string, code: string) => request(a, `/v1/code-requests/${encodeURIComponent(id)}/answer`, { method: "POST", body: JSON.stringify({ code }) }).then(json<{ request: CodeRequest }>),
  cancelCodeRequest: (a: Account, id: string) => request(a, `/v1/code-requests/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }).then(json<{ request: CodeRequest }>),
  sessionEmail: (a: Account) => request(a, "/v1/session/email", { method: "POST", body: "{}" }).then(json<{ challenge: string; email: string; expiresInSeconds: number; resendAfterSeconds: number }>),
  sessionVerify: (a: Account, challenge: string, code: string) => request(a, "/v1/session/verify", { method: "POST", body: JSON.stringify({ challenge, code }) }).then(json<{ ok: boolean; session: SessionInfo | null }>),
  sendMyEmailCode: (a: Account, email: string) => request(a, "/v1/people/me/email", { method: "POST", body: JSON.stringify({ email }) }).then(json<{ challenge: string; email: string }>),
  confirmMyEmail: (a: Account, challenge: string, code: string) => request(a, "/v1/people/me/email/confirm", { method: "POST", body: JSON.stringify({ challenge, code }) }).then(json<{ ok: boolean; email: string }>),
  presence: (a: Account, sessionId: string, active: boolean, signal?: AbortSignal) =>
    request(a, "/v1/presence", { method: "POST", body: JSON.stringify({ sessionId, active }), signal }),
  posts: (a: Account, id: string, before?: string) =>
    request(a, `/v1/conversations/${id}/messages${before ? `?before=${before}` : ""}`).then(json<{ messages: Post[]; more: boolean }>),
  thread: (a: Account, id: string, root: string) => request(a, `/v1/conversations/${id}/threads/${root}`).then(json<{ root: Post; replies: Post[] }>),
  post: (a: Account, id: string, text: string, threadRoot?: string, attachments: Upload[] = [], confirmPii: PiiChoice = false, alsoInChannel = false) =>
    request(a, `/v1/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text, threadRoot, attachments, ...(threadRoot && alsoInChannel ? { alsoInChannel: true } : {}), ...piiFlags(confirmPii) }) })
      .then(json<{ message: Post }>)
      .then((d) => d.message),
  editPost: (a: Account, postId: string, text: string) =>
    request(a, `/v1/messages/${postId}`, { method: "PATCH", body: JSON.stringify({ text }) }).then(json<{ message: Post }>).then((d) => d.message),
  reactToPost: (a: Account, postId: string, emoji: string, active: boolean) =>
    request(a, `/v1/messages/${postId}/reactions`, { method: "POST", body: JSON.stringify({ emoji, active }) }).then(json<{ message: Post }>).then((d) => d.message),
  deletePost: (a: Account, postId: string) => request(a, `/v1/messages/${postId}`, { method: "DELETE" }),
  savedMessages: (a: Account) => request(a, "/v1/saved-messages").then(json<{ items: SavedMessage[]; history: SavedCompletion[] }>),
  workLog: (a: Account) => request(a, "/v1/work-log").then(json<{ items: WorkLogEntry[] }>),
  savedMessage: (a: Account, messageId: string) => request(a, `/v1/saved-messages/${encodeURIComponent(messageId)}`).then(json<{ item: SavedMessage | null }>),
  saveMessage: (a: Account, messageId: string) => request(a, `/v1/saved-messages/${encodeURIComponent(messageId)}`, { method: "POST", body: "{}" }).then(json<{ item: SavedMessage }>),
  completeSavedMessage: (a: Account, messageId: string, completed: boolean, completion?: { note: string; requestId: string }) => request(a, `/v1/saved-messages/${encodeURIComponent(messageId)}`, { method: "PATCH", body: JSON.stringify({ completed, ...(completed ? completion : {}) }) }).then(json<{ item: SavedMessage | null }>),
  removeSavedMessage: (a: Account, messageId: string) => request(a, `/v1/saved-messages/${encodeURIComponent(messageId)}`, { method: "DELETE" }).then(json<{ ok: true }>),
  airdropFolder: (a: Account) => request(a, "/v1/airdrop").then(json<{ folder: string }>).then(d => d.folder),
  recordings: (a: Account, m?: (a: Account) => void) => request(a, "/v1/recordings", {}, m).then(json<{ recordings: RecordingSummary[] }>).then(d => d.recordings),
  recording: (a: Account, id: string) => request(a, `/v1/recordings/${encodeURIComponent(id)}`).then(json<{ recording: Recording }>).then(d => d.recording),
  retryRecording: (a: Account, id: string) => request(a, `/v1/recordings/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" }).then(json<{ recording: Recording }>).then(d => d.recording),
  deleteRecording: (a: Account, id: string) => request(a, `/v1/recordings/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json<{ ok: true }>),
  recordingStep: (a: Account, id: string, n: number, action: "send" | "skip") =>
    request(a, `/v1/recordings/${encodeURIComponent(id)}/steps/${n}`, { method: "POST", body: JSON.stringify({ action }) }).then(json<{ recording: Recording }>).then(d => d.recording),
  latestRelease: (a: Account) =>
    request(a, "/v1/releases/latest").then(json<{ release: Release | null }>).then((d) => d.release),
  signOut: async (a: Account) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try { await request(a, "/v1/signout", { method: "POST", signal: controller.signal }); }
    catch { /* Always permit local sign-out when this server is offline. */ }
    finally { clearTimeout(timeout); }
  },
};
