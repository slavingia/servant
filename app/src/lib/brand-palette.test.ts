// The default palette is the app icon's three colors (docs/design-system.md, "Color"): its navy field, the tennis
// yellow of the ball and white. Navy is every brand surface, yellow is what signals on navy and what can be pressed
// on a dark page, and white is the light page and every label on a fill. Yellow on a white page is 1.27 to 1 and
// white on yellow is the same, so yellow is never a light-mode foreground and never sits under a white label.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.env.SERVANT_SRC ?? path.join(import.meta.dirname, "..");
const theme = await import(path.join(root, "lib/theme-colors.ts"));
const { createColors, darkColors, lightColors, onBrandTint, WORDMARK_COLOR, WORDMARK_ACCENT } = theme;
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const sources = (fs.readdirSync(root, { recursive: true, encoding: "utf8" }) as string[]).filter(file => /\.tsx$/.test(file)).map(file => file.split(path.sep).join("/")).sort();

const luminance = (hex: string) => hex.slice(1).match(/../g)!.map(v => { const c = parseInt(v, 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const whiteOver = (hex: string, alpha: number) => `#${hex.slice(1).match(/../g)!.map(v => Math.round(parseInt(v, 16) * (1 - alpha) + 255 * alpha).toString(16).padStart(2, "0")).join("")}`;
const alpha = (rgba: string) => Number(rgba.match(/,([\d.]+)\)$/)![1]);

test("one navy is the icon's field, the wordmark band and every brand surface, and yellow is its accent", () => {
  assert.equal(lightColors.navy, WORDMARK_COLOR, "the sidebar and the Welcome band are the same navy");
  assert.equal(darkColors.navy, lightColors.navy);
  assert.equal(WORDMARK_ACCENT, lightColors.gold, "the bar under the wordmark is the ball's yellow");
  assert.equal(darkColors.gold, lightColors.gold);
  assert.equal(lightColors.onBrandAccent, lightColors.gold, "the accent on the brand surface is the same yellow by default");
  assert.ok(contrast(WORDMARK_ACCENT, WORDMARK_COLOR) >= 3, "the bar shows on the band");
  assert.match(read("components/ServantWordmark.tsx"), /fill=\{WORDMARK_ACCENT\}/);
  assert.doesNotMatch(read("components/ServantWordmark.tsx"), /#0071BC/i, "the old icon's blue bar is gone");
});

test("the default sidebar keeps its supporting labels readable on every row state, as a workspace color already must", () => {
  for (const step of [0, alpha(onBrandTint.hover), alpha(onBrandTint.field), alpha(onBrandTint.selected)]) {
    const surface = whiteOver(lightColors.navy, step);
    const ratio = contrast(whiteOver(surface, alpha(onBrandTint.muted)), surface);
    assert.ok(ratio >= 4.5, `72% white on navy with ${step} white is ${ratio.toFixed(2)}`);
  }
});

test("yellow signals on navy and carries a dark label; it is never a light-mode foreground or under a white label", () => {
  for (const [name, colors] of [["light", lightColors], ["dark", darkColors]] as const) {
    assert.ok(contrast(colors.onBrandAccent, colors.navy) >= 4.5, `${name}: the unread count's navy number on the accent, and the accent on navy`);
    assert.ok(contrast("#1B1B1B", colors.gold) >= 4.5, `${name}: the server banner's words`);
  }
  assert.ok(contrast(lightColors.gold, lightColors.background) < 3, "the premise: yellow does not show on a white page");
  assert.ok(contrast("#FFFFFF", lightColors.gold) < 3, "the premise: white does not show on yellow");
  assert.notEqual(lightColors.blue, lightColors.gold, "so the light page's links and icons are not yellow");
  assert.notEqual(lightColors.primary, lightColors.gold, "and a fill under a white label is not yellow");
  // gold is a fill with dark words on it; the accent is drawn only on the brand surface.
  const goldText = sources.filter(file => /\bcolor: colors\.gold\b|color=\{colors\.gold\}/.test(read(file)));
  assert.deepEqual(goldText, [], "gold is never the color of words or an icon");
  const accent = sources.filter(file => /\.onBrandAccent\b/.test(read(file)));
  assert.deepEqual(accent, ["components/DeepWorkSwitch.tsx", "components/Messaging.tsx", "components/Sidebar.tsx"], "the accent is the sidebar's count, the Deep work switch on navy and the agent's mark");
  assert.match(read("components/Sidebar.tsx"), /badge: \{[^{}]*color: theme\.navy, backgroundColor: theme\.onBrandAccent\b/);
  assert.match(read("components/DeepWorkSwitch.tsx"), /<SwitchPicture on=\{deepWork\}[^>]*onColor=\{onNavy \? colors\.onBrandAccent : undefined\} onThumb=\{onNavy \? colors\.navy : undefined\}/, "on navy the switch is yellow with a navy thumb when on: the primary fill is under 3 to 1 there");
  assert.match(read("components/Messaging.tsx"), /color=\{onBrand \? colors\.navy : colors\.onBrandAccent\}/, "the agent's mark on its navy tile");
});

test("a workspace color replaces the accent with a pale tint of itself, so no workspace is given a yellow it did not choose", () => {
  for (const seed of ["#7C3AED", "#0B6E4F", "#E11D48", "#FFCC00", "#000000", "#FFFFFF"]) for (const scheme of ["light", "dark"] as const) {
    const colors = createColors(scheme, seed);
    assert.notEqual(colors.onBrandAccent, lightColors.onBrandAccent, `${seed} ${scheme}`);
    assert.ok(contrast(colors.onBrandAccent, colors.navy) >= 4.5, `${seed} ${scheme}: ${contrast(colors.onBrandAccent, colors.navy).toFixed(2)}`);
  }
});

test("the filled color shows as a bare mark on the page and on a card in both appearances, and links read on every surface", () => {
  for (const [name, colors] of [["light", lightColors], ["dark", darkColors]] as const) {
    for (const surface of [colors.background, colors.surface, colors.groupedCard]) {
      assert.ok(contrast(colors.primary, surface) >= 3, `${name}: a switch, a ticked box, a radio or the unread rule on ${surface} is ${contrast(colors.primary, surface).toFixed(2)}`);
    }
    for (const surface of [colors.background, colors.surface, colors.subtle, colors.blueSoft]) {
      assert.ok(contrast(colors.blue, surface) >= 4.5, `${name}: a link on ${surface} is ${contrast(colors.blue, surface).toFixed(2)}`);
    }
  }
});
