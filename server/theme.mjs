// One workspace primary color, set in config.json and read per request.
// Only opaque hex colors cross the API; absent or malformed values keep blue.
export const DEFAULT_PRIMARY_COLOR = "#0071BC";

export function normalizeTheme(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.primaryColor : undefined;
  const hex = typeof value === "string" ? value.trim().toUpperCase() : "";
  const primaryColor = /^#[0-9A-F]{6}$/.test(hex) ? hex
    : /^#[0-9A-F]{3}$/.test(hex) ? "#" + [...hex.slice(1)].map(c => c + c).join("")
    : DEFAULT_PRIMARY_COLOR;
  return { primaryColor };
}

// The colors of the pages the server renders itself (page-style.mjs): the app's palette in light and dark, with the
// workspace's color. The derivation is app/src/lib/theme-colors.ts createColors, repeated here because the server
// cannot import the app at run time; theme.test.mjs checks the two give the same colors.
const LIGHT = {
  background: "#FFFFFF", surface: "#F7F8FA", subtle: "#EEF1F5", ink: "#1D1C1D", muted: "#5B616B", line: "#E6E7EB", borderStrong: "#8B929B",
  blue: "#4E61D6", blueDark: "#27327A", blueSoft: "#EBEFFC", navy: "#1E265D", onBrandAccent: "#DEEF51", primary: "#4E61D6", onPrimary: "#FFFFFF",
  red: "#D11242", redSoft: "#FDECEF", greenDark: "#1F6E35", greenSoft: "#E7F4EA",
};
const DARK = {
  ...LIGHT, background: "#12161C", surface: "#1B222C", subtle: "#252F3C", ink: "#F0F3F7", muted: "#ADB8C7", line: "#303945", borderStrong: "#748397",
  blue: "#DEEF51", blueDark: "#F3FD8C", blueSoft: "#27327A", red: "#FF8FA5", redSoft: "#3D202B", greenDark: "#79D492", greenSoft: "#1B3A26",
};
const channels = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
const mix = (color, target, amount) => {
  const to = channels(target);
  return `#${channels(color).map((from, i) => Math.round(from + (to[i] - from) * amount).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
};
const luminance = hex => channels(hex).map(value => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function readable(color, backgrounds, toward) {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, toward, step / 100);
    if (backgrounds.every(background => contrast(candidate, background) >= 4.5)) return candidate;
  }
  return toward;
}
function brandSurface(primary) {
  for (let step = 20; step <= 100; step++) {
    const candidate = mix(primary, "#000000", step / 100);
    const selected = mix(candidate, "#FFFFFF", 0.2);
    if (contrast(mix(selected, "#FFFFFF", 0.72), selected) >= 4.5) return candidate;
  }
  return "#000000";
}

export function pageColors(scheme, primaryColor) {
  const base = scheme === "dark" ? DARK : LIGHT;
  const seed = normalizeTheme({ primaryColor }).primaryColor;
  if (seed === DEFAULT_PRIMARY_COLOR) return { ...base };
  const toward = scheme === "dark" ? "#FFFFFF" : "#000000";
  const primary = readable(seed, ["#FFFFFF"], "#000000");
  const blueSoft = mix(seed, base.background, scheme === "dark" ? 0.86 : 0.94);
  const blue = readable(seed, [base.background, base.surface, base.subtle, blueSoft], toward);
  const navy = brandSurface(primary);
  return { ...base, primary, navy, onBrandAccent: mix(navy, "#FFFFFF", 0.88), blue, blueDark: readable(mix(blue, toward, 0.15), [blueSoft], toward), blueSoft };
}
