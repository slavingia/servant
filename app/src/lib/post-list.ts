// The messages of a conversation as a list: merged by id and kept in order (ids are increasing numbers).
import type { Post } from "./server";

/** `list` with `incoming` laid over it: a message already in the list is replaced, a new one takes its place in order. */
export function mergePosts(list: readonly Post[], incoming: readonly Post[]): Post[] {
  const map = new Map(list.map(post => [post.id, post]));
  for (const post of incoming) map.set(post.id, post);
  return [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
}
