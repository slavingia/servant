// A new agent chat opens the moment it's asked for. The phone names it (cht_…), shows the empty chat
// with its message box at once, and the server makes it behind that (POST /v1/chats with the id).
// Anything the screen asks of the server (messages, turns, sending, files) waits for that first.
import { randomUUID } from "expo-crypto";
import { router } from "expo-router";
import { accountId, api, type Account, type Chat } from "./server";
import { keepChat } from "./chat-cache";

type Making = { options: { projectId?: string | null; mode?: "vibe" }; promise: Promise<Chat> | null };
const making = new Map<string, Making>();
const key = (account: Account, id: string) => `${accountId(account)}:${account.token}:${id}`;

/** A fresh id the server accepts (server.mjs: /^cht_[A-Za-z0-9_-]{8,40}$/). */
export const newChatId = (uuid: () => string = randomUUID) => `cht_${uuid().replace(/-/g, "")}`;

function run(account: Account, id: string, entry: Making): Promise<Chat> {
  if (!entry.promise) {
    entry.promise = api.newChat(account, { ...entry.options, id });
    // Made: nothing waits any more. Failed: the next wait asks again with the same id.
    entry.promise.then(() => making.delete(key(account, id)), () => { entry.promise = null; });
  }
  return entry.promise;
}

/** Starts a new chat and opens it straight away. */
export function openNewChat(account: Account, options: { projectId?: string | null; mode?: "vibe" } = {}, extra: Record<string, string> = {}): string {
  const id = newChatId();
  const entry: Making = { options, promise: null };
  making.set(key(account, id), entry);
  const at = Date.now();
  const info: Chat = { id, title: "New chat", createdAt: at, updatedAt: at, ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.mode ? { mode: options.mode } : {}) };
  keepChat(account, id, { info, messages: [], turns: [] });
  void run(account, id, entry).catch(() => {});
  router.push({ pathname: "/chat/[id]", params: { id, title: "New chat", mine: "1", compose: "1", ...extra } });
  return id;
}

/** Waits until this chat exists on the server (at once for any chat not being made). Retries a failed start. */
export function chatMade(account: Account, id: string): Promise<Chat | null> {
  const entry = making.get(key(account, id));
  return entry ? run(account, id, entry) : Promise.resolve(null);
}

/** Whether this chat is still being made, for things that shouldn't ask the server yet. */
export const chatBeingMade = (account: Account, id: string) => making.has(key(account, id));
