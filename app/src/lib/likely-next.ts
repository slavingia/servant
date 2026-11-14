// The conversations and chats a person is most likely to open next: the ones with something unread,
// newest first, then the ones used most recently. These are loaded quietly ahead of time, a few at
// most, so that opening one shows its messages at once instead of a spinner.

type Row = { id: string; unread?: number; archived?: boolean; updatedAt?: number };

export function likelyNext<T extends Row>(rows: readonly T[], limit: number): T[] {
  const open = rows.filter(row => !row.archived);
  const newestFirst = (a: T, b: T) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  const unread = open.filter(row => (row.unread ?? 0) > 0).sort(newestFirst);
  const rest = open.filter(row => !((row.unread ?? 0) > 0)).sort(newestFirst);
  return [...unread, ...rest].slice(0, Math.max(0, limit));
}

type Timer = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const clock: Timer = { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * Loads things one at a time, with a pause before the first and between each, so the work never competes
 * with what the person is doing. Each key is loaded once; asking again for a key that was already asked for
 * does nothing. `idle` says whether now is a good moment (the app is in front); when it is not, the queue
 * waits and looks again.
 */
export function createWarmQueue({ startMs = 2000, gapMs = 500, idle = () => true, timer = clock }: { startMs?: number; gapMs?: number; idle?: () => boolean; timer?: Timer } = {}) {
  const asked = new Set<string>();
  let waiting: { key: string; run: () => Promise<unknown> }[] = [];
  let handle: unknown = null;
  let running = false;
  const schedule = (ms: number) => { if (handle === null && !running && waiting.length) handle = timer.set(next, ms); };
  const next = () => {
    handle = null;
    if (!waiting.length) return;
    if (!idle()) return schedule(startMs);
    const { run } = waiting.shift()!;
    running = true;
    // A load that fails is simply not kept: the screen loads it the usual way when it is opened.
    run().catch(() => {}).then(() => { running = false; schedule(gapMs); });
  };
  return {
    /** Ask for `key` to be loaded when its turn comes. True when it was added, false when it was already asked for. */
    add(key: string, run: () => Promise<unknown>): boolean {
      if (asked.has(key)) return false;
      asked.add(key);
      waiting.push({ key, run });
      schedule(startMs);
      return true;
    },
    /** Forget everything asked for and drop what has not started (the account changed). */
    clear() {
      if (handle !== null) timer.clear(handle);
      handle = null;
      waiting = [];
      asked.clear();
    },
    get pending() { return waiting.length; },
  };
}
