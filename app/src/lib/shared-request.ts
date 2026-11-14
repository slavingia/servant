// The conversation list is asked for again from several places that fire in the same moment: leaving a
// conversation asks, and Home coming back into view asks too. Each request costs encryption on the thread
// that draws the screen, and the answer is the same. Calls that land within a few hundredths of a second of
// each other now share one request; a call after that window starts its own, so nobody is handed an answer
// older than their question.

type Timer = { set: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
const clock: Timer = { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function createSharedRequest(start: () => Promise<void>, windowMs = 40, timer: Timer = clock) {
  let waiting: { promise: Promise<void>; settle: () => void; handle: unknown } | null = null;
  return {
    /** Ask. Resolves when the request this call shares has finished (it never rejects: `start` reports its own errors). */
    request(): Promise<void> {
      if (waiting) return waiting.promise;
      let settle = () => {};
      const promise = new Promise<void>(resolve => { settle = resolve; });
      const handle = timer.set(() => {
        waiting = null;
        start().then(settle, settle);
      }, windowMs);
      waiting = { promise, settle, handle };
      return promise;
    },
    /** Drop a request that has not left yet (the account changed, the app is closing). Whoever waits on it is let go. */
    cancel() {
      if (!waiting) return;
      timer.clear(waiting.handle);
      waiting.settle();
      waiting = null;
    },
  };
}
