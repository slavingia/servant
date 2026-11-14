// What a screen last showed, kept so that coming back to it paints at once while a fresh copy loads
// behind it. Everything here lives in memory only: nothing is written to the device, and it is all
// dropped when the app closes, on sign-out and when the signed-in account changes.

type Clearable = { clear: () => void };
const all = new Set<Clearable>();

/** Drop everything every screen has kept. Called when the signed-in account changes or signs out. */
export function clearScreenCaches() {
  for (const cache of all) cache.clear();
}
/** Something else that holds one account's data in memory (a queue of loads): cleared with the caches. */
export function clearWithScreenCaches(store: Clearable) {
  all.add(store);
}

/** A small most-recently-used store: the screens a person goes back to are the ones kept. */
export function createScreenCache<T>(limit = 30) {
  const entries = new Map<string, T>();
  const cache = {
    get(key: string): T | undefined {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      // Reading keeps it: move it to the newest end.
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    /** What is kept for `key`, without counting as a visit. */
    peek(key: string): T | undefined { return entries.get(key); },
    set(key: string, value: T) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
    /** A newer value for something already kept (a message arrived for it). Not a visit; does nothing when it is not kept. */
    update(key: string, value: T) { if (entries.has(key)) entries.set(key, value); },
    delete(key: string) { entries.delete(key); },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
  all.add(cache);
  return cache;
}

/**
 * Requests started the moment a row is pressed, before the screen it opens has been built. The screen takes
 * the request for its key instead of making its own, so the answer is already on its way (or here) when the
 * screen first draws. `T` is the promise, or a set of promises, the caller started; it handles their failures.
 * `mark` is whatever the caller wants to compare later, such as a count of live events: if it moved between
 * the request and the screen listening, the screen looks again.
 */
export function createEarlyRequests<T>(maxAgeMs = 5000, now: () => number = Date.now) {
  const started = new Map<string, { result: T; at: number; mark: number }>();
  const fresh = (key: string) => {
    const entry = started.get(key);
    return entry && now() - entry.at <= maxAgeMs ? entry : null;
  };
  const requests = {
    start(key: string, mark: number, request: () => T) {
      if (!fresh(key)) started.set(key, { result: request(), at: now(), mark });
    },
    /** The request for this key, left where it is for the screen to take. */
    peek(key: string): { result: T; mark: number } | null {
      const entry = fresh(key);
      return entry ? { result: entry.result, mark: entry.mark } : null;
    },
    /** The request for this key, once. Null when none was started or it is too old to trust. */
    take(key: string): { result: T; mark: number } | null {
      const entry = requests.peek(key);
      started.delete(key);
      return entry;
    },
    clear() { started.clear(); },
  };
  all.add(requests);
  return requests;
}

/** The newest `page` items of a list and whether older ones were left out, so what is kept matches a fresh first page. */
export function newestPage<T>(items: readonly T[], more: boolean, page: number): { items: T[]; more: boolean } {
  return items.length > page ? { items: items.slice(items.length - page), more: true } : { items: items.slice(), more };
}
