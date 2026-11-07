import { useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { createThemedStyles, useTheme } from "../lib/theme";
import { tweetEmbedUrl, tweetResizeHeight } from "../lib/tweet-embed";

let NativeWebView: any = null;
if (Platform.OS !== "web") { try { NativeWebView = require("react-native-webview").WebView; } catch { NativeWebView = null; } }

// Twitter's own embed. It reports its height by postMessage once loaded.
const FORWARD = `window.addEventListener('message',function(e){try{window.ReactNativeWebView.postMessage(typeof e.data==='string'?e.data:JSON.stringify(e.data))}catch(_){}});true;`;

export function TweetEmbed({ id }: { id: string }) {
  const styles = useStyles();
  const { scheme } = useTheme();
  const [height, setHeight] = useState(260);
  const uri = tweetEmbedUrl(id, scheme === "dark");
  const resize = (data: unknown) => { const h = tweetResizeHeight(data); if (h) setHeight(h); };
  if (Platform.OS === "web") {
    return <View style={[styles.box, { height }]} testID="tweet-embed">
      <WebFrame uri={uri} onData={resize} />
    </View>;
  }
  if (!NativeWebView) return null;
  return <View style={[styles.box, { height }]} testID="tweet-embed" accessibilityLabel="Embedded post from X">
    <NativeWebView source={{ uri }} style={styles.fill} scrollEnabled={false} setSupportMultipleWindows={false}
      injectedJavaScriptBeforeContentLoaded={FORWARD} onMessage={(e: any) => resize(e.nativeEvent.data)}
      originWhitelist={["https://platform.twitter.com", "https://syndication.twitter.com"]}
      onShouldStartLoadWithRequest={(r: any) => /^https:\/\/(platform|syndication)\.twitter\.com\//.test(r.url)}
      javaScriptEnabled domStorageEnabled />
  </View>;
}

function WebFrame({ uri, onData }: { uri: string; onData: (d: unknown) => void }) {
  const Frame = "iframe" as any;
  // Only Twitter's own frame may resize us.
  return <Frame src={uri} title="Embedded post from X" style={{ border: 0, width: "100%", height: "100%" }}
    sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    ref={(el: any) => {
      if (!el || el.__tweet) return; el.__tweet = true;
      window.addEventListener("message", (e: MessageEvent) => { if (e.source === el.contentWindow && /^(.+\.)?twitter\.com$/.test(new URL(e.origin).hostname)) onData(e.data); });
    }} />;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  box: { width: "100%", maxWidth: 420, borderRadius: 12, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, marginTop: 6, backgroundColor: colors.surface },
  fill: { flex: 1, backgroundColor: "transparent" },
}));
