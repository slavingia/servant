// When the "Add your work email" banner shows. Pure, so it runs under node tests.
export const NUDGE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export function nudgeVisible(needed: boolean | null, dismissedAt: number | null, now = Date.now()): boolean {
  if (!needed) return false;
  return dismissedAt === null || !Number.isFinite(dismissedAt) || now - dismissedAt >= NUDGE_SNOOZE_MS;
}
