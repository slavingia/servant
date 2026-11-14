// An answer that is costly to ask for and rarely changes, asked once and remembered until told to forget.
// Used for questions put to the system while a screen is being drawn for the first time (can this phone
// take dictation?): asked on every screen, each one held up the first frame of the screen being opened.

export function remembered<T>(ask: () => T) {
  let known: { value: T } | null = null;
  return {
    /** The answer: asked the first time, remembered after. */
    get(): T { return (known ??= { value: ask() }).value; },
    /** Forget it, so the next get asks again (the app came back to the front: a setting may have changed). */
    forget() { known = null; },
  };
}
