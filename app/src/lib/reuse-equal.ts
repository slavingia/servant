// A fresh copy of a list from the server usually says what the last copy said. React compares
// by identity, so handing it the new copy re-renders every row and everything that reads the
// list. reuseEqual hands back the old value wherever the new one is the same, down to each
// item: nothing re-renders when nothing changed, and only the changed row does when one did.

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const hasId = (value: unknown): value is { id: string | number } => isPlain(value) && (typeof value.id === "string" || typeof value.id === "number");

/** `next`, built from as much of `previous` as says the same thing. Returns `previous` itself when nothing differs. For JSON-like values. */
export function reuseEqual<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    // Rows are matched by id when they have one, so a new row at the top keeps every other row.
    const byId = next.every(hasId) && previous.every(hasId) ? new Map(previous.map(item => [(item as { id: string | number }).id, item])) : null;
    let same = previous.length === next.length;
    const merged = next.map((item, index) => {
      const before = byId ? byId.get((item as { id: string | number }).id) : index < previous.length ? previous[index] : undefined;
      const kept = before === undefined ? item : reuseEqual(before, item);
      if (kept !== previous[index]) same = false;
      return kept;
    });
    return same ? previous : merged as T;
  }
  if (isPlain(previous) && isPlain(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(previous).length;
    const merged: Plain = {};
    for (const key of keys) {
      const known = Object.prototype.hasOwnProperty.call(previous, key);
      const kept = known ? reuseEqual(previous[key], next[key]) : next[key];
      if (!known || kept !== previous[key]) same = false;
      merged[key] = kept;
    }
    return same ? previous : merged as T;
  }
  return next;
}

/** `previous` when `next` has the same keys holding the very same values; `next` otherwise. For maps rebuilt from a list that reuseEqual has already settled. */
export function sameEntries<K, V>(previous: Map<K, V>, next: Map<K, V>): Map<K, V> {
  if (previous.size !== next.size) return next;
  for (const [key, value] of next) if (!previous.has(key) || previous.get(key) !== value) return next;
  return previous;
}
