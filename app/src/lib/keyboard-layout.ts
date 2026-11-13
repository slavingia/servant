export type WindowFrame = { x: number; y: number; width: number; height: number };
export type KeyboardFrame = { screenX: number; screenY: number; width: number; height: number };

// Both frames use window coordinates. A resized Android window may already end
// above the keyboard, so reserve only the remaining overlap, never its full height.
export function keyboardOverlap(view: WindowFrame, keyboard?: KeyboardFrame | null) {
  if (!keyboard || keyboard.height <= 0 || keyboard.width <= 0
    || keyboard.screenX >= view.x + view.width || keyboard.screenX + keyboard.width <= view.x) return 0;
  return Math.max(0, Math.min(view.height, view.y + view.height - keyboard.screenY));
}
