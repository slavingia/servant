// Marks on the feedback screenshot are stored as fractions of the picture (0 to 1 across, 0 to 1 down), not
// as pixels, so they stay on the same part of the screen when the picture is drawn at another size (the keyboard
// opening, rotating, a bigger window) and when it is flattened onto the screenshot to send.
export type Point = { x: number; y: number };

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** The largest size with the screenshot's shape that fits inside the available area. */
export function fitInside(areaWidth: number, areaHeight: number, shotWidth: number, shotHeight: number): { width: number; height: number } {
  if (!(areaWidth > 0 && areaHeight > 0 && shotWidth > 0 && shotHeight > 0)) return { width: 0, height: 0 };
  const scale = Math.min(areaWidth / shotWidth, areaHeight / shotHeight);
  return { width: shotWidth * scale, height: shotHeight * scale };
}

/** A touch position inside the picture, as fractions of it. */
export function toFraction(x: number, y: number, width: number, height: number): Point {
  if (!(width > 0 && height > 0)) return { x: 0, y: 0 };
  return { x: clamp(x / width), y: clamp(y / height) };
}

/** SVG path for a mark drawn at the picture's current size. One point is drawn as a dot. */
export function pathFor(points: readonly Point[], width: number, height: number): string {
  if (!points.length) return "";
  const at = (p: Point) => `${(p.x * width).toFixed(1)} ${(p.y * height).toFixed(1)}`;
  const first = at(points[0]);
  return points.length === 1 ? `M${first} L${first}` : `M${first} ${points.slice(1).map(p => `L${at(p)}`).join(" ")}`;
}

/** Pen width that stays the same share of the picture however big it is drawn (4 on a 360 wide picture). */
export const strokeWidthFor = (width: number) => Math.max(2, width * 0.011);
