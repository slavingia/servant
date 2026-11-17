import { Platform } from "react-native";

// A conversation's messages are drawn by one of two lists.
//
// In a browser and the Mac app: a recycling list (FlashList) in reading order, oldest first, which starts at the
// newest message and loads older ones when the top comes near. Measured on a 2,000-message channel it does a
// fraction of the work of the list it replaced (docs/performance.md). It builds its first screen in several
// passes, so it is held undrawn until that screen has settled and then shown once (lib/list-opening.ts).
//
// On a phone: still React Native's own list, turned upside down so the newest message is first. The recycling
// list has not been run on a phone yet; change this one line once it has.
export const RECYCLING_CONVERSATION_LIST = Platform.OS === "web";

/** The messages in the order the list draws them, given them newest first. */
export const listOrder = <T,>(newestFirst: readonly T[], recycling: boolean): readonly T[] => recycling ? [...newestFirst].reverse() : newestFirst;

/** The message just before this one in time, wherever the list puts it. */
export const olderNeighbour = <T,>(items: readonly T[], index: number, recycling: boolean): T | undefined => items[recycling ? index - 1 : index + 1];

/** Is this the newest message? */
export const isNewest = (count: number, index: number, recycling: boolean) => index === (recycling ? count - 1 : 0);
