import { Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "../lib/theme";

// Decorative: hidden from screen readers. On the web only aria-hidden reaches the
// DOM (the native-only props become invalid attributes there).
const hiddenIcon = Platform.OS === "web" ? { "aria-hidden": true } as const : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;

const paths = {
  home: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 7v5l3 2",
  chat: "M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 4V5a2 2 0 0 1 2-2Z M7 8h10 M7 12h7",
  sparkles: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z M20 2v4 M18 4h4",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.9",
  user: "M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  plus: "M12 5v14 M5 12h14",
  sort: "M3 6h18 M6 12h12 M10 18h4",
  grip: "M4 9h16 M4 15h16",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 5 7 7-7 7",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Z m5.5 13 5 5",
  hash: "M5 8h15 M4 16h15 M10 3 6 21 M18 3l-4 18",
  archive: "M3 3h18v5H3V3Z M5 8v13h14V8 M10 12h4",
  compose: "M14 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-9 M17 3l4 4 M10 14l1-5 8-8 4 4-8 8-5 1Z",
  close: "m6 6 12 12 M18 6 6 18",
  send: "m3 3 19 9-19 9 4-9-4-9Z M7 12h15",
  image: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M8.5 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z m12.5 8-5-5L5 21",
  paperclip: "m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a7 7 0 0 1 10 10l-9 9",
  smile: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M8 8h.01 M16 8h.01 M7 14a6 6 0 0 0 10 0",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  lock: "M6 10h12a1 1 0 0 1 1 1v9H5v-9a1 1 0 0 1 1-1Z M8 10V6a4 4 0 0 1 8 0v4 M12 14v2",
  arrowLeft: "M20 12H4 m7-7-7 7 7 7",
  check: "m5 12 4 4L19 6",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M5 11a7 7 0 0 0 14 0 M12 18v3",
  stop: "M7 7h10v10H7z",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z",
} as const;

export type AppIconName = keyof typeof paths;

/** Decorative by default; the containing control supplies its accessible name. */
export function AppIcon({ name, size = 20, color, strokeWidth = 1.8 }: {
  name: AppIconName; size?: number; color?: string; strokeWidth?: number;
}) {
  const { colors } = useTheme();
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...hiddenIcon}>
    <Path d={paths[name]} stroke={color ?? colors.ink} strokeWidth={name === "more" ? 4 : strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>;
}
