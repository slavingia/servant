import type { Post } from "./server";

export type MessagesRead = {
  conversationId: string;
  userId: string;
  messageIds: string[];
  readAt: number;
};

// A receipt event must never replace message contents with an older snapshot.
export function mergeReadEvent(post: Post, event: MessagesRead): Post {
  if (post.conversationId !== event.conversationId || !event.messageIds.includes(post.id)
    || post.deleted || post.pending || post.activity || post.user.agent
    || post.user.id === event.userId || !event.userId || !Number.isFinite(event.readAt) || event.readAt <= 0) return post;
  const readers = post.readBy ?? [];
  const existing = readers.find(reader => reader.userId === event.userId);
  if (existing && existing.readAt <= event.readAt) return post;
  return { ...post, readBy: [
    ...readers.filter(reader => reader.userId !== event.userId),
    { userId: event.userId, readAt: event.readAt },
  ].sort((a, b) => a.readAt - b.readAt || a.userId.localeCompare(b.userId)) };
}

function canRead(post: Post, conversationId: string, me: string) {
  // Completed agent replies still need to advance the unread watermark. The
  // server decides which of these visible messages may also receive receipts.
  return post.conversationId === conversationId && post.user.id !== me
    && !post.deleted && !post.pending && !post.activity;
}

// The native list supplies only rows that passed its visibility/dwell threshold.
// Keep this queue independent of native APIs so races and retries are testable.
export function createReadReceiptQueue({ conversationId, me, send }: {
  conversationId: string;
  me: string;
  send: (messageIds: string[]) => Promise<unknown>;
}) {
  let visible: Post[] = [];
  let active = false;
  let disposed = false;
  let busy = false;
  const acknowledged = new Set<string>();
  const setVisible = (posts: Post[]) => {
    if (disposed) return;
    visible = posts;
    for (const post of posts) {
      if (post.conversationId === conversationId && post.readBy?.some(reader => reader.userId === me)) acknowledged.add(post.id);
    }
  };
  const pending = () => [...new Set(visible.filter(post => canRead(post, conversationId, me)
    && !acknowledged.has(post.id)).map(post => post.id))];
  return {
    setVisible,
    refreshPosts(posts: Post[]) {
      const current = new Map(posts.map(post => [post.id, post]));
      // Data changes do not necessarily trigger a native viewability callback
      // when the visible keys are unchanged (for example, a streaming reply).
      setVisible(visible.flatMap(post => current.has(post.id) ? [current.get(post.id)!] : []));
    },
    setActive(value: boolean) { active = value && !disposed; },
    hasPending() { return active && !disposed && pending().length > 0; },
    async flush() {
      if (busy || !active || disposed) return;
      busy = true;
      try {
        while (active && !disposed) {
          const batch = pending().slice(0, 100);
          if (!batch.length) return;
          try { await send(batch); }
          catch { return; } // A failed request is never acknowledged; the caller retries.
          for (const id of batch) acknowledged.add(id);
        }
      } finally { busy = false; }
    },
    dispose() { disposed = true; active = false; visible = []; acknowledged.clear(); },
  };
}
