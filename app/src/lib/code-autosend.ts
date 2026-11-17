// The Enter code screen sends a code by itself once it is complete (docs/code-requests.md).
// A code is complete when it has as many characters as the automation said to expect, or, when it said
// nothing, when it is six digits: the length of the text and email sign-in codes people are usually sent.

/** What the screen sends: the code without the spaces and dashes people type or paste. */
export function cleanCode(value: string): string {
  return value.replace(/[\s-]/g, "");
}

/** The length to wait for: the automation's own number when it gave one, otherwise six digits. */
export function expectedLength(length: unknown): number | null {
  return typeof length === "number" && Number.isInteger(length) && length >= 4 && length <= 12 ? length : null;
}

/**
 * Whether the screen should send this code without a tap. Never the same code twice, so a code the
 * server turned down stays on screen to be corrected instead of being sent again.
 */
export function shouldAutoSend(value: string, length: unknown, lastSent: string | null): boolean {
  const code = cleanCode(value);
  if (code === lastSent) return false;
  const expected = expectedLength(length);
  return expected === null ? /^\d{6}$/.test(code) : code.length === expected && /^[A-Za-z0-9]+$/.test(code);
}
