import { Platform } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useTheme } from "../lib/theme";

// The message box's send button: a round fill in the primary color, like a filled button, with a white arrow up,
// or a white stop square while the agent replies. Pressed, it is the pressed primary. Off (nothing to send): a
// flat grey circle with a muted arrow.
const hidden = Platform.OS === "web" ? { "aria-hidden": true } as const : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;
const ARROW = "M12 18V6.5 m-5.5 5.5L12 6.5l5.5 5.5";

export function SendBall({ mark, off, pressed, offFill, offInk, size = 34 }: {
  mark: "send" | "stop"; off: boolean; pressed: boolean; offFill: string; offInk: string; size?: number;
}) {
  const { colors } = useTheme();
  const ink = off ? offInk : colors.onPrimary;
  return <Svg width={size} height={size} viewBox="0 0 24 24" {...hidden}>
    <Circle cx={12} cy={12} r={12} fill={off ? offFill : pressed ? colors.primaryPressed : colors.primary} />
    {mark === "stop"
      ? <Rect x={8.2} y={8.2} width={7.6} height={7.6} rx={1} fill={ink} />
      : <Path d={ARROW} stroke={ink} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />}
  </Svg>;
}
