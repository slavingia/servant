export type ColorScheme = "light" | "dark";

export const DEFAULT_PRIMARY_COLOR = "#0071BC";
export type ThemeConfig = { primaryColor: string };

/** Only opaque hex colors from the server's config are accepted. */
export function normalizeTheme(raw: unknown): ThemeConfig {
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { primaryColor?: unknown }).primaryColor : undefined;
  if (typeof value !== "string") return { primaryColor: DEFAULT_PRIMARY_COLOR };
  const hex = value.trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(hex)) return { primaryColor: hex };
  if (/^#[0-9A-F]{3}$/.test(hex)) return { primaryColor: `#${[...hex.slice(1)].map(c => c + c).join("")}` };
  return { primaryColor: DEFAULT_PRIMARY_COLOR };
}

export function resolveColorScheme(system: string | null | undefined): ColorScheme {
  return system === "dark" ? "dark" : "light";
}

// Action foregrounds and filled buttons have separate roles: a pale blue link
// is readable on a dark surface, while a solid button still needs white text.
export const lightColors = {
  navy: "#004C97",
  blue: "#0071BC",
  blueDark: "#205493",
  brandText: "#004C97",
  primary: "#0071BC",
  primaryPressed: "#205493",
  onPrimary: "#FFFFFF",
  onBrand: "#FFFFFF",
  background: "#FFFFFF",
  ink: "#1D1C1D",
  muted: "#5B616B",
  line: "#E6E7EB",
  borderStrong: "#8B929B",
  surface: "#F7F8FA",
  subtle: "#EEF1F5",
  blueSoft: "#E8F2FC",
  gold: "#FDB81E",
  green: "#2E8540",
  // Done chips: dark green text on a pale green, like red on redSoft.
  greenDark: "#1F6E35",
  greenSoft: "#E7F4EA",
  onBrandMuted: "#DCEBFA",
  white: "#FFFFFF",
  red: "#D11242",
  danger: "#D11242",
  redSoft: "#FDECEF",
  bubbleMine: "#0071BC",
  bubbleAgent: "#F4F7FA",
  // Settings-style grouped screens: the page sits behind, cards sit on top.
  groupedBackground: "#F7F8FA",
  groupedCard: "#FFFFFF",
  // What dims the page behind a dialog, a sheet, a menu and search.
  scrim: "rgba(17,46,81,0.42)",
  // The second series in a chart, beside blue: 3 to 1 or more against the track it sits on.
  series: "#C2571A",
};

export type ThemeColors = typeof lightColors;

// The app icon's navy (app.json): the color behind the icon before its picture loads. It does not follow a
// workspace color.
export const APP_ICON_COLOR = "#112E51";

// White at set strengths on the brand color: the wide layout's sidebar and the phone's header bar, which are the
// same in light and dark. One scale, so a row under the pointer, the open page and the search field are the same
// step wherever they appear. brandSurface below keeps `muted` readable on `selected`.
export const onBrandTint = {
  muted: "rgba(255,255,255,0.72)",
  border: "rgba(255,255,255,0.45)",
  hover: "rgba(255,255,255,0.12)",
  field: "rgba(255,255,255,0.18)",
  selected: "rgba(255,255,255,0.2)",
  pressed: "rgba(255,255,255,0.26)",
  track: "rgba(255,255,255,0.3)",
} as const;

export const darkColors: ThemeColors = {
  ...lightColors,
  blue: "#80C7FF",
  blueDark: "#A6D6FF",
  brandText: "#A6D6FF",
  background: "#12161C",
  ink: "#F0F3F7",
  muted: "#ADB8C7",
  line: "#303945",
  borderStrong: "#748397",
  surface: "#1B222C",
  subtle: "#252F3C",
  blueSoft: "#19344D",
  green: "#79D492",
  greenDark: "#79D492",
  greenSoft: "#1B3A26",
  red: "#FF8FA5",
  redSoft: "#3D202B",
  bubbleAgent: "#1B222C",
  // Same page as every other tab; cards lift one step, never the page.
  groupedBackground: "#12161C",
  groupedCard: "#1B222C",
  // Navy would lighten a dark page; black dims it, so the dialog's surface reads as the nearer one.
  scrim: "rgba(0,0,0,0.6)",
  series: "#E07B39",
};

export const lightAvatarTones = [
  { background: "#E8F2FC", foreground: "#004C97" },
  { background: "#E6EEEB", foreground: "#24634D" },
  { background: "#FFF2CD", foreground: "#6B4E00" },
  { background: "#EEEAF5", foreground: "#584574" },
  { background: "#E9EDF2", foreground: "#3B4B63" },
];

export const darkAvatarTones = [
  { background: "#19344D", foreground: "#A6D6FF" },
  { background: "#203B33", foreground: "#A3D9BF" },
  { background: "#40371D", foreground: "#F4D780" },
  { background: "#342B46", foreground: "#D3BCEF" },
  { background: "#293344", foreground: "#BECCE0" },
];

function channels(hex: string): number[] {
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}

function mix(color: string, target: string, amount: number): string {
  const to = channels(target);
  return `#${channels(color).map((from, i) => Math.round(from + (to[i] - from) * amount).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function luminance(hex: string): number {
  return channels(hex).map(value => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
}

function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Preserve the hue, adjusting toward black/white only as far as readability needs. */
function readable(color: string, backgrounds: string[], toward: string): string {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, toward, step / 100);
    if (backgrounds.every(background => contrast(candidate, background) >= 4.5)) return candidate;
  }
  return toward;
}

function brandSurface(primary: string): string {
  // Sidebar supporting labels are 72% white over brand/hover/selected surfaces.
  for (let step = 20; step <= 100; step++) {
    const candidate = mix(primary, "#000000", step / 100);
    const selected = mix(candidate, "#FFFFFF", 0.2);
    if (contrast(mix(selected, "#FFFFFF", 0.72), selected) >= 4.5) return candidate;
  }
  return "#000000";
}

export function createColors(scheme: ColorScheme, primaryColor?: unknown): ThemeColors {
  const base = scheme === "dark" ? darkColors : lightColors;
  const seed = normalizeTheme({ primaryColor }).primaryColor;
  // Preserve the established blue palette exactly, including on older servers.
  if (seed === DEFAULT_PRIMARY_COLOR) return base;
  const primary = readable(seed, [base.white], "#000000");
  const navy = brandSurface(primary);
  const blueSoft = mix(seed, base.background, scheme === "dark" ? 0.86 : 0.94);
  const blue = readable(seed, [base.background, base.surface, base.subtle, blueSoft], scheme === "dark" ? "#FFFFFF" : "#000000");
  const blueDark = readable(mix(blue, scheme === "dark" ? "#FFFFFF" : "#000000", 0.15), [blueSoft], scheme === "dark" ? "#FFFFFF" : "#000000");
  return {
    ...base,
    primary,
    primaryPressed: mix(primary, "#000000", 0.15),
    navy,
    blue,
    blueDark,
    blueSoft,
    brandText: blueDark,
    onBrandMuted: mix(navy, "#FFFFFF", 0.88),
    bubbleMine: primary,
  };
}

export function createAvatarTones(scheme: ColorScheme, colors: ThemeColors) {
  const tones = scheme === "dark" ? darkAvatarTones : lightAvatarTones;
  return [{ background: colors.blueSoft, foreground: colors.brandText }, ...tones.slice(1)];
}
