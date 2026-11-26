// The icon files the stores and devices are strict about. icon.png is the source; the rest are cut from it by
// scripts/make-icons.py. An iPhone refuses an icon with transparency; Android's adaptive foreground, themed icon
// and status-bar icon are shapes on a clear canvas, so they must have it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { APP_ICON_COLOR } from "./theme-colors.ts";

const app = path.join(import.meta.dirname, "../..");
const config = JSON.parse(fs.readFileSync(path.join(app, "app.json"), "utf8")).expo;

/** Width, height and whether the file carries transparency, from the PNG header. */
function header(file: string) {
  const bytes = fs.readFileSync(path.join(app, file));
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", `${file} is a PNG`);
  const colorType = bytes[25]!;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha: colorType === 4 || colorType === 6 };
}

test("the app icon is 1024 square with no transparency", () => {
  assert.deepEqual(header(config.icon), { width: 1024, height: 1024, alpha: false });
});

test("Android's adaptive icon is a clear foreground and themed shape over an opaque field in the icon's navy", () => {
  const icon = config.android.adaptiveIcon;
  assert.deepEqual(header(icon.foregroundImage), { width: 1024, height: 1024, alpha: true });
  assert.deepEqual(header(icon.monochromeImage), { width: 1024, height: 1024, alpha: true });
  assert.deepEqual(header(icon.backgroundImage), { width: 1024, height: 1024, alpha: false });
  assert.equal(icon.backgroundColor, APP_ICON_COLOR, "the color shown before the picture loads is the icon's navy");
});

test("the status-bar icon is a clear shape and the favicon is square", () => {
  const notifications = config.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === "expo-notifications")[1];
  assert.deepEqual(header(notifications.icon), { width: 96, height: 96, alpha: true });
  const favicon = header(config.web.favicon);
  assert.equal(favicon.width, favicon.height);
});

test("the icon is a white ball whose S is the field's navy, and the app's ball and send button are the primary color: no yellow-green", () => {
  const svg = fs.readFileSync(path.join(app, "assets/icon.svg"), "utf8");
  const stops = (id: string) => [...svg.split(`id="${id}"`)[1]!.split("</radialGradient>")[0]!.matchAll(/stop-color="(#[0-9A-F]{6})"/g)].map(match => match[1]!);
  assert.deepEqual(stops("seam-gradient"), stops("field-gradient"), "the S is drawn in the field's own colors");
  assert.match(svg, /id="seam"[^>]*stroke="url\(#seam-gradient\)"/);
  // White, or a pale cool grey for the ball's shading: red and green never above blue, as they are in a yellow-green.
  for (const hex of stops("ball-gradient")) {
    const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
    assert.ok(r >= 0xE0 && r <= b && g <= b, `${hex} is white or a cool pale grey`);
  }
  for (const file of ["ServeLoader.tsx", "SendBall.tsx", "LiveStatus.tsx"]) {
    const source = fs.readFileSync(path.join(app, "src/components", file), "utf8");
    assert.doesNotMatch(source, /green|SERVANT_BALL/i, `${file} draws nothing in green`);
    if (file !== "LiveStatus.tsx") assert.match(source, /colors\.primary\b[\s\S]*colors\.onPrimary\b|colors\.onPrimary\b[\s\S]*colors\.primary\b/, `${file} is the primary color with onPrimary on it`);
  }
});

test("the seam is two equal arcs through the ball's middle, and the loading ball draws the same one", () => {
  const svg = fs.readFileSync(path.join(app, "assets/icon.svg"), "utf8");
  const seam = svg.match(/id="seam" d="([^"]+)"/)![1]!;
  const arcs = seam.match(/^M([\d.]+) ([\d.]+) A([\d.]+) \3 0 0 0 50 50 A\3 \3 0 0 1 ([\d.]+) ([\d.]+)$/);
  assert.ok(arcs, `${seam} is two arcs of one radius that meet at 50,50`);
  const [x1, y1, r, x2, y2] = arcs.slice(1).map(Number) as [number, number, number, number, number];
  // The ends are opposite each other, a full arc's width from the middle, and past the ball's edge (radius 50).
  assert.ok(Math.abs(x1 + x2 - 100) < 0.01 && Math.abs(y1 + y2 - 100) < 0.01);
  assert.ok(Math.abs(Math.hypot(x1 - 50, y1 - 50) - 2 * r) < 0.01 && 2 * r > 50);
  const loader = fs.readFileSync(path.join(app, "src/components/ServeLoader.tsx"), "utf8");
  assert.equal(loader.match(/const SEAM = "([^"]+)"/)![1], seam);
});
