import assert from "node:assert/strict";
import test from "node:test";
import { darkAvatarTones, darkColors, lightAvatarTones, lightColors, resolveColorScheme } from "./theme-colors.ts";

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
