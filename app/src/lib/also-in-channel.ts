import type { Conversation, Post } from "./server";

// "Also send to #channel": a thread reply its author also sent to the conversation. It is one message: a reply
// in its thread, shown in the conversation as well with a line saying what it answers.

/** Does the conversation's own list show this message? Its own messages, and replies also sent to it. */
export const showsInConversation = (post: Pick<Post, "threadRoot" | "alsoInChannel">) => !post.threadRoot || !!post.alsoInChannel;

/** The thread a message opens: its own, or the one it is a reply in. */
export const threadOf = (post: Pick<Post, "id" | "threadRoot">) => post.threadRoot ?? post.id;

/** The words beside the box under a thread's reply field. */
export const alsoSendLabel = (conversation: Pick<Conversation, "kind" | "name"> | null) =>
  conversation?.kind === "channel" && conversation.name ? `Also send to #${conversation.name}` : "Also send to this chat";

/** What a reply shown in the conversation says it answers. The first message may be gone or have no words. */
export function replyContext(post: Pick<Post, "replyTo">) {
  const { user, text } = post.replyTo ?? { user: "", text: "" };
  if (!user) return "Replied to a thread";
  return text ? `Replied to ${user}: ${text}` : `Replied to ${user}`;
}
