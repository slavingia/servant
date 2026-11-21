// Where the caret is in a message box that opens with a saved draft in it. A phone puts it after the last word.
// A browser left it before the first one, so on coming back to a chat the next words went in front of the draft,
// and in front of an @mention that had been left in the box.

/** The parts of a browser's text box this reads and sets. */
export type DraftBox = { value: string; selectionStart: number | null; selectionEnd: number | null; setSelectionRange(start: number, end: number): void; scrollTop: number; scrollHeight: number };

/**
 * Puts the caret after the draft a box opened with, and says whether it did. The box is left alone when it is
 * empty, and once the caret is anywhere but the very start: by then the person has typed or clicked, and the
 * caret is theirs. A focused box also shows its last line, where the caret now is.
 */
export function caretAfterDraft(box: DraftBox | null | undefined, focused: boolean): boolean {
  if (!box || typeof box.setSelectionRange !== "function" || !box.value || box.selectionStart !== 0 || box.selectionEnd !== 0) return false;
  const end = box.value.length;
  box.setSelectionRange(end, end);
  if (focused) box.scrollTop = box.scrollHeight;
  return true;
}
