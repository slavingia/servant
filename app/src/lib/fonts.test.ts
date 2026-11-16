// The app's typeface is Allo. Every type role, a screen's header and React Navigation's own text name it; a phone
// build embeds the same faces the browser loads, so a weight or an oblique is never missing on one platform.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const app = path.join(import.meta.dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(app, file), "utf8");
const faces = ["Regular", "Oblique", "Medium", "MediumOblique", "SemiBold", "SemiBoldOblique", "Bold", "BoldOblique"];

test("every type role, header title and navigation font is Allo", () => {
  const theme = read("src/lib/theme.tsx");
  assert.match(read("src/lib/fonts.ts"), /export const APP_FONT = "Allo";/);
  const roles = theme.match(/export const typography = \{([\s\S]*?)\} satisfies/)![1].trim().split("\n");
  assert.ok(roles.length >= 10);
  for (const role of roles) assert.match(role, /^ *\w+: \{ fontFamily: APP_FONT, /, role);
  assert.match(theme, /return \{ fontFamily: role\.fontFamily, fontSize: role\.fontSize, fontWeight: role\.fontWeight \};/);
  for (const weight of ["400", "500", "600", "700"]) assert.match(theme, new RegExp(`\\{ fontFamily: APP_FONT, fontWeight: "${weight}" \\}`));
  assert.match(read("src/app/_layout.tsx"), /fonts: navigationFonts,/);
  assert.match(read("src/app/_layout.tsx"), /useAppFonts\(\);/);
});

test("a phone build embeds the faces the browser loads, and the license ships with them", () => {
  const plugin = JSON.parse(read("app.json")).expo.plugins.find((entry: unknown) => Array.isArray(entry) && entry[0] === "expo-font")[1];
  const files = faces.map(face => `./assets/fonts/Allo-${face}.otf`);
  assert.deepEqual(plugin.ios.fonts, files);
  const [android] = plugin.android.fonts;
  assert.equal(android.fontFamily, "Allo");
  assert.deepEqual(android.fontDefinitions.map((face: { path: string }) => face.path), files);
  assert.deepEqual(android.fontDefinitions.map((face: { weight: number; style?: string }) => `${face.weight}${face.style ?? ""}`), ["400", "400italic", "500", "500italic", "600", "600italic", "700", "700italic"]);
  const web = read("src/lib/fonts.ts");
  for (const face of faces) {
    assert.ok(fs.statSync(path.join(app, `assets/fonts/Allo-${face}.otf`)).size > 10_000, face);
    assert.match(web, new RegExp(`require\\("\\.\\./\\.\\./assets/fonts/Allo-${face}\\.otf"\\)`), face);
  }
  assert.match(read("assets/fonts/OFL.txt"), /SIL Open Font License, Version 1\.1/);
});
