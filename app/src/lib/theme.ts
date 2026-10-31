import type { TextStyle } from "react-native";

// Servant's shared visual language. Use semantic roles instead of local sizes
// so screens stay consistent and continue to respect system text scaling.
export const colors = {
  navy: "#004C97",
  blue: "#0071BC",
  blueDark: "#205493",
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
  redSoft: "#FDECEF",
  bubbleMine: "#0071BC",
  bubbleAgent: "#F4F7FA",
};

export const space = { xxs: 4, xs: 8, sm: 12, md: 16, side: 16, lg: 24, xl: 32, xxl: 48 };
export const radius = { sm: 6, md: 10, lg: 12, xl: 24, pill: 999 };

export const avatarTones = [
  { background: "#E8F2FC", foreground: "#004C97" },
  { background: "#E6EEEB", foreground: "#24634D" },
  { background: "#FFF2CD", foreground: "#6B4E00" },
  { background: "#EEEAF5", foreground: "#584574" },
  { background: "#E9EDF2", foreground: "#3B4B63" },
] as const;

export const typography = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.5 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.3 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "700", letterSpacing: -0.15 },
  workspace: { fontSize: 20, lineHeight: 26, fontWeight: "700", letterSpacing: -0.2 },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "400" },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: "600" },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "400" },
  captionStrong: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  meta: { fontSize: 12, lineHeight: 16, fontWeight: "400" },
} satisfies Record<string, TextStyle>;

export const controls = {
  input: {
    ...typography.body,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    backgroundColor: colors.white,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    color: colors.ink,
  },
  inputMultiline: { minHeight: 120, textAlignVertical: "top" },
  inputFocused: { borderColor: colors.blue },
} satisfies Record<string, TextStyle>;
