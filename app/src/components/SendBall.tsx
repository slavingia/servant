import { useId } from "react";
import { Platform } from "react-native";
import Svg, { Circle, Defs, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { SERVANT_BALL } from "../lib/theme-colors";

// The message box's send button: a tennis ball (the app icon's yellow-green) with a white arrow up, or a white
// stop square while the agent replies. The white mark sits on a shadow in the seam's groove green, the same
// shading as the ball's seam in the icon and loader, so it reads on the pale ball. Off (nothing to send): a flat
// grey circle with a muted arrow and no shadow.
const hidden = Platform.OS === "web" ? { "aria-hidden": true } as const : { accessible: false, accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const;
const ARROW = "M12 18V6.5 m-5.5 5.5L12 6.5l5.5 5.5";

export function SendBall({ mark, off, pressed, offFill, offInk, size = 34 }: {
  mark: "send" | "stop"; off: boolean; pressed: boolean; offFill: string; offInk: string; size?: number;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  return <Svg width={size} height={size} viewBox="0 0 24 24" {...hidden}>
    {off ? <Circle cx={12} cy={12} r={12} fill={offFill} /> : <>
      <Defs>
        <RadialGradient id={`b${id}`} cx="35%" cy="30%" r="75%">
          <Stop offset="0" stopColor={SERVANT_BALL.mid} />
          <Stop offset="0.6" stopColor={SERVANT_BALL.dark} />
          <Stop offset="1" stopColor={SERVANT_BALL.dark} />
        </RadialGradient>
      </Defs>
      <Circle cx={12} cy={12} r={12} fill={`url(#b${id})`} />
      {pressed ? <Circle cx={12} cy={12} r={12} fill={SERVANT_BALL.seamShadow} fillOpacity={0.18} /> : null}
    </>}
    {mark === "stop" ? <>
      {off ? null : <Rect x={8.8} y={9.1} width={7.6} height={7.6} rx={1} fill={SERVANT_BALL.seamShadow} />}
      <Rect x={8.2} y={8.2} width={7.6} height={7.6} rx={1} fill={off ? offInk : SERVANT_BALL.seam} />
    </> : <>
      {off ? null : <Path d={ARROW} transform="translate(0.6 0.9)" stroke={SERVANT_BALL.seamShadow} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />}
      <Path d={ARROW} stroke={off ? offInk : SERVANT_BALL.seam} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>}
  </Svg>;
}
