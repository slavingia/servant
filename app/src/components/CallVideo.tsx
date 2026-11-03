import { createElement, useEffect, useRef } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Shows a live camera stream: a <video> element on the web, RTCView on phones. */
export function CallVideo({ stream, mirror, muted, style }: { stream: any; mirror?: boolean; muted?: boolean; style?: StyleProp<ViewStyle> }) {
  if (Platform.OS === "web") return <WebVideo stream={stream} mirror={mirror} muted={muted} style={style} />;
  if (!stream?.toURL) return <View style={style} />;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RTCView } = require("react-native-webrtc");
  return <RTCView streamURL={stream.toURL()} objectFit="cover" mirror={mirror} style={style} />;
}

function WebVideo({ stream, mirror, muted, style }: { stream: any; mirror?: boolean; muted?: boolean; style?: StyleProp<ViewStyle> }) {
  const ref = useRef<any>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) { el.srcObject = stream ?? null; el.play?.().catch(() => {}); }
  }, [stream]);
  return <View style={style}>{createElement("video", {
    ref, autoPlay: true, playsInline: true, muted: !!muted, "aria-hidden": true,
    style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transform: mirror ? "scaleX(-1)" : undefined, background: "#000" },
  })}</View>;
}
