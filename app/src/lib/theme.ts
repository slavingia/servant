import type { TextStyle } from "react-native";

// Servant's shared visual language. Use semantic roles instead of local sizes
// so screens stay consistent and continue to respect system text scaling.
export const colors = {
  navy: "#112E51",
  blue: "#0071BC",
  blueDark: "#205493",
  ink: "#182B3A",
  muted: "#566574",
  line: "#E0E6EC",
  borderStrong: "#8796A5",
  surface: "#F4F7FA",
  subtle: "#EAF0F5",
  blueSoft: "#EAF4FB",
  white: "#FFFFFF",
  red: "#D11242",
  redSoft: "#FDECEF",
  bubbleMine: "#0071BC",
  bubbleAgent: "#F4F7FA",
};

export const space = { xxs: 4, xs: 8, sm: 12, md: 16, side: 20, lg: 24, xl: 32, xxl: 48 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

export const typography = {
  display: { fontSize: 32, lineHeight: 40, fontWeight: "700", letterSpacing: -0.6 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.4 },
  heading: { fontSize: 20, lineHeight: 28, fontWeight: "600", letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: "600" },
  label: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  caption: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  captionStrong: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
} satisfies Record<string, TextStyle>;

export const controls = {
  input: {
    ...typography.body,
    minHeight: 52,
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
