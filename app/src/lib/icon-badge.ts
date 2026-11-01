type InboxItem = { unread?: number; archived?: boolean };

// Use the established inbox endpoints so badge repair also works with servers
// that predate notification-card reconciliation. Failed/incomplete loads must
// never be mistaken for an empty inbox.
export async function loadIconBadge(
  conversations: () => Promise<InboxItem[]>, chats: () => Promise<InboxItem[]>,
) {
  const inboxes = await Promise.all([conversations(), chats()]);
  let total = 0;
  for (const [index, inbox] of inboxes.entries()) {
    if (!Array.isArray(inbox)) throw new Error('Incomplete unread snapshot');
    for (const item of inbox) {
      if (item.archived) continue;
      // Older servers omit private-agent unread counts.
      const count = index === 1 && item.unread === undefined ? 0 : item.unread;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid unread count');
      total += count;
    }
  }
  return total;
}

// A push can change the OS badge without changing React's unread totals. Always
// reapply a fresh count on resume/receipt, including an unchanged zero. Serialize
// writes and invalidate older loads when another refresh or server count arrives.
export function createIconBadgeSync({ load, setBadge, active }: {
  load: (signal: AbortSignal) => Promise<number>;
  setBadge: (count: number) => Promise<unknown>;
  active: () => boolean;
}) {
  let disposed = false;
  let revision = 0;
  let queued = false;
  let supplied: number | undefined;
  let running: Promise<void> | null = null;
  const scope = new AbortController();
  const refresh = (count?: number): Promise<void> => {
    if (disposed || !active()) return Promise.resolve();
    revision++;
    queued = true;
    supplied = count;
    if (running) return running;
    running = Promise.resolve().then(async () => {
      while (queued && !disposed && active()) {
        queued = false;
        const version = revision;
        const count = supplied;
        try {
          const badge = count ?? await load(scope.signal);
          if (disposed || !active() || version !== revision) continue;
          if (Number.isSafeInteger(badge) && badge >= 0) await setBadge(badge);
        } catch { /* Preserve the badge offline; retry on resume/reconnect. */ }
      }
    }).finally(() => {
      running = null;
      if (queued && !disposed && active()) return refresh(supplied);
    });
    return running;
  };
  return { refresh, dispose: () => { disposed = true; revision++; scope.abort(); } };
}
