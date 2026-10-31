import { createContext, useContext, useEffect, type ReactNode } from "react";
import { Platform, useColorScheme, type TextStyle } from "react-native";
import * as SystemUI from "expo-system-ui";
import { darkAvatarTones, darkColors, lightAvatarTones, lightColors, resolveColorScheme, type ColorScheme, type ThemeColors } from "./theme-colors";

export type { ColorScheme, ThemeColors } from "./theme-colors";

// Shared type, space and shape stay constant across appearances.
export const space = { xxs: 4, xs: 8, sm: 12, md: 16, side: 16, lg: 24, xl: 32, xxl: 48 };
export const radius = { sm: 6, md: 10, lg: 12, xl: 24, pill: 999 };

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
  avatarTones: typeof lightAvatarTones;
};

const themes: Record<ColorScheme, Theme> = {
  light: { scheme: "light", colors: lightColors, controls: createControls(lightColors), avatarTones: lightAvatarTones },
  dark: { scheme: "dark", colors: darkColors, controls: createControls(darkColors), avatarTones: darkAvatarTones },
};

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = resolveColorScheme(useColorScheme());
  const theme = themes[scheme];
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
  const cache = new Map<ColorScheme, T>();
  return function useThemedStyles(): T {
    const { scheme } = useTheme();
    if (!cache.has(scheme)) cache.set(scheme, create(themes[scheme]));
    return cache.get(scheme)!;
  };
}
