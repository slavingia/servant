/** A call card from someone else that is still live and fresh enough to be worth ringing for. */
export const RING_MS = 45_000;
export function shouldRing(opts: { status: string; startedAt: number; startedById: string; me: string; now: number; dismissed: ReadonlySet<string>; id: string; joined: boolean }) {
  if (opts.status !== "live" || opts.joined || opts.dismissed.has(opts.id)) return false;
  if (opts.startedById === opts.me) return false;
  const at = opts.startedAt < 1e12 ? opts.startedAt * 1000 : opts.startedAt;
  return opts.now - at < RING_MS;
}
