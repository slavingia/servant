// The wide layout's sidebar is navy in both appearances. Where a browser draws scrollbars that take room (Edge and
// Chrome on Windows), the list's scrollbar was the system's own: a light gray bar down the navy. It is drawn in the
// sidebar's colors instead, and keeps the width the person's system gives it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createColors, onBrandScrollbar, onBrandTint } from "./theme-colors.ts";

const sidebar = fs.readFileSync(path.join(import.meta.dirname, "../components/Sidebar.tsx"), "utf8");

const channels = (hex: string) => hex.slice(1).match(/../g)!.map(value => parseInt(value, 16));
function luminance(rgb: number[]) {
  const [r, g, b] = rgb.map(value => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}
const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

test("the sidebar's list draws its scrollbar in the sidebar's colors in a browser", () => {
  const style = sidebar.match(/\n  scroll:\s*\{([^\n]*)\},\n/)?.[1];
  assert.ok(style, "the list's style is found");
  assert.match(style, /Platform\.OS === "web" \? \{ scrollbarColor: onBrandScrollbar \}/, "scrollbar-color, in a browser only");
  assert.doesNotMatch(sidebar, /scrollbarWidth/, "the bar keeps its width: a thin one is harder to grab with a mouse");
});

test("the scrollbar has no track and a thumb that stands out from any brand color", () => {
  const [thumb, track] = onBrandScrollbar.split(/ (?=[a-z]+$)/);
  assert.equal(track, "transparent", "the sidebar's own color shows where the track is");
  assert.equal(thumb, onBrandTint.muted);
  const alpha = Number(thumb!.match(/rgba\(255,255,255,([\d.]+)\)/)?.[1]);
  assert.ok(alpha > 0 && alpha <= 1, "the thumb is white at a set strength");
  // The default blue and a few colors a server may choose (docs/theme.md): a part of a control needs 3:1.
  for (const primary of [undefined, "#7C3AED", "#0F766E", "#B91C1C", "#111827", "#F59E0B"]) {
    for (const scheme of ["light", "dark"] as const) {
      const navy = channels(createColors(scheme, primary).navy);
      const drawn = navy.map(value => Math.round(value * (1 - alpha) + 255 * alpha));
      const ratio = contrast(drawn, navy);
      assert.ok(ratio >= 3, `${primary ?? "default"} ${scheme}: thumb is ${ratio.toFixed(2)}:1 on the sidebar, needs 3:1`);
    }
  }
});
