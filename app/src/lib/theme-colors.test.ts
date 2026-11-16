import assert from "node:assert/strict";
import test from "node:test";
import { createAvatarTones, createColors, DEFAULT_PRIMARY_COLOR, darkAvatarTones, darkColors, lightAvatarTones, lightColors, normalizeTheme, resolveColorScheme } from "./theme-colors.ts";

test("theme config accepts only opaque hex and keeps blue as the default", () => {
  assert.deepEqual(normalizeTheme({ primaryColor: " #a3F " }), { primaryColor: "#AA33FF" });
  assert.deepEqual(normalizeTheme({ primaryColor: "#7c3aed" }), { primaryColor: "#7C3AED" });
  for (const raw of [null, undefined, [], "#7C3AED", {}, { primaryColor: 42 }, { primaryColor: "red" }, { primaryColor: "#12345G" }, { primaryColor: "#1234" }, { primaryColor: "#12345678" }]) {
    assert.deepEqual(normalizeTheme(raw), { primaryColor: DEFAULT_PRIMARY_COLOR });
  }
  assert.equal(createColors("light"), lightColors);
  assert.equal(createColors("dark", "invalid"), darkColors);
  assert.equal(createColors("light", "#0071bc"), lightColors);
});

test("one configured color drives both appearances without changing semantic colors", () => {
  for (const scheme of ["light", "dark"] as const) {
    const base = createColors(scheme);
    const colors = createColors(scheme, "#7C3AED");
    assert.equal(colors.primary, "#7C3AED");
    for (const key of ["navy", "blue", "blueDark", "brandText", "primaryPressed", "blueSoft", "onBrandMuted", "bubbleMine"] as const) assert.notEqual(colors[key], base[key], key);
    for (const key of ["background", "ink", "muted", "green", "greenSoft", "danger", "red", "redSoft", "white", "onPrimary", "onBrand"] as const) assert.equal(colors[key], base[key], key);
    assert.deepEqual(createAvatarTones(scheme, colors)[0], { background: colors.blueSoft, foreground: colors.brandText });
    assert.equal(createColors(scheme), base, "a custom server never mutates the default palette");
  }
});

test("appearance always follows the device and defaults to light when unavailable", () => {
  assert.equal(resolveColorScheme("dark"), "dark");
  assert.equal(resolveColorScheme("light"), "light");
  assert.equal(resolveColorScheme(null), "light");
  assert.equal(resolveColorScheme(undefined), "light");
});

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function assertContrast(foreground: string, background: string, label: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  assert.ok(contrast >= 4.5, `${label}: ${contrast.toFixed(2)}:1 must be at least 4.5:1`);
}

function whiteOverlay(background: string, alpha: number): string {
  return `#${background.slice(1).match(/../g)!.map(hex => Math.round(parseInt(hex, 16) * (1 - alpha) + 255 * alpha).toString(16).padStart(2, "0")).join("")}`;
}

test("both palettes keep text, actions, errors, and avatars readable", () => {
  for (const colors of [lightColors, darkColors]) {
    for (const background of [colors.background, colors.surface, colors.subtle]) {
      assertContrast(colors.ink, background, "body");
      assertContrast(colors.muted, background, "supporting text");
    }
    assertContrast(colors.blue, colors.background, "link");
    assertContrast(colors.blue, colors.blueSoft, "selected option");
    assertContrast(colors.brandText, colors.blueSoft, "brand heading");
    assertContrast(colors.onPrimary, colors.primary, "primary button");
    assertContrast(colors.onPrimary, colors.primaryPressed, "pressed button");
    assertContrast(colors.onBrand, colors.navy, "brand header");
    assertContrast(colors.white, colors.danger, "destructive button");
    assertContrast(colors.red, colors.redSoft, "error");
    // Release stage chips: the status word must read on its tint.
    assertContrast(colors.greenDark, colors.greenSoft, "done chip");
    assertContrast(colors.blueDark, colors.blueSoft, "doing chip");
    assertContrast(colors.red, colors.redSoft, "blocked chip");
    assertContrast(colors.muted, colors.surface, "to do chip");
  }
  for (const tone of [...lightAvatarTones, ...darkAvatarTones]) {
    assertContrast(tone.foreground, tone.background, "avatar initials");
  }
});

test("custom hues, very light colors and very dark colors retain readable action pairs", () => {
  // Sample the full RGB cube, including white/black, saturated and pastel colors.
  const seeds = ["#7C3AED", "#FFF2CD"];
  for (const r of ["00", "33", "66", "99", "CC", "FF"]) {
    for (const g of ["00", "33", "66", "99", "CC", "FF"]) {
      for (const b of ["00", "33", "66", "99", "CC", "FF"]) seeds.push(`#${r}${g}${b}`);
    }
  }
  for (const seed of seeds) {
    for (const scheme of ["light", "dark"] as const) {
      const c = createColors(scheme, seed);
      for (const background of [c.background, c.surface, c.subtle, c.blueSoft]) assertContrast(c.blue, background, `${seed} ${scheme} link`);
      assertContrast(c.blueDark, c.blueSoft, `${seed} selected`);
      assertContrast(c.brandText, c.blueSoft, `${seed} brand text`);
      assertContrast(c.onPrimary, c.primary, `${seed} primary`);
      assertContrast(c.onPrimary, c.primaryPressed, `${seed} pressed`);
      assertContrast(c.onBrand, c.navy, `${seed} brand`);
      assertContrast(c.onBrandMuted, c.navy, `${seed} supporting brand text`);
      for (const alpha of [0, 0.12, 0.2]) {
        const surface = whiteOverlay(c.navy, alpha);
        assertContrast(whiteOverlay(surface, 0.72), surface, `${seed} sidebar supporting label`);
      }
      for (const tone of createAvatarTones(scheme, c)) assertContrast(tone.foreground, tone.background, `${seed} avatar`);
    }
  }
});
