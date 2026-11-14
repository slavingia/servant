// What a message looks like right after you act on it, before the server has answered: a reaction
// or a delete shows at once and is confirmed by the server's copy. If the server refuses (for a
// delete that includes records preservation failing to keep its copy), the message goes back to
// what it was and the error says why.
import type { Post } from "./server";

/** `post` with one person's reaction added or taken away. The same post when that changes nothing. */
export function withReaction(post: Post, emoji: string, userId: string, active: boolean): Post {
  const reactions = post.reactions ?? [];
  const existing = reactions.find(reaction => reaction.emoji === emoji);
  if (active === !!existing?.userIds.includes(userId)) return post;
  if (active) {
    return { ...post, reactions: existing
      ? reactions.map(reaction => reaction === existing ? { ...reaction, userIds: [...reaction.userIds, userId] } : reaction)
      : [...reactions, { emoji, userIds: [userId] }] };
  }
  return { ...post, reactions: reactions
    .map(reaction => reaction === existing ? { ...reaction, userIds: reaction.userIds.filter(id => id !== userId) } : reaction)
    .filter(reaction => reaction.userIds.length > 0) };
}

/** `post` as everyone sees it once it is deleted. */
export const asDeleted = (post: Post): Post => ({ ...post, deleted: true, text: "", attachments: [], reactions: [] });

/** The list with `shown` put in the place of the message with its id. */
export const showChange = (posts: Post[] | null, shown: Post): Post[] | null => posts?.map(post => post.id === shown.id ? shown : post) ?? posts;

/**
 * The server refused: put `original` back, but only where the list still shows the change we made.
 * If the server's own copy has arrived since (a live update, a reload), that copy is the truth and stays.
 */
export const undoChange = (posts: Post[] | null, shown: Post, original: Post): Post[] | null => posts?.map(post => post === shown ? original : post) ?? posts;
