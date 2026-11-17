// A conversation opens in one step: already at its newest message, with the screen full.
//
// The recycling list (a browser and the Mac app, lib/conversation-list.ts) builds its first screen in several
// passes: the newest message alone, then the rows around it at heights it has guessed, then again once it has
// measured them. Each pass was drawn, so opening a channel showed two to four different pictures, one of them
// often thousands of points from the end, and on a busy device the list could stop there: it scrolls to the
// last row by guessed heights and gives up after a tenth of a second.
//
// So while it opens the list is laid out but not drawn, and it is kept at its end, until it is at its end with
// every row in view measured. Then it is shown, once. It is never held for longer than OPENING_CAP_MS: a list
// that has not settled by then is shown as it is, and still kept at its end until it settles. This file is the
// decision, frame by frame; lib/use-list-opening.ts reads the list and acts on it.

/** The longest a list is held undrawn, counted from the first frame it has a size. */
export const OPENING_CAP_MS = 300;
/**
 * Once shown, the list is watched this much longer. The list's own first scroll goes to the top of the last
 * row, and for a tenth of a second it repeats it: under a newest message taller than the screen that is not
 * the end, and it is put back.
 */
export const WATCH_MS = 250;
/** After this long the list is left alone, settled or not. */
export const SETTLE_LIMIT_MS = 2000;

/** What the list looks like in one frame. `measured`: every row in view has been measured, none is a guess. */
export type ListFrame = { scrollTop: number; scrollHeight: number; clientHeight: number; measured: boolean };
export type Opening = { startedAt: number | null; shownAt: number | null; done: boolean };
export type OpeningStep = {
  state: Opening;
  /** Put the list at its end now. */
  pin: boolean;
  /** Show the list now: the first frame it is drawn. */
  show: boolean;
};

export const startOpening = (): Opening => ({ startedAt: null, shownAt: null, done: false });

/** How far the list is from its end, in points. A list shorter than its window is at its end. */
export const fromEnd = (frame: Pick<ListFrame, "scrollTop" | "scrollHeight" | "clientHeight">) => Math.max(0, frame.scrollHeight - frame.clientHeight - frame.scrollTop);

/**
 * One frame of an opening list. `frame` is null while the list has no size yet (its screen is covered, or it
 * has not been laid out): nothing is decided and the clock does not run.
 */
export function openingStep(state: Opening, frame: ListFrame | null, now: number): OpeningStep {
  if (state.done || !frame || frame.clientHeight <= 0) return { state, pin: false, show: false };
  const startedAt = state.startedAt ?? now;
  const elapsed = now - startedAt;
  const atEnd = fromEnd(frame) <= 1;
  // Settled: at the end, and nothing in view is still a guess.
  const settled = atEnd && frame.measured;
  const show = state.shownAt === null && (settled || elapsed >= OPENING_CAP_MS);
  const shownAt = show ? now : state.shownAt;
  // Finished: shown, settled, and watched for a moment after it was shown. Or simply out of time.
  const done = (settled && shownAt !== null && now - shownAt >= WATCH_MS) || elapsed >= SETTLE_LIMIT_MS;
  return { state: { startedAt, shownAt, done }, pin: !atEnd && !done, show };
}

export type RowLayout = { y: number; height: number; isHeightMeasured?: boolean };

/**
 * Has every row in view been measured? `layoutAt` gives a row's place in the list (the list's own record: a
 * row it has not drawn yet has a guessed height and is not measured), `offset` is where the first row starts
 * in the scrolled content. Rows are looked at from the last one up, since an opening list is at its end.
 */
export function rowsInViewMeasured(layoutAt: (index: number) => RowLayout | undefined, count: number, offset: number, scrollTop: number, clientHeight: number): boolean {
  const top = scrollTop, bottom = scrollTop + clientHeight;
  for (let index = count - 1; index >= 0; index--) {
    const row = layoutAt(index);
    if (!row) return false;
    const rowTop = offset + row.y, rowBottom = rowTop + row.height;
    // This row and every one before it are above the window.
    if (rowBottom <= top) return true;
    if (rowTop < bottom && !row.isHeightMeasured) return false;
  }
  return true;
}
