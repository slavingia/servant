// The list that opens in a message box while typing "@" (people to mention) or "/" (commands).
//
// It used to sit in the page between the conversation and the box, so opening it pushed every message up by
// its height and closing it let them fall back. It is now drawn over the conversation, just above the box
// (components/Messaging.tsx): the conversation does not move when it opens or closes. These are its rules:
// how tall it may be, and what the keys do while it is open.

/** The list is at most this tall, and scrolls when it holds more: three rows and half of a fourth, so it reads as a list that goes on. */
export const SUGGESTIONS_MAX_HEIGHT = 216;
/** One row. With very little room over the box (a small phone with the keyboard up) the list is still this tall. */
export const SUGGESTION_ROW_HEIGHT = 56;
// Kept clear between the top of the list and whatever is over the conversation (a header, an error line).
const HEADROOM = 8;

/** How tall the list may be when `above` points are free over the message box, so it never leaves the screen. */
export function suggestionsHeight(above: number | null | undefined): number {
  if (typeof above !== "number" || !Number.isFinite(above)) return SUGGESTIONS_MAX_HEIGHT;
  return Math.max(SUGGESTION_ROW_HEIGHT, Math.min(SUGGESTIONS_MAX_HEIGHT, Math.floor(above) - HEADROOM));
}

export type SuggestionList = {
  /** People to mention, or commands. */
  kind: "mention" | "command";
  /** How many options are listed. A mention list with nobody in it says "No matches". */
  count: number;
  /**
   * The option the arrow keys are on, or -1 for none. A mention list starts on its first option, the one Enter
   * has always picked. A command list starts on none: Enter there sends what was typed, as it always has, until
   * an arrow key has chosen an option.
   */
  active: number;
};

/** Where a list starts, and where it is after the arrow keys moved within the same options. */
export function activeOption(kind: SuggestionList["kind"], count: number, moved: number | null): number {
  if (count <= 0) return -1;
  if (moved !== null && moved >= 0 && moved < count) return moved;
  return kind === "mention" ? 0 : -1;
}

/** The option an arrow key moves to. From none, Down goes to the first and Up to the last; both wrap around. */
export function moveOption(active: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (active < 0 || active >= count) return step === 1 ? 0 : count - 1;
  return (active + step + count) % count;
}

export type SuggestionKey = { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number };
export type SuggestionAction = { do: "move"; to: number } | { do: "pick"; index: number } | { do: "close" };

/**
 * What a key does while the list is open, or null when the key is not the list's (the box then handles it as
 * it would with no list). `enterSends` is true where Enter sends a message (a keyboard and a pointer); on a
 * touch screen Enter is a new line and the list is picked from by touch.
 */
export function suggestionKey(key: SuggestionKey, list: SuggestionList, enterSends: boolean): SuggestionAction | null {
  // Keys pressed while an input method is composing a character belong to it.
  if (key.isComposing || key.keyCode === 229 || key.altKey || key.ctrlKey || key.metaKey) return null;
  if (key.key === "Escape") return { do: "close" };
  if (list.count <= 0 || key.shiftKey) return null;
  if (key.key === "ArrowDown") return { do: "move", to: moveOption(list.active, list.count, 1) };
  if (key.key === "ArrowUp") return { do: "move", to: moveOption(list.active, list.count, -1) };
  // Tab completes: the option the arrows are on, or the first.
  if (key.key === "Tab") return { do: "pick", index: list.active >= 0 ? list.active : 0 };
  if (key.key === "Enter" && enterSends && list.active >= 0) return { do: "pick", index: list.active };
  return null;
}
