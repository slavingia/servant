import { Platform } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { getItem, removeItem, setItem } from "./storage";
import type { Invite } from "./invite";

export type Role = "owner" | "member";
export type Account = {
  token: string;
  hubUrl: string;
  discovery?: string;
  hubName: string;
  user: { id: string; name: string; role: Role };
};
export type Chat = { id: string; title: string; createdAt: number; updatedAt: number };
export type Message = { id: string; role: "user" | "assistant"; text: string; at?: number | string | null };

// ----- channels, direct messages, threads -----
export type Person = { id: string; name: string; agent?: boolean; owner?: boolean };
export type Post = {
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
  memberCount: number;
  members?: Person[];
  unread: number;
  lastMessage: Post | null;
  updatedAt: number;
};
export type BrowseChannel = { id: string; name: string; topic: string; memberCount: number };
export type LiveEvent =
  | { event: "message.created" | "message.updated"; data: Post }
  | { event: "conversation.updated" | "conversation.read"; data: { id: string } }
  | { event: "ready"; data: Record<string, never> };

const KEY = "servant.account";

export class HubError extends Error {
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
    return JSON.parse(raw) as Account;
  } catch {
    return null;
  }
}

export const saveAccount = (a: Account) => setItem(KEY, JSON.stringify(a));
export const clearAccount = () => removeItem(KEY);

const trim = (u: string) => u.replace(/\/+$/, "");

// The tunnel address changes when the hub restarts; the discovery file always
// has the current one.
export async function discover(discovery: string): Promise<string> {
  const res = await fetch(`${discovery}${discovery.includes("?") ? "&" : "?"}t=${Date.now()}`);
  if (!res.ok) throw new HubError("Couldn't find the hub", res.status);
  const data = await res.json();
  if (typeof data.url !== "string" || !/^https?:\/\//.test(data.url)) throw new HubError("Couldn't find the hub");
  return trim(data.url);
}

async function readError(res: Response): Promise<HubError> {
  try {
    const body = await res.json();
    if (body?.error?.message) return new HubError(body.error.message, res.status, body.error.code);
  } catch {
    /* not JSON (for example a tunnel error page) */
  }
  if (res.status === 530 || res.status === 502 || res.status === 503 || res.status === 404) {
    return new HubError("The hub isn't reachable right now", res.status, "unreachable");
  }
  return new HubError(`Something went wrong (${res.status})`, res.status, "http");
}

function deviceLabel() {
  return Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android phone" : "Browser";
}

export async function pair(invite: Invite, name?: string): Promise<Account> {
  const hubUrl = invite.discovery ? await discover(invite.discovery) : trim(invite.hub!);
  let res: Response;
  try {
    res = await fetch(`${hubUrl}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: invite.code, device: deviceLabel(), ...(name ? { name } : {}) }),
    });
  } catch {
    throw new HubError("The hub isn't reachable right now");
  }
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  const account: Account = { token: data.token, hubUrl, discovery: invite.discovery, hubName: data.hub?.name || "Hub", user: data.user };
  await saveAccount(account);
  return account;
}

// The quick tunnel's address changes when the hub restarts. Returns the account
// pointed at the current address (saved), or null if it hasn't moved.
export async function relocate(account: Account): Promise<Account | null> {
  if (!account.discovery) return null;
  try {
    const fresh = await discover(account.discovery);
    if (fresh === account.hubUrl) return null;
    const moved = { ...account, hubUrl: fresh };
    await saveAccount(moved);
    return moved;
  } catch {
    return null;
  }
}

// A request that re-discovers the hub once if the tunnel moved.
export async function request(account: Account, path: string, init: RequestInit = {}, onMove?: (a: Account) => void): Promise<Response> {
  const go = (base: string) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
  let res: Response | null = null;
  try {
    res = await go(account.hubUrl);
  } catch {
    res = null;
  }
  const looksMoved = !res || res.status === 530 || res.status === 1033 || (res.status === 404 && !(res.headers.get("content-type") || "").includes("json"));
  const moved = looksMoved ? await relocate(account) : null;
  if (moved) {
    account = moved;
    onMove?.(moved);
    res = await go(moved.hubUrl).catch(() => null);
  }
  if (!res) throw new HubError("The hub isn't reachable right now");
  if (!res.ok) throw await readError(res);
  return res;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "status"; text: string }
  | { type: "message"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

// Sends a message and yields the agent's reply as it streams in.
export async function sendMessage(
  account: Account,
  chatId: string,
  text: string,
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
  onMove?: (a: Account) => void,
): Promise<void> {
  const go = (base: string) =>
    expoFetch(`${base}/v1/chats/${chatId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ text }),
      signal,
    });
  let res = await go(account.hubUrl).catch(() => null);
  if (!res || res.status === 530) {
    const moved = await relocate(account);
    if (moved) {
      onMove?.(moved);
      res = await go(moved.hubUrl);
    }
  }
  if (!res) throw new HubError("The hub isn't reachable right now");
  if (!res.ok) throw await readError(res as unknown as Response);
  if (!res.body) throw new HubError("The agent didn't answer");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finished = false;
  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let name = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let payload: Record<string, string> = {};
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (name === "delta") onEvent({ type: "delta", text: payload.text || "" });
      else if (name === "status") onEvent({ type: "status", text: payload.text || "" });
      else if (name === "message") onEvent({ type: "message", text: payload.text || "" });
      else if (name === "error") onEvent({ type: "error", message: payload.message || "The agent hit a problem" });
      else if (name === "done") {
        onEvent({ type: "done" });
        finished = true;
      }
    }
  }
  if (!finished) onEvent({ type: "done" });
}

// Opens the hub's live event stream. Resolves when the stream ends; throws on
// connection errors so the caller can back off and reconnect.
export async function listen(account: Account, onEvent: (e: LiveEvent) => void, signal: AbortSignal): Promise<void> {
  // POST, not GET: Cloudflare's quick tunnel holds streamed GET responses until they end.
  const res = await expoFetch(`${account.hubUrl}/v1/events`, {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${account.token}`, Accept: "text/event-stream" },
    signal,
  });
  if (!res.ok) throw await readError(res as unknown as Response);
  if (!res.body) throw new HubError("No live updates");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let name = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!name || !data) continue;
      try {
        onEvent({ event: name, data: JSON.parse(data) } as LiveEvent);
      } catch {
        /* ignore malformed event */
      }
    }
  }
}

const json = <T,>(r: Response) => r.json() as Promise<T>;

export const api = {
  me: (a: Account, m?: (a: Account) => void) => request(a, "/v1/me", {}, m).then((r) => r.json()),
  chats: (a: Account, m?: (a: Account) => void) => request(a, "/v1/chats", {}, m).then((r) => r.json()).then((d) => d.chats as Chat[]),
  newChat: (a: Account) => request(a, "/v1/chats", { method: "POST", body: "{}" }).then((r) => r.json()).then((d) => d.chat as Chat),
  deleteChat: (a: Account, id: string) => request(a, `/v1/chats/${id}`, { method: "DELETE" }),
  messages: (a: Account, id: string) => request(a, `/v1/chats/${id}/messages`).then((r) => r.json()).then((d) => d.messages as Message[]),
  joinLink: (a: Account, fresh = false) =>
    request(a, "/v1/invites", { method: "POST", body: JSON.stringify({ fresh }) }).then(json<{ code: string; link: string; expiresAt: number }>),
  people: (a: Account) => request(a, "/v1/people").then(json<{ people: Person[]; agent: Person; me: string }>),
  conversations: (a: Account, m?: (a: Account) => void) =>
    request(a, "/v1/conversations?includeArchived=1", {}, m).then(json<{ conversations: Conversation[] }>).then((d) => d.conversations),
  conversation: (a: Account, id: string) => request(a, `/v1/conversations/${id}`).then(json<{ conversation: Conversation; joined: boolean }>),
  browse: (a: Account) => request(a, "/v1/channels/browse").then(json<{ channels: BrowseChannel[] }>).then((d) => d.channels),
  createChannel: (a: Account, body: { name: string; topic?: string; private?: boolean; memberIds?: string[] }) =>
    request(a, "/v1/conversations", { method: "POST", body: JSON.stringify(body) }).then(json<{ conversation: Conversation }>).then((d) => d.conversation),
  openDm: (a: Account, userIds: string[]) =>
    request(a, "/v1/conversations", { method: "POST", body: JSON.stringify({ kind: "dm", userIds }) })
      .then(json<{ conversation: Conversation }>)
      .then((d) => d.conversation),
  updateChannel: (a: Account, id: string, body: { name?: string; topic?: string }) =>
    request(a, `/v1/conversations/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then(json<{ conversation: Conversation }>),
  archiveChannel: (a: Account, id: string) => request(a, `/v1/conversations/${id}/archive`, { method: "POST", body: "{}" }),
  restoreChannel: (a: Account, id: string) => request(a, `/v1/conversations/${id}/restore`, { method: "POST", body: "{}" }),
  deleteChannel: (a: Account, id: string) => request(a, `/v1/conversations/${id}`, { method: "DELETE" }),
  join: (a: Account, id: string) => request(a, `/v1/conversations/${id}/join`, { method: "POST", body: "{}" }),
  leave: (a: Account, id: string) => request(a, `/v1/conversations/${id}/leave`, { method: "POST", body: "{}" }),
  addMembers: (a: Account, id: string, userIds: string[]) =>
    request(a, `/v1/conversations/${id}/members`, { method: "POST", body: JSON.stringify({ userIds }) }),
  markRead: (a: Account, id: string, seq?: string) =>
    request(a, `/v1/conversations/${id}/read`, { method: "POST", body: JSON.stringify({ seq: seq ? Number(seq) : undefined }) }).catch(() => undefined),
  posts: (a: Account, id: string, before?: string) =>
    request(a, `/v1/conversations/${id}/messages${before ? `?before=${before}` : ""}`).then(json<{ messages: Post[]; more: boolean }>),
  thread: (a: Account, id: string, root: string) => request(a, `/v1/conversations/${id}/threads/${root}`).then(json<{ root: Post; replies: Post[] }>),
  post: (a: Account, id: string, text: string, threadRoot?: string) =>
    request(a, `/v1/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text, threadRoot }) })
      .then(json<{ message: Post }>)
      .then((d) => d.message),
  editPost: (a: Account, postId: string, text: string) =>
    request(a, `/v1/messages/${postId}`, { method: "PATCH", body: JSON.stringify({ text }) }).then(json<{ message: Post }>).then((d) => d.message),
  deletePost: (a: Account, postId: string) => request(a, `/v1/messages/${postId}`, { method: "DELETE" }),
  signOut: (a: Account) => request(a, "/v1/signout", { method: "POST" }).catch(() => undefined),
};
