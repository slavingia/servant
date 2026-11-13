import { router } from "expo-router";
import { api, type Account, type Conversation, type Post } from "./server";

// "Ask the agent" on a channel or DM message: a new agent chat with the message
// attached. Chats always start private; the person can share one afterwards, except
// when it quotes a DM or private channel, which stays private.
export async function askAgentAbout(account: Account, post: Post, conversation: Conversation | null | undefined) {
  const where = conversation?.kind === "channel" ? `#${conversation.title}` : "a direct message";
  const chat = await api.newChat(account, {});
  router.push({ pathname: "/chat/[id]", params: {
    id: chat.id, title: chat.title, compose: "1",
    forward: post.id, forwardAuthor: post.user.name, forwardWhere: where,
    forwardText: post.text.slice(0, 600), forwardFiles: String(post.attachments?.length ?? 0),
  } });
}
