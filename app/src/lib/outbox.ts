// A message you send shows in the conversation the moment you press Send, before the server has
// answered. This keeps the messages on their way: it shows each one at once, takes it away again if
// sending fails (the composer puts the text back and says why), and swaps it for the server's copy
// when that arrives, in the same row.
import type { Person, Post } from "./server";
import type { SourceDevice } from "./message-device";

export type OutboxInput = {
  conversationId: string;
  threadRoot: string | null;
  text: string;
  user: Person;
  /** The newest message already in the list: the new one never sorts or dates before it, whatever this device's clock says. */
  after?: Pick<Post, "createdAt"> | null;
  /** What the server will say this device is, when the viewer is shown that (the owner). */
  sourceDevice?: SourceDevice;
};

export function createOutbox(now: () => number = Date.now) {
  let sending: Post[] = [];
  // My own messages that arrived on the live connection while a send was still waiting for its answer.
  let held: Post[] = [];
  // The row a sent message was first shown in, so the list keeps that row when the server's copy takes its place.
  const rows = new Map<string, string>();
  let count = 0;
  return {
    /** The messages on their way, oldest first. A new array whenever it changes. */
    sending: () => sending,
    /** Shows a message at once. Returns the copy to render; its id is local to this device. */
    add(input: OutboxInput): Post {
      const post: Post = {
        id: `sending-${++count}`, conversationId: input.conversationId, user: input.user, threadRoot: input.threadRoot, text: input.text,
        deleted: false, pending: false, sending: true, replyCount: 0, lastReplyAt: null, editedAt: null,
        createdAt: Math.max(now(), input.after?.createdAt ?? 0),
        ...(input.sourceDevice ? { sourceDevice: input.sourceDevice } : {}),
      };
      sending = [...sending, post];
      return post;
    },
    /**
     * A message from the live connection. While a send is waiting for its answer, a new message of mine is most
     * likely that send coming back, so it is kept aside instead of showing twice; true when it was kept.
     */
    hold(event: "message.created" | "message.updated", post: Post, me: string): boolean {
      if (!sending.length || post.user.id !== me) return false;
      if (event === "message.updated" && !held.some(kept => kept.id === post.id)) return false;
      held = [...held.filter(kept => kept.id !== post.id), post];
      return true;
    },
    /**
     * The send was answered: `sent` is the server's copy, or null when sending failed. Returns the messages the
     * list should now take in, newest version last.
     */
    settle(localId: string, sent: Post | null): Post[] {
      sending = sending.filter(post => post.id !== localId);
      if (sent) rows.set(sent.id, localId);
      // With other sends still waiting, only this message's own updates are let go.
      const released = sending.length ? held.filter(kept => kept.id === sent?.id) : held;
      held = held.filter(kept => !released.includes(kept));
      return sent ? [sent, ...released] : released;
    },
    /** The list key for a message: a sent message keeps the row it was first shown in. */
    key: (post: Pick<Post, "id">) => rows.get(post.id) ?? post.id,
  };
}
export type Outbox = ReturnType<typeof createOutbox>;
