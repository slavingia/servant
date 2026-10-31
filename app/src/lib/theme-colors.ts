export type ColorScheme = "light" | "dark";

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
  onBrandMuted: "#DCEBFA",
  white: "#FFFFFF",
  red: "#D11242",
  danger: "#D11242",
  redSoft: "#FDECEF",
  bubbleMine: "#0071BC",
  bubbleAgent: "#F4F7FA",
};

export type ThemeColors = typeof lightColors;

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
  red: "#FF8FA5",
  redSoft: "#3D202B",
  bubbleAgent: "#1B222C",
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
