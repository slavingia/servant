// An agent chat you have opened is kept in memory (lib/screen-cache.ts), so going back to it shows its
// messages at once while a fresh copy loads behind them. Opening a chat also asks for everything it needs
// in one go (whose chat it is, its messages and the agent's turns), started when its row is pressed, so the
// screen never waits for one answer before asking the next.
import { accountId, api, ServerError, type Account, type Chat, type Message } from "./server";
import type { AgentTurn } from "./agent-turns";
import { createEarlyRequests, createScreenCache } from "./screen-cache";

export type ChatSnapshot = { info: Chat | null; messages: Message[]; turns: AgentTurn[] };
export type ChatLoad = { info: Promise<Chat>; messages: Promise<Message[]>; turns: Promise<AgentTurn[]> };

const kept = createScreenCache<ChatSnapshot>(30);
const early = createEarlyRequests<ChatLoad>();
const key = (account: Account, id: string) => `${accountId(account)}:${account.token}:${id}`;

/** A chat's turns. A chat that has never had one (or an older server) answers 404: that is no turns, not an error. */
export const chatTurns = (account: Account, id: string): Promise<AgentTurn[]> => api.agentTurns(account, id).catch(e => {
  if (e instanceof ServerError && e.status === 404) return [];
  throw e;
});

/** Everything a chat's screen needs, asked for at once. Someone else's chat has no turns to follow. */
function fetchChat(account: Account, id: string, readOnly: boolean): ChatLoad {
  const load = { info: api.chat(account, id), messages: api.messages(account, id), turns: readOnly ? Promise.resolve([]) : chatTurns(account, id) };
  // The screen may never open, or may use only part of it; whoever awaits a part sees that part's failure.
  load.info.catch(() => {}); load.messages.catch(() => {}); load.turns.catch(() => {});
  return load;
}

export const keptChat = (account: Account, id: string) => kept.get(key(account, id));
export const keepChat = (account: Account, id: string, snapshot: ChatSnapshot) => kept.set(key(account, id), snapshot);
export const forgetChat = (account: Account, id: string) => kept.delete(key(account, id));

/** Call when a chat's row is pressed, before navigating: its requests leave now. */
export function openingChat(account: Account, id: string, readOnly = false) {
  early.start(key(account, id), 0, () => fetchChat(account, id, readOnly));
}
/** The requests for a chat that is opening: the ones started at the press, or started now. Left for the screen to take. */
export function chatLoad(account: Account, id: string, readOnly = false): ChatLoad {
  openingChat(account, id, readOnly);
  return early.peek(key(account, id))!.result;
}
/** The requests for a chat that is opening, if any were started, left for the screen to take. */
export const peekChatLoad = (account: Account, id: string): ChatLoad | null => early.peek(key(account, id))?.result ?? null;
/** The same requests, once: the screen's first load uses them, later reloads ask again. */
export const takeChatLoad = (account: Account, id: string): ChatLoad | null => early.take(key(account, id))?.result ?? null;
