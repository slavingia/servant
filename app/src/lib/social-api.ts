import { request, type Account } from "./server";
import type { SocialCounts, SocialFilter, SocialHome, SocialPost, SocialReply, SocialSource } from "./social";

const json = <T,>(response: { json(): Promise<unknown> }) => response.json() as Promise<T>;
const send = (method: string, body: unknown = {}) => ({ method, body: JSON.stringify(body) });
const post = (id: string) => `/v1/social/posts/${encodeURIComponent(id)}`;
const reply = (id: string) => `/v1/social/replies/${encodeURIComponent(id)}`;

export const socialApi = {
  home: (account: Account, signal?: AbortSignal) => request(account, "/v1/social", { signal }).then(json<SocialHome>),
  posts: (account: Account, query: { filter: SocialFilter; source: SocialSource; before?: string }, signal?: AbortSignal) =>
    request(account, `/v1/social/posts?filter=${query.filter}&source=${query.source}${query.before ? `&before=${encodeURIComponent(query.before)}` : ""}`, { signal }).then(json<{ posts: SocialPost[]; hasMore: boolean }>),
  schedule: (account: Account, range: { from: number; to: number }, signal?: AbortSignal) =>
    request(account, `/v1/social/schedule?from=${range.from}&to=${range.to}`, { signal }).then(json<{ replies: SocialReply[] }>),
  /** Look at X now. */
  sync: (account: Account) => request(account, "/v1/social/sync", send("POST")).then(json<{ added: number; error: string | null; counts: SocialCounts }>),
  /** Agent's reply to a post, from the guide. `instruction` asks for a change to the draft that is there. */
  draft: (account: Account, postId: string, instruction?: string) => request(account, `${post(postId)}/draft`, send("POST", instruction ? { instruction } : {})).then(json<{ post: SocialPost }>),
  write: (account: Account, postId: string, text: string) => request(account, `${post(postId)}/reply`, send("PUT", { text })).then(json<{ post: SocialPost }>),
  skip: (account: Account, postId: string) => request(account, `${post(postId)}/skip`, send("POST")).then(json<{ post: SocialPost }>),
  restore: (account: Account, postId: string) => request(account, `${post(postId)}/restore`, send("POST")).then(json<{ post: SocialPost }>),
  /** A post of the team's own: from a note for Agent to write up, or the words themselves. */
  compose: (account: Account, body: { note: string } | { text: string }) => request(account, "/v1/social/replies", send("POST", body)).then(json<{ reply: SocialReply }>),
  edit: (account: Account, replyId: string, text: string) => request(account, reply(replyId), send("PUT", { text })).then(json<{ reply: SocialReply }>),
  /** Approve: at the next opening, or at a time. Needs the Social media entitlement. */
  approve: (account: Account, replyId: string, at?: number) => request(account, `${reply(replyId)}/approve`, send("POST", at ? { at } : {})).then(json<{ reply: SocialReply }>),
  cancel: (account: Account, replyId: string) => request(account, `${reply(replyId)}/cancel`, send("POST")).then(json<{ reply: SocialReply }>),
  discard: (account: Account, replyId: string) => request(account, `${reply(replyId)}/discard`, send("POST")).then(json<{ reply: SocialReply; post: SocialPost | null }>),
};
