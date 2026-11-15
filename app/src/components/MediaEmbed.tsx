import { useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { withinPlayer, type MediaEmbed as Embed } from "../lib/media-embed";
import { createThemedStyles, radius, space, typography } from "../lib/theme";
import { Button } from "./Button";

let NativeWebView: any = null;
if (Platform.OS !== "web") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the module is missing on the web and in older builds, so it cannot be a static import
  try { NativeWebView = require("react-native-webview").WebView; } catch { NativeWebView = null; }
}

// A podcast, song or video linked in a message, playable in place (lib/media-embed.ts). Until Play is pressed
// this is a button and nothing has been loaded; pressing it loads that service's own player, which is when
// this device first contacts the service.
export function MediaEmbed({ embed }: { embed: Embed }) {
  const styles = useStyles();
  const [playing, setPlaying] = useState(false);
  if (Platform.OS !== "web" && !NativeWebView) return null;
  if (!playing) return (
    <View style={styles.offer} testID="media-embed-offer">
      <Button kind="secondary" compact label="Play here" accessibilityLabel={`Play here, from ${embed.service}`} onPress={() => setPlaying(true)} />
      <Text style={styles.note}>{embed.service} · Loads the player from {embed.from}</Text>
    </View>
  );
  const size = embed.height ? { height: embed.height } : styles.video;
  const title = `${embed.service} player`;
  if (Platform.OS === "web") {
    const Frame = "iframe" as any;
    return (
      <View style={[styles.box, size]} testID="media-embed">
        <Frame src={embed.url} title={title} style={{ border: 0, width: "100%", height: "100%" }} loading="lazy"
          // The player learns the address of this Servant page's site and nothing more of the page.
          referrerPolicy="strict-origin"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation" />
      </View>
    );
  }
  return (
    <View style={[styles.box, size]} testID="media-embed" accessibilityLabel={title}>
      <NativeWebView source={{ uri: embed.url }} style={styles.fill} scrollEnabled={false} setSupportMultipleWindows={false}
        originWhitelist={[new URL(embed.url).origin]}
        onShouldStartLoadWithRequest={(r: any) => withinPlayer(embed, r.url)}
        allowsInlineMediaPlayback allowsFullscreenVideo javaScriptEnabled domStorageEnabled />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  offer: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, marginTop: space.xs },
  note: { ...typography.caption, color: colors.muted, flexShrink: 1 },
  box: { width: "100%", maxWidth: 560, borderRadius: radius.lg, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, marginTop: space.xs, backgroundColor: colors.surface },
  video: { aspectRatio: 16 / 9 },
  fill: { flex: 1, backgroundColor: "transparent" },
}));
