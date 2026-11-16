export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export type Zoom = { scale: number; x: number; y: number };
export type Point = { x: number; y: number };
export const FIT: Zoom = { scale: 1, x: 0, y: 0 };

export const clampScale = (scale: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));

/** Never let the picture slide past the frame: at scale s there are (s-1)/2 frames of spare room each side. */
export function clampZoom(zoom: Zoom, width: number, height: number): Zoom {
  const scale = clampScale(zoom.scale);
  const mx = ((scale - 1) * width) / 2, my = ((scale - 1) * height) / 2;
  return { scale, x: Math.min(mx, Math.max(-mx, zoom.x)), y: Math.min(my, Math.max(-my, zoom.y)) };
}

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Two fingers: the spot of the picture that was under the starting midpoint stays under the fingers.
 * Points are measured from the centre of the frame.
 */
export function pinchZoom(start: Zoom, from: { mid: Point; gap: number }, now: { mid: Point; gap: number }, width: number, height: number): Zoom {
  const scale = clampScale(start.scale * (from.gap > 0 ? now.gap / from.gap : 1));
  const ratio = scale / start.scale;
  return clampZoom({ scale, x: now.mid.x - (from.mid.x - start.x) * ratio, y: now.mid.y - (from.mid.y - start.y) * ratio }, width, height);
}

/** One finger moves a zoomed picture; at fit there is nothing to move. */
export function panZoom(start: Zoom, dx: number, dy: number, width: number, height: number): Zoom {
  return start.scale <= MIN_ZOOM ? FIT : clampZoom({ ...start, x: start.x + dx, y: start.y + dy }, width, height);
}

/** A double tap zooms in on the spot, or back to fit when already zoomed. */
export function doubleTapZoom(current: Zoom, tap: Point, width: number, height: number): Zoom {
  if (current.scale > 1.01) return FIT;
  const scale = 2.5;
  return clampZoom({ scale, x: -tap.x * (scale - 1), y: -tap.y * (scale - 1) }, width, height);
}
