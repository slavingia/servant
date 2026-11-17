// The box a picture is given before it loads: its real shape when the size is known, 4:3 as before when not.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FLATTEST, PICTURE_MAX_HEIGHT, PICTURE_MAX_WIDTH, TALLEST, UNKNOWN_ASPECT, pictureBox, pictureBoxSize, pictureSize, rememberSize, sameBox, sizeFor } from "./picture-box.ts";
import { clearScreenCaches } from "./screen-cache.ts";

// The width a message has for a picture: a 390-point phone (16 at each side and a 44-point avatar column), and a wide window.
const PHONE = 390 - 16 - 44 - 16;
const DESKTOP = 700;
const round = ({ width, height }: { width: number; height: number }) => ({ width: Math.round(width), height: Math.round(height) });

test("a picture whose size is known gets a box of its own shape", () => {
  // A landscape photo fills the width.
  assert.deepEqual(round(pictureBoxSize({ width: 4032, height: 3024 }, PHONE)), { width: 314, height: 236 });
  // A banner is as flat as it is, not padded out to a taller box.
  assert.deepEqual(round(pictureBoxSize({ width: 1600, height: 500 }, PHONE)), { width: 314, height: 98 });
  // A square.
  assert.deepEqual(round(pictureBoxSize({ width: 800, height: 800 }, PHONE)), { width: 314, height: 314 });
  // The shape is the picture's, whatever its resolution.
  assert.equal(pictureBox({ width: 400, height: 300 }).aspectRatio, pictureBox({ width: 4000, height: 3000 }).aspectRatio);
});

test("a tall picture's box is narrower, never taller than the limit and never squeezed", () => {
  // A phone screenshot: as tall as a picture may be, and as wide as that makes it.
  const screenshot = pictureBoxSize({ width: 600, height: 1300 }, PHONE);
  assert.deepEqual(round(screenshot), { width: 175, height: PICTURE_MAX_HEIGHT });
  assert.ok(Math.abs(screenshot.width / screenshot.height - 600 / 1300) < 0.01, "the box keeps the picture's shape");
  // A portrait photo.
  assert.deepEqual(round(pictureBoxSize({ width: 3024, height: 4032 }, PHONE)), { width: 285, height: 380 });
  // In a wide window a square stops at the height limit; a landscape photo stops at the width limit.
  assert.deepEqual(round(pictureBoxSize({ width: 800, height: 800 }, DESKTOP)), { width: 380, height: 380 });
  assert.deepEqual(round(pictureBoxSize({ width: 4032, height: 3024 }, DESKTOP)), { width: PICTURE_MAX_WIDTH, height: 360 });
  // No size ever makes a box over the limits.
  for (const [width, height] of [[1, 1], [1, 9999], [9999, 1], [50, 51], [1170, 2532], [2532, 1170], [16, 9], [9, 16], [1, 3], [3, 1]]) {
    for (const available of [200, PHONE, DESKTOP, 2000]) {
      const box = pictureBoxSize({ width, height }, available);
      assert.ok(box.width <= Math.min(available, PICTURE_MAX_WIDTH) && box.height <= PICTURE_MAX_HEIGHT + 1e-9, `${width}x${height} in ${available}`);
      assert.ok(box.height >= box.width / FLATTEST - 1e-9, "and none is a sliver");
    }
  }
});

test("a very long or very flat picture gets the nearest box it can be seen and pressed in", () => {
  // A long scrolling screenshot: the narrowest box, at full height.
  assert.equal(pictureBox({ width: 1170, height: 9000 }).aspectRatio, TALLEST);
  assert.deepEqual(round(pictureBoxSize({ width: 1170, height: 9000 }, PHONE)), { width: 152, height: 380 });
  // A panorama: the flattest box.
  assert.equal(pictureBox({ width: 12000, height: 1000 }).aspectRatio, FLATTEST);
  const panorama = pictureBoxSize({ width: 12000, height: 1000 }, PHONE);
  assert.deepEqual(round(panorama), { width: 314, height: 79 });
  assert.ok(panorama.height >= 44, "still a control a finger can press");
});

test("a picture whose size is not known keeps the box it always had", () => {
  assert.deepEqual(pictureBox(null), { aspectRatio: UNKNOWN_ASPECT, maxWidth: PICTURE_MAX_WIDTH });
  assert.deepEqual(round(pictureBoxSize(null, PHONE)), { width: 314, height: 236 });
  assert.deepEqual(round(pictureBoxSize(null, DESKTOP)), { width: 480, height: 360 });
  // What the server sends for a file from before it kept sizes, and anything that is not a size.
  for (const value of [undefined, null, {}, { width: 800 }, { width: 0, height: 600 }, { width: 800, height: -1 }, { width: "800", height: "600" }, { width: NaN, height: 600 }, { width: Infinity, height: 600 }]) {
    assert.equal(pictureSize(value as never), null, JSON.stringify(value));
  }
  assert.deepEqual(pictureSize({ width: 800, height: 600 }), { width: 800, height: 600 });
});

test("a size learned by loading a picture is remembered, so its box is right the next time", () => {
  clearScreenCaches();
  const old = { id: "file_old", name: "old.png", mime: "image/png", size: 10 };
  assert.equal(sizeFor(old), null, "never loaded: not known");
  rememberSize(old.id, { width: 600, height: 1300 });
  assert.deepEqual(sizeFor(old), { width: 600, height: 1300 });
  assert.deepEqual(round(pictureBoxSize(sizeFor(old), PHONE)), { width: 175, height: 380 });
  // The server's size is the one used when it sends one.
  assert.deepEqual(sizeFor({ ...old, width: 1600, height: 500 }), { width: 1600, height: 500 });
  // Nothing that is not a size is remembered, and one picture's size is not another's.
  rememberSize("file_other", { width: 0, height: 0 });
  rememberSize("", { width: 5, height: 5 });
  assert.equal(sizeFor({ id: "file_other" }), null);
  assert.equal(sizeFor({ id: "" }), null);
  // Signing out forgets them, with everything else kept in memory.
  clearScreenCaches();
  assert.equal(sizeFor(old), null);
});

test("a box drawn from the size already has the shape the loaded picture asks for", () => {
  assert.ok(sameBox({ width: 600, height: 1300 }, { width: 600, height: 1300 }));
  assert.ok(sameBox({ width: 600, height: 1300 }, { width: 1200, height: 2600 }), "the same shape at another resolution");
  assert.ok(sameBox({ width: 4032, height: 3024 }, { width: 4031, height: 3024 }), "a pixel's difference is not a new shape");
  assert.ok(!sameBox(null, { width: 600, height: 1300 }), "a 4:3 box is not a tall picture's");
  assert.ok(sameBox(null, { width: 400, height: 300 }), "but it is a 4:3 picture's");
  assert.ok(sameBox({ width: 600, height: 1300 }, { width: 75, height: 163 }), "nor is the smaller copy a phone decoded");
  assert.ok(!sameBox({ width: 4032, height: 3024 }, { width: 3024, height: 4032 }));
  assert.ok(!sameBox({ width: 800, height: 800 }, { width: 800, height: 760 }));
});

test("the conversation draws a picture's box from its size, and holds the spinner back like the other loaders", () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
  const pictures = read("components/Attachments.tsx");
  assert.match(pictures, /useState\(\(\) => sizeFor\(file\)\)/, "the box is decided before the first frame, from the server's size or the remembered one");
  assert.match(pictures, /const box = tiled \? null : pictureBox\(size\);/, "one picture: its own shape; several: square tiles as before");
  assert.match(pictures, /rememberSize\(file\.id, loaded\)/, "a loaded picture's size is kept for next time");
  // In a browser the box that is on screen is left alone: reshaping it there would be a jump it never had.
  assert.match(pictures, /if \(Platform\.OS !== "web" && !sameBox\(size, loaded\)\) setSize\(loaded\)/);
  assert.match(pictures, /pictureSize\(Platform\.OS === "web" \? browserPictureSize\(picture\.current\) : event\.nativeEvent\.source\)/, "a phone says the size in its load event; in a browser the picture on the page does");
  assert.match(pictures, /querySelector\?\.\("img"\)/);
  assert.match(pictures, /Animated\.timing\(shown, \{ toValue: 1, duration: LOADER_FADE_MS, delay: LOADER_DELAY_MS,/, "the spinner waits a quarter of a second");
  // Its place is held from the first frame, and the name is on the view around it, so a screen reader hears it at once.
  assert.match(pictures, /<View accessible accessibilityRole="progressbar" accessibilityLabel="Loading image" accessibilityState=\{\{ busy: true \}\}>\n\s+<Animated\.View style=\{\{ opacity: shown \}\} \{\.\.\.drawingOnly\}><ActivityIndicator color=\{colors\.blue\} \/><\/Animated\.View>/);
  // A picture whose bytes are already here is drawn at once, with no spinner at all.
  const gallery = read("components/MediaGallery.tsx");
  assert.match(gallery, /const held = enabled \? gallery\?\.peek\(id\) : undefined;/);
  assert.match(gallery, /useState<\{ key: string; data\?: string; error\?: string \} \| null>\(\(\) => held === undefined \? null : \{ key: `\$\{id\}:0`, data: held \}\)/);
  // The size goes up with a picture the app has measured, and the box of one being sent has its shape too.
  assert.match(read("lib/server.ts"), /export type Attachment = \{ id: string; name: string; mime: string; size: number; width\?: number; height\?: number \};/);
  assert.match(pictures, /pictureBox\(pictureSize\(file\)\)/, "a picture being sent");
});
