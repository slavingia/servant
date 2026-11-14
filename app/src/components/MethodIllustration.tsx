import type { ReactElement } from "react";
import { Platform, StyleSheet, View } from "react-native";
import Svg, { Circle, G, Path, Rect, Text as SvgText } from "react-native-svg";
import type { OtherMethodPreset, StudyMethod } from "../lib/research-methods";
import { radius, useTheme } from "../lib/theme";

// Decorative: the method's name and description always sit beside it, so it's
// hidden from screen readers. On the web only aria-hidden reaches the DOM.
const hidden = Platform.OS === "web" ? { "aria-hidden": true } as const : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;

// The app's own sans-serif on the web (SVG text otherwise falls back to a serif); the system font in the apps.
const letterFont = Platform.OS === "web" ? "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif" : undefined;

export type IllustratedMethod = StudyMethod | OtherMethodPreset;

/**
 * A small drawing of what a research method looks like, in the app's own
 * colors (so it follows light and dark mode). Original, generic drawings: no
 * real product, page or person is shown.
 */
export function MethodIllustration({ method, width = 72 }: { method: IllustratedMethod; width?: number }) {
  const { colors } = useTheme();
  const c = {
    page: colors.background,
    edge: colors.borderStrong,
    bar: colors.muted,
    accent: colors.blue,
    soft: colors.blueSoft,
    good: colors.green,
    ink: colors.ink,
  };
  const bar = (x: number, y: number, w: number, h = 3, fill = c.bar, opacity = 0.4) => <Rect x={x} y={y} width={w} height={h} rx={h / 2} fill={fill} opacity={opacity} />;
  const page = (x: number, y: number, w: number, h: number, stroke = c.edge, strokeWidth = 1.25) =>
    <Rect x={x} y={y} width={w} height={h} rx={5} fill={c.page} stroke={stroke} strokeWidth={strokeWidth} />;
  const check = (x: number, y: number) => <G>
    <Circle cx={x} cy={y} r={6.5} fill={c.good} />
    <Path d={`M${x - 3.2} ${y} l2.3 2.4 l4.2 -4.6`} stroke={c.page} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </G>;
  const cursor = (x: number, y: number) =>
    <Path d={`M${x} ${y} l0 12 l3.2 -3.1 l2.4 5 l2.2 -1.1 l-2.4 -4.9 l4.4 -0.2 Z`} fill={c.ink} stroke={c.page} strokeWidth={1} strokeLinejoin="round" />;
  const person = (x: number, y: number, fill: string, scale = 1) => <G>
    <Circle cx={x} cy={y} r={5.5 * scale} fill={fill} />
    <Path d={`M${x - 9 * scale} ${y + 17 * scale} a${9 * scale} ${9 * scale} 0 0 1 ${18 * scale} 0 Z`} fill={fill} />
  </G>;

  const drawings: Record<IllustratedMethod, ReactElement> = {
    // A working prototype: a task, a click, and the success signal.
    prototype: <G>
      {page(8, 8, 104, 64)}
      <Path d="M8 19 H112" stroke={c.edge} strokeWidth={1} />
      {[15, 21, 27].map(x => <Circle key={x} cx={x} cy={13.5} r={1.6} fill={c.bar} opacity={0.6} />)}
      {bar(16, 26, 44, 5)}
      {bar(16, 35, 64)}
      {bar(16, 41, 52)}
      <Rect x={16} y={51} width={34} height={11} rx={3} fill={c.accent} />
      {cursor(42, 56)}
      {check(100, 61)}
    </G>,
    // Randomly assigned: each person gets one of two designs.
    ab_test: <G>
      {person(15, 32, c.accent)}
      <Path d="M26 40 C38 40 38 21 50 21 M26 40 C38 40 38 59 50 59" stroke={c.edge} strokeWidth={1.4} strokeDasharray="3 3" fill="none" />
      <Path d="M46 17.5 l4 3.5 -4 3.5 M46 55.5 l4 3.5 -4 3.5" stroke={c.edge} strokeWidth={1.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {page(52, 8, 60, 26)}
      {page(52, 46, 60, 26)}
      <SvgText x={58} y={25} fontSize={11} fontWeight="700" fontFamily={letterFont} fill={c.ink}>A</SvgText>
      <SvgText x={58} y={63} fontSize={11} fontWeight="700" fontFamily={letterFont} fill={c.ink}>B</SvgText>
      {bar(70, 15, 34)}
      {bar(70, 21, 24)}
      <Rect x={70} y={26} width={16} height={4} rx={2} fill={c.accent} opacity={0.75} />
      {bar(70, 53, 30)}
      <Rect x={70} y={59} width={22} height={7} rx={2} fill={c.accent} opacity={0.75} />
    </G>,
    // Loose cards sorted into named groups.
    card_sort: <G>
      {[[8, 14, -7], [14, 34, 5], [6, 54, -3]].map(([x, y, angle]) => <G key={`${x}-${y}`} transform={`rotate(${angle} ${x + 13} ${y + 5})`}>
        <Rect x={x} y={y} width={26} height={10} rx={2} fill={c.page} stroke={c.edge} strokeWidth={1.25} />
        {bar(x + 4, y + 3.5, 14, 3)}
      </G>)}
      <Path d="M42 40 H54 M50 36 l4 4 -4 4" stroke={c.edge} strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {[60, 88].map((x, column) => <G key={x}>
        <Rect x={x} y={8} width={24} height={64} rx={4} fill={c.soft} stroke={c.accent} strokeWidth={1.25} />
        <Rect x={x + 4} y={13} width={16} height={4} rx={2} fill={c.accent} />
        {(column === 0 ? [23, 35] : [23, 35, 47]).map(y => <G key={y}>
          <Rect x={x + 3} y={y} width={18} height={9} rx={1.5} fill={c.page} stroke={c.edge} strokeWidth={1} />
          {bar(x + 6, y + 3, 10, 3)}
        </G>)}
      </G>)}
    </G>,
    // A text-only menu, with the path to the right place.
    tree_test: <G>
      <Path d="M15 18 V66 M27 42 V66" stroke={c.edge} strokeWidth={1} opacity={0.6} />
      {bar(10, 10, 34, 5, c.ink, 0.7)}
      {bar(22, 22, 40)}
      <Rect x={18} y={31} width={62} height={11} rx={3} fill={c.soft} />
      {bar(22, 34, 34, 5, c.accent, 1)}
      {bar(22, 46, 30)}
      <Rect x={30} y={55} width={60} height={11} rx={3} fill={c.soft} stroke={c.accent} strokeWidth={1.25} />
      {bar(34, 58, 30, 5, c.accent, 1)}
      {bar(34, 70, 24)}
      {check(100, 60)}
    </G>,
    // A screenshot, the target area, and where the first click landed.
    first_click: <G>
      {page(8, 8, 104, 64)}
      {bar(16, 16, 50, 5)}
      <Rect x={16} y={28} width={40} height={36} rx={3} fill={c.bar} opacity={0.15} />
      <Rect x={64} y={28} width={40} height={36} rx={3} fill={c.bar} opacity={0.15} />
      <Rect x={61} y={25} width={46} height={42} rx={4} fill="none" stroke={c.accent} strokeWidth={1.5} strokeDasharray="4 3" />
      <Circle cx={82} cy={45} r={13} fill="none" stroke={c.accent} strokeWidth={1.25} opacity={0.3} />
      <Circle cx={82} cy={45} r={8} fill="none" stroke={c.accent} strokeWidth={1.25} opacity={0.6} />
      <Circle cx={82} cy={45} r={3.5} fill={c.accent} />
      {cursor(84, 47)}
    </G>,
    // Both designs side by side, and one chosen.
    preference: <G>
      {page(8, 6, 48, 52)}
      {page(64, 6, 48, 52, c.accent, 2)}
      {bar(14, 13, 30, 5)}
      <Rect x={14} y={23} width={36} height={16} rx={2} fill={c.bar} opacity={0.15} />
      {bar(14, 44, 28)}
      {bar(70, 13, 24, 5)}
      {bar(70, 23, 36)}
      {bar(70, 29, 30)}
      <Rect x={70} y={37} width={36} height={14} rx={2} fill={c.bar} opacity={0.15} />
      <Circle cx={32} cy={69} r={5} fill={c.page} stroke={c.edge} strokeWidth={1.5} />
      <Circle cx={88} cy={69} r={5} fill={c.page} stroke={c.accent} strokeWidth={1.5} />
      <Circle cx={88} cy={69} r={2.6} fill={c.accent} />
    </G>,
    // Questions with a scale and a written answer.
    survey: <G>
      {page(8, 8, 104, 64)}
      {bar(16, 16, 60, 4, c.ink, 0.6)}
      {[22, 38, 54, 70, 86].map(x => <Circle key={x} cx={x} cy={30} r={4.2} fill={x === 70 ? c.accent : c.page} stroke={x === 70 ? c.accent : c.edge} strokeWidth={1.25} />)}
      {bar(16, 42, 46, 4, c.ink, 0.6)}
      <Rect x={16} y={50} width={88} height={15} rx={2.5} fill={c.page} stroke={c.edge} strokeWidth={1.25} />
      {bar(20, 56, 40)}
    </G>,
    // A video call: the shared prototype, the participant and the facilitator.
    moderated: <G>
      {page(8, 8, 104, 64)}
      <Rect x={14} y={14} width={62} height={52} rx={3} fill={c.soft} />
      {bar(20, 21, 36, 4, c.accent, 0.7)}
      {bar(20, 30, 46)}
      {bar(20, 36, 38)}
      <Rect x={20} y={46} width={24} height={9} rx={2.5} fill={c.accent} />
      {cursor(38, 49)}
      <Rect x={82} y={14} width={24} height={24} rx={3} fill={c.bar} opacity={0.15} />
      <Rect x={82} y={42} width={24} height={24} rx={3} fill={c.bar} opacity={0.15} />
      <G>{person(94, 22, c.accent, 0.62)}</G>
      <G>{person(94, 50, c.edge, 0.62)}</G>
    </G>,
    // A one-on-one conversation.
    interviews: <G>
      {person(20, 48, c.edge)}
      {person(100, 48, c.accent)}
      <Rect x={30} y={10} width={42} height={18} rx={6} fill={c.page} stroke={c.edge} strokeWidth={1.25} />
      <Path d="M36 27.4 L31 35 L44 27.4" fill={c.page} stroke={c.edge} strokeWidth={1.25} strokeLinejoin="round" />
      <Rect x={36.5} y={27} width={8} height={2} fill={c.page} />
      {bar(36, 15, 28)}
      {bar(36, 21, 18)}
      <Rect x={48} y={34} width={42} height={16} rx={6} fill={c.soft} stroke={c.accent} strokeWidth={1.25} />
      <Path d="M84 49.4 L89 56 L76 49.4" fill={c.soft} stroke={c.accent} strokeWidth={1.25} strokeLinejoin="round" />
      <Rect x={75.5} y={48.5} width={8.5} height={2} fill={c.soft} />
      {bar(54, 39, 28, 3, c.accent, 0.6)}
      {bar(54, 44, 18, 3, c.accent, 0.6)}
    </G>,
    // Your own method.
    custom: <G>
      <Rect x={8} y={8} width={104} height={64} rx={6} fill="none" stroke={c.edge} strokeWidth={1.4} strokeDasharray="5 4" />
      <Circle cx={60} cy={40} r={13} fill={c.soft} stroke={c.accent} strokeWidth={1.5} />
      <Path d="M60 33 V47 M53 40 H67" stroke={c.accent} strokeWidth={2} strokeLinecap="round" />
    </G>,
  };

  const height = Math.round(width * 2 / 3);
  return <View {...hidden} style={[styles.frame, { width, height, backgroundColor: colors.surface, borderColor: colors.line }]}>
    <Svg width="100%" height="100%" viewBox="0 0 120 80" {...hidden}>{drawings[method]}</Svg>
  </View>;
}

const styles = StyleSheet.create({
  frame: { borderRadius: radius.md, borderWidth: 1, overflow: "hidden", flexShrink: 0 },
});
