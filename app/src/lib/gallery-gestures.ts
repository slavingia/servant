type Drag = { dx: number; dy: number };

/** Horizontal browsing and multi-touch image gestures never start dismissal. */
export function canStartGalleryDismiss({ dx, dy, numberActiveTouches }: Drag & { numberActiveTouches: number }): boolean {
  return numberActiveTouches === 1 && Math.abs(dx) < 24 && dy > 12 && dy > Math.abs(dx) * 1.5;
}

/** A deliberate pull or downward flick closes; short/reversed drags spring back. */
export function shouldDismissGallery({ dx, dy, vy }: Drag & { vy: number }, height: number): boolean {
  if (dy <= Math.abs(dx) * 1.5) return false;
  const distance = Math.min(120, Math.max(72, height * 0.18));
  return dy >= distance || (dy >= 36 && vy >= 0.7);
}

/** While pulling down, the picture shrinks with the drag, from full size to half. */
export function galleryDismissScale(dy: number, height: number): number {
  const pulled = Math.min(1, Math.max(0, dy) / Math.max(1, height));
  return 1 - pulled * 0.5;
}

/** Pinch zoom is always available; only a scale meaningfully past fit locks paging and dismissal. */
export function isZoomedIn(zoomScale: number | undefined): boolean {
  return typeof zoomScale === "number" && zoomScale > 1.01;
}
