import { router } from "expo-router";
import { api, type Account, type Conversation, type Post } from "./server";

// "Ask the agent" on a channel or DM message: a new agent chat with the message
// attached. DMs and private channels start a private chat so they never show
// up for the rest of the server.
export async function askAgentAbout(account: Account, post: Post, conversation: Conversation | null | undefined) {
  const privateSource = !conversation || conversation.kind !== "channel" || conversation.private;
  const where = conversation?.kind === "channel" ? `#${conversation.title}` : "a direct message";
  const chat = await api.newChat(account, { shared: !privateSource });
  router.push({ pathname: "/chat/[id]", params: {
    id: chat.id, title: chat.title,
    forward: post.id, forwardAuthor: post.user.name, forwardWhere: where,
    forwardText: post.text.slice(0, 600), forwardFiles: String(post.attachments?.length ?? 0),
  } });
}
