import { Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "../lib/theme";

// Decorative: hidden from screen readers. On the web only aria-hidden reaches the
// DOM (the native-only props become invalid attributes there).
const hiddenIcon = Platform.OS === "web" ? { "aria-hidden": true } as const : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;

const paths = {
  home: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z",
  code: "m8 7-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 7v5l3 2",
  chat: "M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 4V5a2 2 0 0 1 2-2Z M7 8h10 M7 12h7",
  sparkles: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z M20 2v4 M18 4h4",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.9",
  // "People" with a plus where the second person was: the Invite button on the People tab.
  addPerson: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M19 8v6 M16 11h6",
  user: "M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  plus: "M12 5v14 M5 12h14",
  sort: "M3 6h18 M6 12h12 M10 18h4",
  grip: "M4 9h16 M4 15h16",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 5 7 7-7 7",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Z m5.5 13 5 5",
  hash: "M5 8h15 M4 16h15 M10 3 6 21 M18 3l-4 18",
  folder: "M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z",
  // A briefcase: projects in the sidebar, Home and the chat picker.
  project: "M4 7h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2 M3 12h18 M12 11v3",
  archive: "M3 3h18v5H3V3Z M5 8v13h14V8 M10 12h4",
  bookmark: "M6 3h12v18l-6-4-6 4V3Z",
  key: "M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M11 12.5 20 4 M16 8l3 3 M13.5 10.5l2 2",
  // A closed book: the wiki.
  book: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z M5 17a3 3 0 0 1 3-3h11",
  compose: "M14 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-9 M17 3l4 4 M10 14l1-5 8-8 4 4-8 8-5 1Z",
  // A loudspeaker with sound waves: the Speaker chip in a call.
  speaker: "M11 5 6 9H3v6h3l5 4V5Z M15.5 8.5a5 5 0 0 1 0 7 M18.5 5.5a9 9 0 0 1 0 13",
  close: "m6 6 12 12 M18 6 6 18",
  back: "m15 18-6-6 6-6",
  send: "m3 3 19 9-19 9 4-9-4-9Z M7 12h15",
  image: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M8.5 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z m12.5 8-5-5L5 21",
  copy: "M9 9h10v10H9zM5 15V5h10",
  paperclip: "m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a7 7 0 0 1 10 10l-9 9",
  smile: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M8 8h.01 M16 8h.01 M7 14a6 6 0 0 0 10 0",
  // A tray with something waiting in it: the feedback queue.
  inbox: "M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6l2.5-8Z M3 13h5l1.5 3h5L16 13h5",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  lock: "M6 10h12a1 1 0 0 1 1 1v9H5v-9a1 1 0 0 1 1-1Z M8 10V6a4 4 0 0 1 8 0v4 M12 14v2",
  arrowLeft: "M20 12H4 m7-7-7 7 7 7",
  check: "m5 12 4 4L19 6",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M5 11a7 7 0 0 0 14 0 M12 18v3",
  micOff: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 .2 1.1 M15 9.3V6a3 3 0 0 0-5.9-.8 M5 11a7 7 0 0 0 11.5 5.4 M19 11a7 7 0 0 1-.6 2.8 M12 18v3 M3 3l18 18",
  stop: "M7 7h10v10H7z",
  play: "M8 5v14l11-7-11-7Z",
  // A camera with a lens, for calls and the Meetings screen.
  meetings: "M3 8a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z m13 2 5-3v10l-5-3",
  // The same camera with a line through it: your camera is off.
  cameraOff: "M3 8a2 2 0 0 1 2-2h1.5 M14 6a2 2 0 0 1 2 2v2l5-3v10l-2.4-1.4 M16 16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8 M3 3l18 18",
  // A screen with an arrow up out of it: share your screen.
  screenShare: "M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M8 20h8 M12 16v4 M12 13V7 m-3 3 3-3 3 3",
  // A door with an arrow out: leave the call (the call keeps going).
  leave: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z",
  loop: "M17 2l4 4-4 4 M3 11V9a3 3 0 0 1 3-3h15 M7 22l-4-4 4-4 M21 13v2a3 3 0 0 1-3 3H3",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  // A bell with a line through it: a muted conversation.
  bellOff: "M13.7 21a2 2 0 0 1-3.4 0 M18.6 13A17.9 17.9 0 0 1 18 8 M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14 M18 8a6 6 0 0 0-9.3-5 M3 3l18 18",
  moon: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z",
  warning: "M12 3 2 20h20L12 3Z M12 10v4 M12 17h.01",
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
