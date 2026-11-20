import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { Platform, useColorScheme, type TextStyle } from "react-native";
import * as SystemUI from "expo-system-ui";
import { APP_FONT } from "./fonts";
import { createAvatarTones, createColors, normalizeTheme, resolveColorScheme, type ColorScheme, type ThemeColors } from "./theme-colors";

export type { ColorScheme, ThemeColors } from "./theme-colors";
export { APP_ICON_COLOR, onBrandTint } from "./theme-colors";

// Shared type, space and shape stay constant across appearances.
// `stack` is the gap between things stacked one above another on a page (the onboarding tour uses it throughout).
export const space = { xxs: 4, xs: 8, sm: 12, md: 16, side: 16, stack: 20, lg: 24, xl: 32, xxl: 48 };
export const radius = { sm: 6, md: 10, lg: 12, xl: 24, pill: 999 };

// A link is always underlined in a browser and the Mac app, where the pointer gives no other sign of one.
// Spread it into any text style that is a link: `link: { ...typography.label, color: colors.blue, ...linkUnderline }`.
export const linkUnderline: TextStyle = Platform.OS === "web" ? { textDecorationLine: "underline" } : {};

export const typography = {
  display: { fontFamily: APP_FONT, fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.5 },
  title: { fontFamily: APP_FONT, fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.3 },
  heading: { fontFamily: APP_FONT, fontSize: 18, lineHeight: 24, fontWeight: "700", letterSpacing: -0.15 },
  workspace: { fontFamily: APP_FONT, fontSize: 20, lineHeight: 26, fontWeight: "700", letterSpacing: -0.2 },
  body: { fontFamily: APP_FONT, fontSize: 15, lineHeight: 22, fontWeight: "400" },
  bodyStrong: { fontFamily: APP_FONT, fontSize: 15, lineHeight: 22, fontWeight: "600" },
  label: { fontFamily: APP_FONT, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  caption: { fontFamily: APP_FONT, fontSize: 13, lineHeight: 18, fontWeight: "400" },
  captionStrong: { fontFamily: APP_FONT, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  meta: { fontFamily: APP_FONT, fontSize: 12, lineHeight: 16, fontWeight: "400" },
} satisfies Record<string, TextStyle>;

/** A screen header's title: the heading role in the wide layout, bodyStrong on a phone. A header takes a size and a weight, not a line height. */
export const headerTitleType = (wide: boolean) => {
  const role = wide ? typography.heading : typography.bodyStrong;
  return { fontFamily: role.fontFamily, fontSize: role.fontSize, fontWeight: role.fontWeight };
};

/** React Navigation's own text (a header's back label, the web stack's titles) in the app's typeface. */
export const navigationFonts = {
  regular: { fontFamily: APP_FONT, fontWeight: "400" },
  medium: { fontFamily: APP_FONT, fontWeight: "500" },
  bold: { fontFamily: APP_FONT, fontWeight: "600" },
  heavy: { fontFamily: APP_FONT, fontWeight: "700" },
} as const;

function createControls(colors: ThemeColors) {
  return {
    input: {
      ...typography.body,
      minHeight: 48,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: radius.md,
      backgroundColor: colors.background,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      color: colors.ink,
    },
    inputMultiline: { minHeight: 120, textAlignVertical: "top" },
    inputFocused: { borderColor: colors.blue },
  } satisfies Record<string, TextStyle>;
}

export type Theme = {
  scheme: ColorScheme;
  colors: ThemeColors;
  controls: ReturnType<typeof createControls>;
  avatarTones: ReturnType<typeof createAvatarTones>;
};

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children, primaryColor }: { children: ReactNode; primaryColor?: unknown }) {
  const scheme = resolveColorScheme(useColorScheme());
  const seed = normalizeTheme({ primaryColor }).primaryColor;
  const theme = useMemo<Theme>(() => {
    const colors = createColors(scheme, seed);
    return { scheme, colors, controls: createControls(colors), avatarTones: createAvatarTones(scheme, colors) };
  }, [scheme, seed]);
  useEffect(() => {
    // Match the native root behind screens and the browser's built-in controls.
    void SystemUI.setBackgroundColorAsync(theme.colors.background).catch(() => undefined);
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.documentElement.style.colorScheme = scheme;
      document.documentElement.style.backgroundColor = theme.colors.background;
    }
  }, [scheme, theme]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme must be used within ThemeProvider");
  return theme;
}

/** Build a style hook once per module; reuse each palette's immutable styles. */
export function createThemedStyles<T>(create: (theme: Theme) => T) {
  // A scheme alone is not a palette: switching servers can change its accent.
  const cache = new WeakMap<Theme, T>();
  return function useThemedStyles(): T {
    const theme = useTheme();
    if (!cache.has(theme)) cache.set(theme, create(theme));
    return cache.get(theme)!;
  };
}
