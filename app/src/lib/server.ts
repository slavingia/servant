import { Platform } from "react-native";
import { secureFetch, type SecureResponse } from "./secure-fetch";
import { validServerKey } from "./tunnel-crypto";
import { getItem, removeItem, setItem } from "./storage";
import type { Invite } from "./invite";
import { createLiveEventDecoder } from "./live-events";
import { createAgentEventDecoder, type StreamEvent } from "./agent-events";
import { parseAgentTurn, type AgentTurn } from './agent-turns';
import { isDesktop } from './desktop';
import { createAccountWrites } from './account-writes';
import type { SourceDevice } from './message-device';
export type { StreamEvent } from "./agent-events";

export type Role = "owner" | "member";
export type Account = {
  token: string;
  serverUrl: string;
  serverKey?: string;
  discovery?: string;
  serverName: string;
  user: { id: string; name: string; role: Role };
};
// shared: visible read-only to the rest of the server (default). author/readOnly: someone else's chat.
export type ChatLastMessage = { role: "user" | "assistant"; text: string; at: number; attachments: number; pending?: boolean };
export type Chat = { id: string; title: string; createdAt: number; updatedAt: number; lastMessage?: ChatLastMessage | null; unread?: number; shared?: boolean; author?: { id: string; name: string }; readOnly?: boolean; archived?: boolean; latestTurn?: AgentTurn | null };
export type Message = { id: string; role: "user" | "assistant"; text: string; at?: number | string | null; attachments?: Attachment[]; pending?: boolean; interrupted?: boolean; sourceDevice?: SourceDevice };

// ----- token leaderboard -----
export type LeaderboardPeriod = "day" | "week" | "month" | "all";
export type LeaderboardRow = { rank: number; user: { id: string; name: string }; input: number; output: number; total: number; turns: number; chat: number; channel: number };
export type Leaderboard = { period: LeaderboardPeriod; since: number; totals: { input: number; output: number; total: number; turns: number }; people: LeaderboardRow[] };

// ----- channels, direct messages, threads -----
export type Presence = { userId: string; online: boolean; lastSeenAt: number | null };
// photo: version of their profile photo, when they have one.
export type Person = { id: string; name: string; agent?: boolean; owner?: boolean; online?: boolean; lastSeenAt?: number | null; photo?: string | null };
export type Attachment = { id: string; name: string; mime: string; size: number };
export type Upload = { name: string; data: string };
export type Post = {
  sourceDevice?: SourceDevice;
  readBy?: { userId: string; readAt: number }[];
  reactions?: { emoji: string; userIds: string[] }[];
  attachments?: Attachment[];
  activity?: "joined" | "left";
  id: string;
  conversationId: string;
  user: Person;
  threadRoot: string | null;
  text: string;
  deleted: boolean;
  pending: boolean;
  replyCount: number;
  lastReplyAt: number | null;
  createdAt: number;
  editedAt: number | null;
};
export type Conversation = {
  id: string;
  kind: "channel" | "dm";
  name: string | null;
  title: string;
  topic: string;
  private: boolean;
  createdBy: string;
  archived: boolean;
  /** Where this person dragged the channel; null until they sort by hand. */
  position?: number | null;
  memberCount: number;
  members?: Person[];
  unread: number;
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
export type SearchResults = { channels: SearchChannel[]; people: Person[]; messages: SearchMessage[] };
export type LiveEvent =
  | { event: "message.created" | "message.updated"; data: Post }
  | { event: "conversation.updated" | "conversation.read"; data: { id: string } }
  | { event: "messages.read"; data: { conversationId: string; userId: string; messageIds: string[]; readAt: number } }
  | { event: "presence.updated"; data: Presence }
  | { event: "person.updated"; data: Person }
  | { event: "typing"; data: { conversationId: string; threadRoot: string | null; user: Person } }
  | { event: "ready"; data: { cursor?: string; reset?: boolean } }
  | { event: "checkpoint"; data: { cursor: string } };

const KEY = "servant.account";

export class ServerError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "network",
  ) {
    super(message);
  }
}

export async function loadAccount(): Promise<Account | null> {
  const raw = await getItem(KEY);
  if (!raw) return null;
  try {
    // Accounts saved before the hub → server rename used hubUrl / hubName.
    const saved = JSON.parse(raw) as Account & { hubUrl?: string; hubName?: string };
    const { hubUrl, hubName, ...rest } = saved;
    return { ...rest, serverUrl: rest.serverUrl ?? hubUrl ?? "", serverName: rest.serverName ?? hubName ?? "Server" };
  } catch {
    return null;
  }
}

const accountWrites = createAccountWrites({
  read: () => getItem(KEY), write: value => setItem(KEY, value), remove: () => removeItem(KEY),
});
export const saveAccount = async (a: Account) => { await accountWrites.save(JSON.stringify(a)); };
export const saveAccountIfCurrent = (a: Account, current: () => boolean) => accountWrites.save(JSON.stringify(a), current);
export const clearAccount = accountWrites.clear;

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

async function readError(res: SecureResponse): Promise<ServerError> {
  try {
    const body = await res.json();
    if (body?.error?.message) return new ServerError(body.error.message, res.status, body.error.code);
  } catch {
    /* not JSON (for example a tunnel error page) */
  }
  if (res.status === 530 || res.status === 502 || res.status === 503 || res.status === 404) {
    return new ServerError("The server isn't reachable right now", res.status, "unreachable");
  }
  return new ServerError(`Something went wrong (${res.status})`, res.status, "http");
}

function deviceLabel() {
  return isDesktop() ? "Mac" : Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android phone" : "Browser";
}

export async function pair(invite: Invite, name?: string): Promise<Account> {
  if (!validServerKey(invite.serverKey)) throw new ServerError("This invite needs an encryption key. Ask your admin for a new invite.", 0, "encryption_required");
  const serverUrl = invite.discovery ? await discover(invite.discovery) : trim(invite.server!);
  let res: SecureResponse;
  try {
    res = await secureFetch(serverUrl, invite.serverKey, "/v1/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: invite.code, device: deviceLabel(), ...(name ? { name } : {}) }),
    });
  } catch {
    throw new ServerError("The server isn't reachable right now");
  }
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  const account: Account = { token: data.token, serverUrl, serverKey: invite.serverKey, discovery: invite.discovery, serverName: data.server?.name || data.hub?.name || "Server", user: data.user };
  await saveAccount(account);
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
  if (!res.ok) throw await readError(res);
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
): Promise<void> {
  if (!validServerKey(account.serverKey)) throw new ServerError("Encryption setup required. Open a new invite from your admin.", 0, "encryption_required");
  const go = (base: string) =>
    secureFetch(base, account.serverKey, `/v1/chats/${chatId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ text, attachments: attachments.map(({ name, data }) => ({ name, data })), requestId, ...(forward ? { forward } : {}) }),
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
  if (!res.ok) throw await readError(res as SecureResponse);
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
  if (!res.ok) throw await readError(res as SecureResponse);
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

// A build's notes, posted in #whats-new. Testers discuss it in the post's thread.
export type Release = { build: string; conversationId: string; messageId: string; text: string; createdAt: number };

export type FeedbackReport = { id: string; text: string; status: string; result: string | null; createdAt: number; screenshots?: number };

export const api = {
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
  readChat: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/read`, { method: "POST", body: "{}" }).then(() => undefined),
  chat: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}`).then((r) => r.json()).then((d) => d.chat as Chat),
  setChatShared: (a: Account, id: string, shared: boolean) => request(a, `/v1/chats/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ shared }) }).then((r) => r.json()).then((d) => d.chat as Chat),
  newChat: (a: Account, options: { shared?: boolean } = {}) => request(a, "/v1/chats", { method: "POST", body: JSON.stringify(options) }).then((r) => r.json()).then((d) => d.chat as Chat),
  deleteChat: (a: Account, id: string) => request(a, `/v1/chats/${id}`, { method: "DELETE" }),
  archiveChat: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
  restoreChat: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/restore`, { method: "POST", body: "{}" }),
  messages: (a: Account, id: string) => request(a, `/v1/chats/${id}/messages`).then((r) => r.json()).then((d) => d.messages as Message[]),
  agentTurns: (a: Account, id: string) => request(a, `/v1/chats/${encodeURIComponent(id)}/turns`).then(json<{ turns: unknown[] }>).then(d => d.turns.map(parseAgentTurn).filter((t): t is AgentTurn => t !== null)),
  steerAgent: (a: Account, chatId: string, turnId: string) => request(a, `/v1/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turnId)}/steer`, { method: 'POST', body: '{}' }),
  stopAgent: (a: Account, chatId: string, turnId: string) => request(a, `/v1/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turnId)}/stop`, { method: 'POST', body: '{}' }),
  answerApproval: (a: Account, chatId: string, turnId: string, approvalId: string, choice: 'once' | 'deny') => request(a, `/v1/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turnId)}/approval`, { method: 'POST', body: JSON.stringify({ approvalId, choice }) }),
  joinLink: (a: Account, fresh = false) =>
    request(a, "/v1/invites", { method: "POST", body: JSON.stringify({ fresh }) }).then(json<{ code: string; link: string; expiresAt: number }>),
  people: (a: Account) => request(a, "/v1/people").then(json<{ people: Person[]; agent: Person; me: string }>),
  photo: (a: Account, userId: string) => request(a, `/v1/people/${encodeURIComponent(userId)}/photo`).then(json<{ mime: string; data: string; version: string }>),
  setPhoto: (a: Account, data: string) => request(a, "/v1/people/me/photo", { method: "PUT", body: JSON.stringify({ data }) }).then(json<{ person: Person }>),
  removePhoto: (a: Account) => request(a, "/v1/people/me/photo", { method: "DELETE" }).then(json<{ person: Person }>),
  conversations: (a: Account, m?: (a: Account) => void) =>
    request(a, "/v1/conversations?includeArchived=1", {}, m).then(json<{ conversations: Conversation[] }>).then((d) => d.conversations),
  conversation: (a: Account, id: string) => request(a, `/v1/conversations/${id}`).then(json<{ conversation: Conversation; joined: boolean }>),
  browsePage: (a: Account, after?: string) => request(a, `/v1/channels/browse?limit=20${after ? `&after=${encodeURIComponent(after)}` : ""}`)
    .then(json<{ channels: BrowseChannel[]; nextCursor: string | null }>),
  browse: (a: Account) => request(a, "/v1/channels/browse").then(json<{ channels: BrowseChannel[] }>).then((d) => d.channels),
  createChannel: (a: Account, body: { name: string; topic?: string; private?: boolean; memberIds?: string[] }) =>
    request(a, "/v1/conversations", { method: "POST", body: JSON.stringify(body) }).then(json<{ conversation: Conversation }>).then((d) => d.conversation),
  openDm: (a: Account, userIds: string[]) =>
    request(a, "/v1/conversations", { method: "POST", body: JSON.stringify({ kind: "dm", userIds }) })
      .then(json<{ conversation: Conversation }>)
      .then((d) => d.conversation),
  updateChannel: (a: Account, id: string, body: { name?: string; topic?: string }) =>
    request(a, `/v1/conversations/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then(json<{ conversation: Conversation }>),
  setChannelOrder: (a: Account, ids: string[]) => request(a, "/v1/conversations/order", { method: "POST", body: JSON.stringify({ ids }) }),
  archiveChannel: (a: Account, id: string) => request(a, `/v1/conversations/${id}/archive`, { method: "POST", body: "{}" }),
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
  presence: (a: Account, sessionId: string, active: boolean, signal?: AbortSignal) =>
    request(a, "/v1/presence", { method: "POST", body: JSON.stringify({ sessionId, active }), signal }),
  posts: (a: Account, id: string, before?: string) =>
    request(a, `/v1/conversations/${id}/messages${before ? `?before=${before}` : ""}`).then(json<{ messages: Post[]; more: boolean }>),
  thread: (a: Account, id: string, root: string) => request(a, `/v1/conversations/${id}/threads/${root}`).then(json<{ root: Post; replies: Post[] }>),
  post: (a: Account, id: string, text: string, threadRoot?: string, attachments: Upload[] = []) =>
    request(a, `/v1/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text, threadRoot, attachments }) })
      .then(json<{ message: Post }>)
      .then((d) => d.message),
  editPost: (a: Account, postId: string, text: string) =>
    request(a, `/v1/messages/${postId}`, { method: "PATCH", body: JSON.stringify({ text }) }).then(json<{ message: Post }>).then((d) => d.message),
  reactToPost: (a: Account, postId: string, emoji: string, active: boolean) =>
    request(a, `/v1/messages/${postId}/reactions`, { method: "POST", body: JSON.stringify({ emoji, active }) }).then(json<{ message: Post }>).then((d) => d.message),
  deletePost: (a: Account, postId: string) => request(a, `/v1/messages/${postId}`, { method: "DELETE" }),
  latestRelease: (a: Account) =>
    request(a, "/v1/releases/latest").then(json<{ release: Release | null }>).then((d) => d.release),
  signOut: (a: Account) => request(a, "/v1/signout", { method: "POST" }).catch(() => undefined),
};
