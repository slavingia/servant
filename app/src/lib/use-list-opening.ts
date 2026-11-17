// Holds a conversation's recycling list undrawn, and at its end, until its first screen has settled; then
// shows it, once. lib/list-opening.ts says why and decides each frame; this reads the list and acts on it.
import { useEffect, useRef, useState, type RefObject } from "react";
import { Platform, type ViewStyle } from "react-native";
import type { FlashListRef } from "@shopify/flash-list";
import { openingStep, rowsInViewMeasured, startOpening, type ListFrame } from "./list-opening";

// The list is read through the page's own scroller, which only a browser and the Mac app have, and they are
// the only places the recycling list is used (lib/conversation-list.ts). Anywhere else nothing is held: the
// list is drawn from its first frame, as it would be without this.
const HOLDS = Platform.OS === "web";
// Laid out as usual, so the list can measure its rows; only not drawn.
const HELD: ViewStyle = { opacity: 0 };
type Element = { style?: { opacity?: string }; parentElement?: Element | null };
type Scroller = Element & { scrollTop: number; scrollHeight: number; clientHeight: number; addEventListener(type: string, listener: () => void, options?: object): void; removeEventListener(type: string, listener: () => void): void };

// Shown in this frame, not the next: the style that holds the list is taken off the page here, and the render
// that follows the state change finds it already gone.
function drawNow(node: Scroller | null) {
  for (let element: Element | null | undefined = node, depth = 0; element && depth < 3; element = element.parentElement, depth++) {
    if (element.style?.opacity === "0") { element.style.opacity = ""; return; }
  }
}

/**
 * `list`: the ref given to the list. `mounted`: the list is on the page (the conversation has messages to
 * show). `inFront`: its screen is the one on top, so the list has a size. Returns the style to give the list:
 * the one that holds it undrawn while it opens, then none.
 */
export function useListOpening<T>(list: RefObject<FlashListRef<T> | null>, mounted: boolean, inFront: boolean): ViewStyle | undefined {
  const [shown, setShown] = useState(!HOLDS);
  // A list that goes away (the conversation is fetched afresh after a reconnect) opens again when it is back.
  if (HOLDS && !mounted && shown) setShown(false);
  const opening = useRef(startOpening());
  useEffect(() => { if (!mounted) opening.current = startOpening(); }, [mounted]);
  useEffect(() => {
    if (!HOLDS || !mounted || !inFront || opening.current.done) return;
    let frame = 0;
    let watched: Scroller | null = null;
    // Once the list is shown, a person who starts to scroll has it to themselves.
    const letGo = () => { if (opening.current.shownAt !== null) opening.current = { ...opening.current, done: true }; };
    const tick = () => {
      const api = list.current;
      const node = (api?.getScrollableNode?.() ?? null) as Scroller | null;
      if (node && node !== watched && typeof node.addEventListener === "function") {
        watched = node;
        for (const type of ["wheel", "touchstart", "keydown"]) node.addEventListener(type, letGo, { passive: true });
      }
      const seen: ListFrame | null = api && node ? {
        scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
        measured: rowsInViewMeasured(index => api.getLayout(index), api.props.data?.length ?? 0, api.getFirstItemOffset(), node.scrollTop, node.clientHeight),
      } : null;
      const step = openingStep(opening.current, seen, performance.now());
      opening.current = step.state;
      if (step.pin && node) node.scrollTop = node.scrollHeight;
      if (step.show) { drawNow(node); setShown(true); }
      if (!step.state.done) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (watched) for (const type of ["wheel", "touchstart", "keydown"]) watched.removeEventListener(type, letGo);
    };
  }, [list, mounted, inFront]);
  return shown ? undefined : HELD;
}
