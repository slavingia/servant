// How long a reply is likely to work, from how long this person's replies have worked before
// (docs/agent-turns.md, "How long is left"). It reads times only: no prompt, no reply, and nobody else's replies.
//
// It is given how long finished replies worked, newest first. The journal picks them: only replies that
// completed, only ones that ran past the first minute, and without the time they spent waiting for an OK.
// An estimate is something the history has to earn; when it can't, the answer is null and the app shows what
// it always has.

/** A reply that ends inside the first minute is over before an estimate could be read. The app says nothing about time until then either. */
export const LONG_REPLY_MS = 60_000;
/** How many past replies are looked at. Recent ones say most about what this person is doing now. */
export const SAMPLE = 20;
// Fewer than this is a guess, not a habit.
const ENOUGH = 5;
// Replies that are usually done within two minutes leave nothing to plan around.
const WORTH_SAYING_MS = 120_000;
// When the slow quarter took more than four times as long as the quick quarter, the past does not agree with
// itself, and any one number would be wrong most of the time.
const TOO_UNEVEN = 4;

// The value that this share of the sorted numbers falls under, reading between two neighbours.
function share(sorted, part) {
  const at = (sorted.length - 1) * part, low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
}

/**
 * How long replies like this one usually work, in milliseconds: the time three in four of them finished within.
 * Null when the history can't say. `here` is this chat's replies; `mine` is the same person's across their chats
 * on the same agent, used until this chat has enough of its own.
 */
export function usualWork({ here = [], mine = [] } = {}) {
  const sorted = (here.length >= ENOUGH ? here : mine).filter(ms => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
  if (sorted.length < ENOUGH) return null;
  const usual = share(sorted, 0.75);
  if (usual < WORTH_SAYING_MS || usual > share(sorted, 0.25) * TOO_UNEVEN) return null;
  return Math.round(usual);
}
