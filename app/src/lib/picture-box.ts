// The place a picture takes in a conversation, decided before its bytes arrive.
//
// A picture used to load into a 4:3 box and the box then took the picture's shape, so everything under it
// jumped. The server now sends each picture's width and height with the message (server/image-size.mjs), and
// the box is drawn at that shape from the first frame. A picture from before the server kept sizes still
// starts at 4:3; its size is remembered once it has loaded, so the next time it is drawn it starts right.
import { createScreenCache } from "./screen-cache.ts";

export type PictureSize = { width: number; height: number };

/** A single picture is never wider or taller than this, in points. */
export const PICTURE_MAX_WIDTH = 480;
export const PICTURE_MAX_HEIGHT = 380;
/** The shape of the box while a picture's size is not known: what every picture's box was before. */
export const UNKNOWN_ASPECT = 4 / 3;
// Width over height. A box narrower than TALLEST (a very long screenshot) or flatter than FLATTEST (a
// panorama) would be a sliver too small to see or to press, so the box stops there and the picture is fitted
// inside it. At the tallest the box is 152 points wide; at the flattest it is a quarter as tall as it is wide.
export const TALLEST = 0.4;
export const FLATTEST = 4;

/** A width and height that can be drawn, or null: the server sends none for an older picture, and a file that is not one. */
export function pictureSize(value: { width?: unknown; height?: unknown } | null | undefined): PictureSize | null {
  const width = value?.width, height = value?.height;
  return typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The box for one picture on its own: its shape, and the most width it may take. The box is as wide as the
 * message allows up to `maxWidth`, and `maxWidth` is what keeps a tall picture from being taller than
 * PICTURE_MAX_HEIGHT: the box narrows instead of the picture being squeezed into a wider one.
 */
export function pictureBox(size: PictureSize | null): { aspectRatio: number; maxWidth: number } {
  if (!size) return { aspectRatio: UNKNOWN_ASPECT, maxWidth: PICTURE_MAX_WIDTH };
  const aspectRatio = Math.min(FLATTEST, Math.max(TALLEST, size.width / size.height));
  return { aspectRatio, maxWidth: Math.min(PICTURE_MAX_WIDTH, PICTURE_MAX_HEIGHT * aspectRatio) };
}

/** The box in points when the message has `available` points of width for it. */
export function pictureBoxSize(size: PictureSize | null, available: number): PictureSize {
  const box = pictureBox(size);
  const width = Math.max(0, Math.min(available, box.maxWidth));
  return { width, height: Math.min(PICTURE_MAX_HEIGHT, width / box.aspectRatio) };
}

/**
 * Does a box drawn for `drawn` already have the shape `loaded` asks for? A phone may say the size of the
 * smaller copy it decoded, which is the same shape give or take a rounded pixel: within two percent is the same.
 */
export function sameBox(drawn: PictureSize | null, loaded: PictureSize | null): boolean {
  const a = pictureBox(drawn).aspectRatio, b = pictureBox(loaded).aspectRatio;
  return Math.abs(a - b) <= a * 0.02;
}

// Sizes learned by loading a picture, by its file id. Kept in memory like the screens themselves, and dropped
// with them on sign-out and when the account changes.
const remembered = createScreenCache<PictureSize>(500);

/** The size to draw a picture's box with: the server's, else the one remembered from loading it before. */
export function sizeFor(file: { id: string; width?: unknown; height?: unknown }): PictureSize | null {
  return pictureSize(file) ?? remembered.get(file.id) ?? null;
}

/** A picture has loaded and said how big it is. */
export function rememberSize(id: string, size: { width?: unknown; height?: unknown } | null | undefined) {
  const known = pictureSize(size);
  if (id && known) remembered.set(id, known);
}
