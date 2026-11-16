// Colors that sat outside the palette (docs/design-system.md, "Color"). Three different colors dimmed the page
// behind a dialog, a sheet and search, and the navy one lightened a dark page instead of dimming it. Nine strengths
// of white were written out in the sidebar, search, the server switcher and Deep work. The usage chart's second bar
// was an orange of its own that fell under 3 to 1 against its track in dark mode, and its legend named the bars
// "Blue" and "Orange", which is wrong as soon as a workspace sets its own color.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { darkColors, lightColors, onBrandTint, APP_ICON_COLOR } from "./theme-colors.ts";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const sources = (fs.readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
  .filter(file => /\.tsx?$/.test(file) && !/\.test\.ts$/.test(file) && !/^lib\/theme(-colors)?\.tsx?$/.test(file)).sort();

const luminance = (hex: string) => {
  const value = parseInt(hex.slice(1), 16);
  const [r, g, b] = [value >> 16, (value >> 8) & 255, value & 255].map(channel => { const s = channel / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (light! + 0.05) / (dark! + 0.05); };

test("one scrim dims the page behind every dialog, sheet, menu and search", () => {
  assert.equal(lightColors.scrim, "rgba(17,46,81,0.42)");
  assert.equal(darkColors.scrim, "rgba(0,0,0,0.6)", "black dims a dark page; navy would lighten it");
  const users = sources.filter(file => /backgroundColor: colors\.scrim\b/.test(read(file)));
  assert.ok(users.length >= 20, `found ${users.length} scrims`);
  // A backdrop is the scrim, not a translucent black or navy of its own. The call and the photo viewer are dark
  // surfaces of their own and are not backdrops.
  const own = sources.filter(file => /\b(?:overlay|scrim|backdrop|menuOverlay|sheetOverlay)\w*: \{[^{}]*backgroundColor: ["']rgba\(/.test(read(file)));
  assert.deepEqual(own, []);
  for (const file of sources) assert.doesNotMatch(read(file), /rgba\(17,\s*46,\s*81|rgba\(0,\s*0,\s*0,\s*0\.35\)|rgba\(20,\s*30,\s*45/, `${file} dims the page with a color of its own`);
});

test("white on the brand color comes from one scale", () => {
  assert.deepEqual(onBrandTint, { muted: "rgba(255,255,255,0.72)", border: "rgba(255,255,255,0.45)", hover: "rgba(255,255,255,0.12)", field: "rgba(255,255,255,0.18)", selected: "rgba(255,255,255,0.2)", pressed: "rgba(255,255,255,0.26)", track: "rgba(255,255,255,0.3)" });
  for (const file of ["components/Sidebar.tsx", "components/Omnibar.tsx", "components/ServerSwitcher.tsx", "components/DeepWorkSwitch.tsx"]) {
    assert.doesNotMatch(read(file), /rgba\(255,\s*255,\s*255/, `${file} writes out a white of its own`);
    assert.match(read(file), /onBrandTint\./, file);
  }
});

test("the usage chart's second bar is a palette color that shows against its track, and its legend does not name colors", () => {
  for (const [scheme, colors] of [["light", lightColors], ["dark", darkColors]] as const) {
    assert.ok(contrast(colors.series, colors.line) >= 3, `${scheme}: ${contrast(colors.series, colors.line).toFixed(2)} against the track`);
    assert.ok(contrast(colors.series, colors.background) >= 3, `${scheme}: against the page`);
  }
  const board = read("app/leaderboard.tsx");
  assert.match(board, /barUsers: \{ backgroundColor: colors\.series \}/);
  assert.doesNotMatch(board, /#[0-9A-Fa-f]{6}/, "no color of its own");
  assert.doesNotMatch(board, /\b(?:Blue|Orange)\b[^\n]*share/, "a workspace can set its own color, so the legend shows each bar's color beside what it measures");
  assert.match(board, /styles\.swatch[^\n]*Share of tokens/);
  assert.match(board, /styles\.swatch[^\n]*Share of survey comments/);
});

test("Welcome and sign-in open on the page itself: no logo and no band above the title", () => {
  const icon = JSON.parse(read("../app.json")).expo.android.adaptiveIcon.backgroundColor;
  assert.equal(icon.toUpperCase(), APP_ICON_COLOR);
  assert.equal(fs.existsSync(path.join(root, "components/ServantWordmark.tsx")), false);
  for (const file of ["app/welcome.tsx", "components/DesktopSignIn.tsx"]) {
    assert.doesNotMatch(read(file), /<Band\b|ServantWordmark/, `${file} has no logo header`);
    assert.match(read(file), /paddingTop: insets\.top/, `${file} still clears the status bar`);
  }
});
